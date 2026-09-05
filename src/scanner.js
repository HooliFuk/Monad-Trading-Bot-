const { ethers } = require('ethers');
const KuruSdk = require('@kuru-labs/kuru-sdk');
const { PAIRS, SETTINGS, TOKENS } = require('./config');
const KuruMarket = require('./dex/kuruMarket');
const ZeroX = require('./dex/zeroX');
const { sleep } = require('./utils/helpers');
const logger = require('./utils/logger');

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)'
];
const WMON_ABI = [
  'function deposit() payable',
  'function balanceOf(address) view returns (uint256)'
];

class Scanner {
  constructor(provider, signer = null) {
    this.provider = provider;
    this.signer = signer;
    this.kuru = new KuruMarket(provider);
    this.zeroX = new ZeroX(provider);
    this.stats = { trades: 0, failures: 0 };
    this.isTrading = false;
  }

  async _ensureAllowance(tokenAddr, spender, amount) {
    const token = new ethers.Contract(tokenAddr, ERC20_ABI, this.signer);
    const walletAddress = await this.signer.getAddress();
    const allowance = await token.allowance(walletAddress, spender);
    
    if (allowance.lt(amount)) {
      logger.trade(`Approving token ${tokenAddr} for spender ${spender}...`);
      const tx = await token.approve(spender, ethers.constants.MaxUint256);
      await tx.wait();
      logger.success(`Approval confirmed!`);
    }
  }

  async scan() {
    if (this.isTrading) return;
    const size = SETTINGS.maxTradeSize;
    
    for (const pair of PAIRS) {
      try {
        const [kuruQ, zeroXQ] = await Promise.all([
          this.kuru.getQuote(pair.kuruMarket, pair.label),
          this.zeroX.getPrice(pair.tokenIn, pair.tokenOut, size),
        ]);
        
        if (!kuruQ || !zeroXQ) {
          continue;
        }

        const gapA = ((zeroXQ.price - kuruQ.askPrice) / kuruQ.askPrice) * 100;
        const gapB = ((kuruQ.bidPrice - zeroXQ.price) / zeroXQ.price) * 100;

        logger.info(`${pair.label} | Gaps: A:${gapA.toFixed(2)}% B:${gapB.toFixed(2)}%`);

        if (gapA >= SETTINGS.minArbPercent) {
          this.isTrading = true;
          logger.opportunity(`Arb Opportunity (Dir A): ${gapA.toFixed(2)}%`);
          await this._executeDirA(pair, kuruQ, size);
          this.isTrading = false;
          await sleep(15000);
        } else if (gapB >= SETTINGS.minArbPercent) {
          this.isTrading = true;
          logger.opportunity(`Arb Opportunity (Dir B): ${gapB.toFixed(2)}%`);
          await this._executeDirB(pair, kuruQ, size);
          this.isTrading = false;
          await sleep(15000);
        }
      } catch (err) {
        logger.error(`Scan error on ${pair.label}: ${err.message}`);
      }
    }
  }

  async _executeDirA(pair, kuruQ, size) {
    try {
      const wallet = await this.signer.getAddress();
      const usdcToSpend = (size * kuruQ.askPrice).toFixed(6);
      const usdcWei = ethers.utils.parseUnits(usdcToSpend, 6);

      await this._ensureAllowance(pair.tokenOut.address, pair.kuruMarket, usdcWei);

      logger.trade(`Leg 1: Kuru Buy... Spending ${usdcToSpend} USDC`);
      const params = await this.kuru._getParams(pair.kuruMarket);
      const tx = await KuruSdk.IOC.placeMarket(this.signer, pair.kuruMarket, params, {
        approveTokens: false, 
        size: usdcToSpend, 
        isBuy: true,
        minAmountOut: (size * 0.98).toString(),
        isMargin: false, 
        fillOrKill: false,
        txOptions: { value: 0 }
      });
      
      if (tx && tx.hash) {
        logger.info(`Kuru Buy Tx sent: ${tx.hash}`);
        await tx.wait();
      }

      const monBal = await this.provider.getBalance(wallet);
      const gasBuffer = ethers.utils.parseEther("5");
      
      if (monBal.gt(gasBuffer)) {
        const wrapAmt = monBal.sub(gasBuffer);
        logger.trade(`Wrapping ${ethers.utils.formatEther(wrapAmt)} MON...`);
        const wmon = new ethers.Contract(TOKENS.WMON.address, WMON_ABI, this.signer);
        const wrapTx = await wmon.deposit({ value: wrapAmt });
        await wrapTx.wait();
      }

      const wmonToken = new ethers.Contract(TOKENS.WMON.address, ERC20_ABI, this.signer);
      const currentWmon = await wmonToken.balanceOf(wallet);

      if (currentWmon.eq(0)) {
        throw new Error("No WMON balance available to sell on 0x");
      }

      logger.trade(`Leg 2: 0x Sell... Selling ${ethers.utils.formatEther(currentWmon)} WMON`);
      await this.zeroX.executeSwap(pair.tokenIn, pair.tokenOut, ethers.utils.formatEther(currentWmon), this.signer);
      
      this.stats.trades++;
      logger.success(`✅ Cycle Complete | Total Successes: ${this.stats.trades}`);
    } catch (err) { 
      this.stats.failures++;
      logger.error(`Dir A Execution Failed: ${err.message}`); 
    }
  }

  async _executeDirB(pair, kuruQ, size) {
    try {
      const wallet = await this.signer.getAddress();
      const wmon = new ethers.Contract(TOKENS.WMON.address, WMON_ABI, this.signer);
      const monWei = ethers.utils.parseEther(size.toString());

      const currentWmon = await wmon.balanceOf(wallet);
      if (currentWmon.lt(monWei)) {
        const wrapNeeded = monWei.sub(currentWmon);
        const monBal = await this.provider.getBalance(wallet);
        if (monBal.lt(wrapNeeded.add(ethers.utils.parseEther("2")))) {
          throw new Error("Insufficient native MON to wrap for trade.");
        }
        logger.trade(`Wrapping ${ethers.utils.formatEther(wrapNeeded)} MON...`);
        await (await wmon.deposit({ value: wrapNeeded })).wait();
      }

      await this._ensureAllowance(TOKENS.WMON.address, pair.kuruMarket, monWei);
      
      logger.trade(`Leg 1: Kuru Sell... Selling ${size} MON`);
      const params = await this.kuru._getParams(pair.kuruMarket);
      const tx = await KuruSdk.IOC.placeMarket(this.signer, pair.kuruMarket, params, {
        approveTokens: false, 
        size: size.toString(), 
        isBuy: false,
        minAmountOut: (size * kuruQ.bidPrice * 0.98).toFixed(6),
        isMargin: false, 
        fillOrKill: false,
        txOptions: { value: 0 }
      });
      if (tx && tx.hash) {
        logger.info(`Kuru Sell Tx sent: ${tx.hash}`);
        await tx.wait();
      }

      const usdc = new ethers.Contract(pair.tokenOut.address, ERC20_ABI, this.signer);
      const usdcBal = await usdc.balanceOf(wallet);

      if (usdcBal.eq(0)) {
        throw new Error("No USDC received from Kuru for 0x Leg 2");
      }

      logger.trade(`Leg 2: 0x Buy... Swapping ${ethers.utils.formatUnits(usdcBal, 6)} USDC`);
      await this.zeroX.executeSwap(pair.tokenOut, pair.tokenIn, ethers.utils.formatUnits(usdcBal, 6), this.signer);

      this.stats.trades++;
      logger.success(`✅ Cycle Complete | Total Successes: ${this.stats.trades}`);
    } catch (err) { 
      this.stats.failures++;
      logger.error(`Dir B Execution Failed: ${err.message}`); 
    }
  }

  printStats() {
    logger.info(`📊 Bot Metrics | Executed Cycles: ${this.stats.trades} | Failed Cycles: ${this.stats.failures}`);
  }
}

module.exports = Scanner;

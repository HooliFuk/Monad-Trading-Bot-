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
  'function withdraw(uint256 amount)',
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

  async _getExecutableSize() {
    if (!this.signer) return SETTINGS.maxTradeSize;
    try {
      const wallet = await this.signer.getAddress();
      const [nativeBal, wmonToken] = await Promise.all([
        this.provider.getBalance(wallet),
        new ethers.Contract(TOKENS.WMON.address, ERC20_ABI, this.provider).balanceOf(wallet)
      ]);

      const gasReserve = ethers.utils.parseEther("2.0"); // Keep 2 MON for gas
      const totalMonWei = nativeBal.add(wmonToken);
      
      if (totalMonWei.lte(gasReserve)) return 0;

      const availMon = parseFloat(ethers.utils.formatEther(totalMonWei.sub(gasReserve)));
      return Math.min(SETTINGS.maxTradeSize, Math.max(1, parseFloat(availMon.toFixed(2))));
    } catch {
      return SETTINGS.maxTradeSize;
    }
  }

  async _ensureAllowance(tokenAddr, spender, amount) {
    const token = new ethers.Contract(tokenAddr, ERC20_ABI, this.signer);
    const walletAddress = await this.signer.getAddress();
    const allowance = await token.allowance(walletAddress, spender);
    
    if (allowance.lt(amount)) {
      logger.trade(`Approving token ${tokenAddr.slice(0,8)}...`);
      const tx = await token.approve(spender, ethers.constants.MaxUint256);
      await tx.wait();
      logger.success(`Approval confirmed!`);
    }
  }

  async scan() {
    if (this.isTrading) return;

    const size = await this._getExecutableSize();
    if (size <= 0) {
      logger.warn('Insufficient MON balance (must have > 2 MON for gas reserve)');
      return;
    }

    for (const pair of PAIRS) {
      try {
        const [kuruQ, zeroXQ] = await Promise.all([
          this.kuru.getQuote(pair.kuruMarket, pair.label),
          this.zeroX.getPrice(pair.tokenIn, pair.tokenOut, size),
        ]);
        
        if (!kuruQ || !zeroXQ) continue;

        const gapA = ((zeroXQ.price - kuruQ.askPrice) / kuruQ.askPrice) * 100;
        const gapB = ((kuruQ.bidPrice - zeroXQ.price) / zeroXQ.price) * 100;

        logger.info(`${pair.label} [Size: ${size} MON] | Gaps: A:${gapA.toFixed(2)}% B:${gapB.toFixed(2)}%`);

        if (gapA >= SETTINGS.minArbPercent) {
          this.isTrading = true;
          logger.opportunity(`⚡ Arb Found (Dir A: Buy Kuru / Sell 0x): +${gapA.toFixed(2)}%`);
          await this._executeDirA(pair, kuruQ, size);
          this.isTrading = false;
          await sleep(10000);
        } else if (gapB >= SETTINGS.minArbPercent) {
          this.isTrading = true;
          logger.opportunity(`⚡ Arb Found (Dir B: Sell Kuru / Buy 0x): +${gapB.toFixed(2)}%`);
          await this._executeDirB(pair, kuruQ, size);
          this.isTrading = false;
          await sleep(10000);
        }
      } catch (err) {
        logger.error(`Scan error: ${err.message.slice(0, 70)}`);
      }
    }
  }

  async _executeDirA(pair, kuruQ, size) {
    try {
      const wallet = await this.signer.getAddress();
      const usdcToSpend = (size * kuruQ.askPrice).toFixed(6);
      const usdcWei = ethers.utils.parseUnits(usdcToSpend, 6);

      await this._ensureAllowance(pair.tokenOut.address, pair.kuruMarket, usdcWei);

      logger.trade(`[Leg 1] Kuru Market Buy: Spending ${usdcToSpend} USDC...`);
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
        logger.info(`Kuru Tx Hash: ${tx.hash}`);
        await tx.wait();
      }

      // Wrap acquired MON to WMON for 0x Leg 2
      const monBal = await this.provider.getBalance(wallet);
      const gasBuffer = ethers.utils.parseEther("1.5");
      if (monBal.gt(gasBuffer)) {
        const wrapAmt = monBal.sub(gasBuffer);
        const wmon = new ethers.Contract(TOKENS.WMON.address, WMON_ABI, this.signer);
        await (await wmon.deposit({ value: wrapAmt })).wait();
      }

      const wmonToken = new ethers.Contract(TOKENS.WMON.address, ERC20_ABI, this.signer);
      const currentWmon = await wmonToken.balanceOf(wallet);

      if (currentWmon.eq(0)) throw new Error("No WMON received to execute Leg 2");

      logger.trade(`[Leg 2] 0x Sell: Swapping ${ethers.utils.formatEther(currentWmon)} WMON for USDC...`);
      await this.zeroX.executeSwap(pair.tokenIn, pair.tokenOut, ethers.utils.formatEther(currentWmon), this.signer);
      
      this.stats.trades++;
      logger.success(`🎉 Arbitrage Cycle Complete! Success Count: ${this.stats.trades}`);
    } catch (err) { 
      this.stats.failures++;
      logger.error(`Dir A Failed: ${err.message.slice(0, 80)}`); 
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
        logger.trade(`Wrapping ${ethers.utils.formatEther(wrapNeeded)} MON...`);
        await (await wmon.deposit({ value: wrapNeeded })).wait();
      }

      await this._ensureAllowance(TOKENS.WMON.address, pair.kuruMarket, monWei);
      
      logger.trade(`[Leg 1] Kuru Market Sell: Selling ${size} MON...`);
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
        logger.info(`Kuru Tx Hash: ${tx.hash}`);
        await tx.wait();
      }

      const usdc = new ethers.Contract(pair.tokenOut.address, ERC20_ABI, this.signer);
      const usdcBal = await usdc.balanceOf(wallet);

      if (usdcBal.eq(0)) throw new Error("No USDC balance received for Leg 2");

      logger.trade(`[Leg 2] 0x Buy: Swapping ${ethers.utils.formatUnits(usdcBal, 6)} USDC for WMON...`);
      await this.zeroX.executeSwap(pair.tokenOut, pair.tokenIn, ethers.utils.formatUnits(usdcBal, 6), this.signer);

      this.stats.trades++;
      logger.success(`🎉 Arbitrage Cycle Complete! Success Count: ${this.stats.trades}`);
    } catch (err) { 
      this.stats.failures++;
      logger.error(`Dir B Failed: ${err.message.slice(0, 80)}`); 
    }
  }

  printStats() {
    logger.info(`📊 Summary | Cycles Executed: ${this.stats.trades} | Failed: ${this.stats.failures}`);
  }
}

module.exports = Scanner;

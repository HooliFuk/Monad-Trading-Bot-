const { ethers } = require('ethers');
const KuruSdk = require('@kuru-labs/kuru-sdk');
const { PAIRS, SETTINGS, TOKENS } = require('./config');
const KuruMarket = require('./dex/kuruMarket');
const ZeroX = require('./dex/zeroX');
const { sleep } = require('./utils/helpers');
const logger = require('./utils/logger');

const ERC20_ABI = ['function approve(address spender, uint256 amount) returns (bool)', 'function allowance(address owner, address spender) view returns (uint256)', 'function balanceOf(address account) view returns (uint256)'];
const WMON_ABI = ['function deposit() payable', 'function balanceOf(address) view returns (uint256)'];

class Scanner {
  constructor(provider, signer = null) {
    this.provider = provider;
    this.signer = signer;
    this.kuru = new KuruMarket(provider);
    this.zeroX = new ZeroX(provider);
    this.stats = { trades: 0 };
    this.isTrading = false;
  }

  async _ensureAllowance(tokenAddr, spender, amount) {
    const token = new ethers.Contract(tokenAddr, ERC20_ABI, this.signer);
    const allowance = await token.allowance(await this.signer.getAddress(), spender);
    if (allowance.lt(amount)) {
      logger.trade(`Approving token...`);
      await (await token.approve(spender, ethers.constants.MaxUint256)).wait();
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
        if (!kuruQ || !zeroXQ) continue;

        const gapA = ((zeroXQ.price - kuruQ.askPrice) / kuruQ.askPrice) * 100;
        const gapB = ((kuruQ.bidPrice - zeroXQ.price) / zeroXQ.price) * 100;

        logger.info(`${pair.label} | Gaps: A:${gapA.toFixed(2)}% B:${gapB.toFixed(2)}%`);

        if (gapA >= SETTINGS.minArbPercent) {
          this.isTrading = true;
          await this._executeDirA(pair, kuruQ, size);
          this.isTrading = false;
          await sleep(15000); // 15s cooldown to let RPC catch up
        } else if (gapB >= SETTINGS.minArbPercent) {
          this.isTrading = true;
          await this._executeDirB(pair, kuruQ, size);
          this.isTrading = false;
          await sleep(15000); // 15s cooldown to let RPC catch up
        }
      } catch (err) { }
    }
  }

  async _executeDirA(pair, kuruQ, size) {
    try {
      const wallet = await this.signer.getAddress();
      const usdcToSpend = (size * kuruQ.askPrice).toFixed(6);

      await this._ensureAllowance(pair.tokenOut.address, pair.kuruMarket, ethers.utils.parseUnits(usdcToSpend, 6));

      logger.trade(`Leg 1: Kuru Buy...`);
      const params = await this.kuru._getParams(pair.kuruMarket);
      const tx = await KuruSdk.IOC.placeMarket(this.signer, pair.kuruMarket, params, {
        approveTokens: false, size: usdcToSpend, isBuy: true,
        minAmountOut: (size * 0.80).toString(), // 20% slippage safety
        isMargin: false, fillOrKill: false,
        txOptions: { value: 0 } // FORCE VALUE 0
      });
      if (tx && tx.hash) await tx.wait();

      logger.trade(`Wrapping MON...`);
      const wmon = new ethers.Contract(TOKENS.WMON.address, WMON_ABI, this.signer);
      const monBal = await this.provider.getBalance(wallet);
      const wrapAmt = monBal.sub(ethers.utils.parseEther("15")); 
      if (wrapAmt.gt(0)) await (await wmon.deposit({ value: wrapAmt })).wait();

      const currentWmon = await wmon.balanceOf(wallet);
      logger.trade(`Leg 2: 0x Sell...`);
      await this.zeroX.executeSwap(pair.tokenIn, pair.tokenOut, ethers.utils.formatEther(currentWmon), this.signer);
      
      this.stats.trades++;
      logger.success(`✅ Cycle Complete | Total: ${this.stats.trades}`);
    } catch (err) { logger.error(`Dir A Fail: ${err.message.slice(0, 50)}`); }
  }

  async _executeDirB(pair, kuruQ, size) {
    try {
      const wallet = await this.signer.getAddress();
      const wmon = new ethers.Contract(TOKENS.WMON.address, WMON_ABI, this.signer);
      const monWei = ethers.utils.parseEther(size.toString());

      const currentWmon = await wmon.balanceOf(wallet);
      if (currentWmon.lt(monWei)) {
          logger.trade(`Wrapping MON...`);
          await (await wmon.deposit({ value: monWei.sub(currentWmon) })).wait();
      }

      await this._ensureAllowance(TOKENS.WMON.address, pair.kuruMarket, monWei);
      
      logger.trade(`Leg 1: Kuru Sell...`);
      const params = await this.kuru._getParams(pair.kuruMarket);
      const tx = await KuruSdk.IOC.placeMarket(this.signer, pair.kuruMarket, params, {
        approveTokens: false, size: size.toString(), isBuy: false,
        minAmountOut: (size * kuruQ.bidPrice * 0.80).toFixed(6),
        isMargin: false, fillOrKill: false,
        txOptions: { value: 0 } // FORCE VALUE 0
      });
      if (tx && tx.hash) await tx.wait();

      const usdc = new ethers.Contract(pair.tokenOut.address, ERC20_ABI, this.signer);
      const usdcBal = await usdc.balanceOf(wallet);
      logger.trade(`Leg 2: 0x Buy...`);
      await this.zeroX.executeSwap(pair.tokenOut, pair.tokenIn, ethers.utils.formatUnits(usdcBal, 6), this.signer);

      this.stats.trades++;
      logger.success(`✅ Cycle Complete | Total: ${this.stats.trades}`);
    } catch (err) { logger.error(`Dir B Fail: ${err.message.slice(0, 50)}`); }
  }

  printStats() {
    logger.info(`📊 Successful Cycles: ${this.stats.trades}`);
  }
}

module.exports = Scanner;
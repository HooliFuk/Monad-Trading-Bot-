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

  async _normalizeBalances() {
    if (!this.signer) return;
    try {
      const wallet = await this.signer.getAddress();
      const wmon = new ethers.Contract(TOKENS.WMON.address, WMON_ABI, this.signer);
      const wmonBal = await wmon.balanceOf(wallet);
      
      if (wmonBal.gt(ethers.utils.parseEther("0.1"))) {
        logger.trade(`Auto-unwrapping ${ethers.utils.formatEther(wmonBal)} WMON to native MON...`);
        const tx = await wmon.withdraw(wmonBal, { gasLimit: 150000 });
        await tx.wait();
        logger.success(`Unwrapped to native MON!`);
      }
    } catch (err) {
      logger.warn(`Normalize balance error: ${err.message.slice(0, 60)}`);
    }
  }

  async _getExecutableSize() {
    if (!this.signer) return SETTINGS.maxTradeSize;
    try {
      const wallet = await this.signer.getAddress();
      const nativeBal = await this.provider.getBalance(wallet);
      const gasReserve = ethers.utils.parseEther("5.0");
      
      if (nativeBal.lte(gasReserve)) return 0;

      const availMon = parseFloat(ethers.utils.formatEther(nativeBal.sub(gasReserve)));
      return Math.min(SETTINGS.maxTradeSize, Math.max(5, Math.floor(availMon)));
    } catch {
      return SETTINGS.maxTradeSize;
    }
  }

  async scan() {
    if (this.isTrading) return;

    await this._normalizeBalances();
    const size = await this._getExecutableSize();

    if (size < 5) {
      logger.warn('Insufficient MON balance (need > 5 MON for safety reserve)');
      return;
    }

    for (const pair of PAIRS) {
      try {
        const [kuruQ, zeroXQ] = await Promise.all([
          this.kuru.getQuote(pair.kuruMarket, pair.label, size),
          this.zeroX.getPrice(pair.tokenIn, pair.tokenOut, size),
        ]);
        
        if (!kuruQ || !zeroXQ) continue;

        // Spread calculations based on REAL depth quotes
        const gapA = ((zeroXQ.price - kuruQ.askPrice) / kuruQ.askPrice) * 100;
        const gapB = ((kuruQ.bidPrice - zeroXQ.price) / zeroXQ.price) * 100;

        logger.info(`${pair.label} [Size: ${size} MON] | Real Gaps: A:${gapA.toFixed(2)}% B:${gapB.toFixed(2)}%`);

        // Dir A: Sell 0x -> Buy Kuru (Only if guaranteed positive MON)
        if (gapA >= SETTINGS.minArbPercent) {
          const usdcFrom0x = size * zeroXQ.price;
          const monFromKuru = usdcFrom0x / kuruQ.askPrice;
          const expectedNetGain = monFromKuru - size;

          if (expectedNetGain > 0.15) { // Must earn at least +0.15 MON net
            this.isTrading = true;
            logger.opportunity(`⚡ REAL Arb Found (Dir A): Gap +${gapA.toFixed(2)}% | Net: +${expectedNetGain.toFixed(3)} MON`);
            await this._executeDirA(pair, kuruQ, size, monFromKuru);
            this.isTrading = false;
            await sleep(10000);
          }
        } 
        // Dir B: Sell Kuru -> Buy 0x (Only if guaranteed positive MON)
        else if (gapB >= SETTINGS.minArbPercent) {
          const usdcFromKuru = kuruQ.usdcFromSell;
          const monFrom0x = usdcFromKuru / zeroXQ.price;
          const expectedNetGain = monFrom0x - size;

          if (expectedNetGain > 0.15) { // Must earn at least +0.15 MON net
            this.isTrading = true;
            logger.opportunity(`⚡ REAL Arb Found (Dir B): Gap +${gapB.toFixed(2)}% | Net: +${expectedNetGain.toFixed(3)} MON`);
            await this._executeDirB(pair, kuruQ, size, monFrom0x);
            this.isTrading = false;
            await sleep(10000);
          }
        }
      } catch (err) {
        logger.error(`Scan error: ${err.message.slice(0, 70)}`);
      }
    }
  }

  async _executeDirA(pair, kuruQ, size, expectedMonBack) {
    try {
      const wallet = await this.signer.getAddress();
      const wmon = new ethers.Contract(TOKENS.WMON.address, WMON_ABI, this.signer);
      const usdc = new ethers.Contract(pair.tokenOut.address, ERC20_ABI, this.signer);
      const monWei = ethers.utils.parseEther(size.toString());

      logger.trade(`Wrapping ${size} MON to WMON...`);
      await (await wmon.deposit({ value: monWei })).wait();

      const usdcBalBefore = await usdc.balanceOf(wallet);
      logger.trade(`[Leg 1] 0x Sell: Swapping ${size} WMON for USDC...`);
      await this.zeroX.executeSwap(pair.tokenIn, pair.tokenOut, size.toString(), this.signer);
      
      const usdcBalAfter = await usdc.balanceOf(wallet);
      const usdcReceived = usdcBalAfter.sub(usdcBalBefore);
      if (usdcReceived.eq(0)) throw new Error("0x Leg 1 returned 0 USDC");

      const usdcToSpend = ethers.utils.formatUnits(usdcReceived, 6);
      await this._ensureAllowance(pair.tokenOut.address, pair.kuruMarket, usdcReceived);

      logger.trade(`[Leg 2] Kuru Buy: Spending ${usdcToSpend} USDC (Min return: ${size} MON)...`);
      const params = await this.kuru._getParams(pair.kuruMarket);
      const tx = await KuruSdk.IOC.placeMarket(this.signer, pair.kuruMarket, params, {
        approveTokens: false, 
        size: usdcToSpend, 
        isBuy: true,
        minAmountOut: (size * 1.001).toFixed(4), // STRICT: Must receive AT LEAST initial size + 0.1%
        isMargin: false, 
        fillOrKill: true, // Revert if not completely filled at this price
        txOptions: { value: 0 }
      });
      
      if (tx && tx.hash) await tx.wait();

      this.stats.trades++;
      logger.success(`🎉 Profitable Cycle Complete! Trades: ${this.stats.trades}`);
    } catch (err) { 
      this.stats.failures++;
      logger.error(`Dir A Cancelled / Reverted: ${err.message.slice(0, 80)}`); 
    }
  }

  async _executeDirB(pair, kuruQ, size, expectedMonBack) {
    try {
      const wallet = await this.signer.getAddress();
      const usdc = new ethers.Contract(pair.tokenOut.address, ERC20_ABI, this.signer);
      const wmon = new ethers.Contract(TOKENS.WMON.address, WMON_ABI, this.signer);

      const usdcBalBefore = await usdc.balanceOf(wallet);
      logger.trade(`[Leg 1] Kuru Sell: Selling ${size} MON for USDC...`);
      const params = await this.kuru._getParams(pair.kuruMarket);
      const tx = await KuruSdk.IOC.placeMarket(this.signer, pair.kuruMarket, params, {
        approveTokens: false, 
        size: size.toString(), 
        isBuy: false,
        minAmountOut: (kuruQ.usdcFromSell * 0.999).toFixed(6), // Strict fill on Kuru
        isMargin: false, 
        fillOrKill: true
      });
      if (tx && tx.hash) await tx.wait();

      const usdcBalAfter = await usdc.balanceOf(wallet);
      const usdcReceived = usdcBalAfter.sub(usdcBalBefore);
      if (usdcReceived.eq(0)) throw new Error("Kuru Leg 1 returned 0 USDC");

      const usdcToSpend = ethers.utils.formatUnits(usdcReceived, 6);
      logger.trade(`[Leg 2] 0x Buy: Swapping ${usdcToSpend} USDC for WMON...`);
      await this.zeroX.executeSwap(pair.tokenOut, pair.tokenIn, usdcToSpend, this.signer);

      const wmonBal = await wmon.balanceOf(wallet);
      if (wmonBal.gt(0)) {
        logger.trade(`Unwrapping ${ethers.utils.formatEther(wmonBal)} WMON to Native MON...`);
        const unwrapTx = await wmon.withdraw(wmonBal, { gasLimit: 150000 });
        await unwrapTx.wait();
      }

      this.stats.trades++;
      logger.success(`🎉 Profitable Cycle Complete! Trades: ${this.stats.trades}`);
    } catch (err) { 
      this.stats.failures++;
      logger.error(`Dir B Cancelled / Reverted: ${err.message.slice(0, 80)}`); 
    }
  }

  printStats() {
    logger.info(`📊 Summary | Profitable Cycles: ${this.stats.trades} | Reverted/Failed: ${this.stats.failures}`);
  }
}

module.exports = Scanner;

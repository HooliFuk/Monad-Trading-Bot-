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

  // Ensure all capital is in native MON before sizing
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
      const gasReserve = ethers.utils.parseEther("3.0"); // Keep 3 MON for gas
      
      if (nativeBal.lte(gasReserve)) return 0;

      const availMon = parseFloat(ethers.utils.formatEther(nativeBal.sub(gasReserve)));
      return Math.min(SETTINGS.maxTradeSize, Math.max(1, Math.floor(availMon)));
    } catch {
      return SETTINGS.maxTradeSize;
    }
  }

  async scan() {
    if (this.isTrading) return;

    await this._normalizeBalances();
    const size = await this._getExecutableSize();

    if (size <= 0) {
      logger.warn('Insufficient MON balance for trading (need > 3 MON for gas reserve)');
      return;
    }

    for (const pair of PAIRS) {
      try {
        const [kuruQ, zeroXQ] = await Promise.all([
          this.kuru.getQuote(pair.kuruMarket, pair.label),
          this.zeroX.getPrice(pair.tokenIn, pair.tokenOut, size),
        ]);
        
        if (!kuruQ || !zeroXQ) continue;

        // Gap A: 0x Price > Kuru Price -> Sell on 0x, Buy on Kuru
        const gapA = ((zeroXQ.price - kuruQ.askPrice) / kuruQ.askPrice) * 100;
        // Gap B: Kuru Price > 0x Price -> Sell on Kuru, Buy on 0x
        const gapB = ((kuruQ.bidPrice - zeroXQ.price) / zeroXQ.price) * 100;

        logger.info(`${pair.label} [Size: ${size} MON] | Gaps: A:${gapA.toFixed(2)}% B:${gapB.toFixed(2)}%`);

        if (gapA >= SETTINGS.minArbPercent) {
          this.isTrading = true;
          logger.opportunity(`⚡ Arb Found (Dir A: Sell 0x / Buy Kuru): +${gapA.toFixed(2)}%`);
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

  // Dir A: Wrap MON -> Sell 0x -> Buy Kuru -> Native MON
  async _executeDirA(pair, kuruQ, size) {
    try {
      const wallet = await this.signer.getAddress();
      const wmon = new ethers.Contract(TOKENS.WMON.address, WMON_ABI, this.signer);
      const usdc = new ethers.Contract(pair.tokenOut.address, ERC20_ABI, this.signer);
      const monWei = ethers.utils.parseEther(size.toString());

      // 1. Wrap exact size to WMON for 0x
      logger.trade(`Wrapping ${size} MON to WMON for 0x...`);
      await (await wmon.deposit({ value: monWei })).wait();

      // 2. Leg 1: Sell WMON on 0x -> Receive USDC
      const usdcBalBefore = await usdc.balanceOf(wallet);
      logger.trade(`[Leg 1] 0x Sell: Swapping ${size} WMON for USDC...`);
      await this.zeroX.executeSwap(pair.tokenIn, pair.tokenOut, size.toString(), this.signer);
      
      const usdcBalAfter = await usdc.balanceOf(wallet);
      const usdcReceived = usdcBalAfter.sub(usdcBalBefore);
      if (usdcReceived.eq(0)) throw new Error("No USDC received from 0x Leg 1");

      const usdcToSpend = ethers.utils.formatUnits(usdcReceived, 6);
      logger.info(`Received ${usdcToSpend} USDC from 0x`);

      // 3. Leg 2: Buy MON on Kuru with USDC
      await this._ensureAllowance(pair.tokenOut.address, pair.kuruMarket, usdcReceived);

      logger.trade(`[Leg 2] Kuru Buy: Spending ${usdcToSpend} USDC for MON...`);
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

      this.stats.trades++;
      logger.success(`🎉 Arbitrage Cycle Complete! Success Count: ${this.stats.trades}`);
    } catch (err) { 
      this.stats.failures++;
      logger.error(`Dir A Failed: ${err.message.slice(0, 80)}`); 
    }
  }

  // Dir B: Sell Native MON on Kuru -> Buy WMON on 0x -> Unwrap WMON
  async _executeDirB(pair, kuruQ, size) {
    try {
      const wallet = await this.signer.getAddress();
      const usdc = new ethers.Contract(pair.tokenOut.address, ERC20_ABI, this.signer);
      const wmon = new ethers.Contract(TOKENS.WMON.address, WMON_ABI, this.signer);

      // 1. Leg 1: Sell Native MON on Kuru (Kuru SDK attaches value automatically)
      const usdcBalBefore = await usdc.balanceOf(wallet);
      logger.trade(`[Leg 1] Kuru Market Sell: Selling ${size} MON for USDC...`);
      const params = await this.kuru._getParams(pair.kuruMarket);
      const tx = await KuruSdk.IOC.placeMarket(this.signer, pair.kuruMarket, params, {
        approveTokens: false, 
        size: size.toString(), 
        isBuy: false,
        minAmountOut: (size * kuruQ.bidPrice * 0.98).toFixed(6),
        isMargin: false, 
        fillOrKill: false
      });
      if (tx && tx.hash) {
        logger.info(`Kuru Tx Hash: ${tx.hash}`);
        await tx.wait();
      }

      const usdcBalAfter = await usdc.balanceOf(wallet);
      const usdcReceived = usdcBalAfter.sub(usdcBalBefore);
      if (usdcReceived.eq(0)) throw new Error("No USDC received from Kuru Leg 1");

      const usdcToSpend = ethers.utils.formatUnits(usdcReceived, 6);
      logger.info(`Received ${usdcToSpend} USDC from Kuru`);

      // 2. Leg 2: Buy WMON on 0x with USDC
      logger.trade(`[Leg 2] 0x Buy: Swapping ${usdcToSpend} USDC for WMON...`);
      await this.zeroX.executeSwap(pair.tokenOut, pair.tokenIn, usdcToSpend, this.signer);

      // 3. Unwrap received WMON back to Native MON
      const wmonBal = await wmon.balanceOf(wallet);
      if (wmonBal.gt(0)) {
        logger.trade(`Unwrapping ${ethers.utils.formatEther(wmonBal)} WMON back to Native MON...`);
        const unwrapTx = await wmon.withdraw(wmonBal, { gasLimit: 150000 });
        await unwrapTx.wait();
      }

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

const { ethers } = require('ethers');
const KuruSdk = require('@kuru-labs/kuru-sdk');
const { PAIRS, SETTINGS, TOKENS, UNISWAP } = require('./config');
const KuruMarket = require('./dex/kuruMarket');
const UniswapV3 = require('./dex/uniswapV3');
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
const UNI_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)'
];

class Scanner {
  constructor(provider, signer = null) {
    this.provider = provider;
    this.signer = signer;
    this.kuru = new KuruMarket(provider);
    this.uni = new UniswapV3(provider);
    this.uniRouter = new ethers.Contract(UNISWAP.router, UNI_ROUTER_ABI, signer);
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
      const usdc = new ethers.Contract(TOKENS.USDC.address, ERC20_ABI, this.signer);
      
      // Auto-swap leftover USDC -> Native MON
      const usdcBal = await usdc.balanceOf(wallet);
      if (usdcBal.gt(ethers.utils.parseUnits("0.5", 6))) {
        logger.trade(`Auto-recovering ${ethers.utils.formatUnits(usdcBal, 6)} USDC to MON via Uniswap V3...`);
        await this._ensureAllowance(TOKENS.USDC.address, UNISWAP.router, usdcBal);
        const swapTx = await this.uniRouter.exactInputSingle({
          tokenIn: TOKENS.USDC.address,
          tokenOut: TOKENS.WMON.address,
          fee: 500,
          recipient: wallet,
          amountIn: usdcBal,
          amountOutMinimum: 0,
          sqrtPriceLimitX96: 0
        }, { gasLimit: 350000 });
        await swapTx.wait();
      }

      // Auto-unwrap leftover WMON -> Native MON
      const wmonBal = await wmon.balanceOf(wallet);
      if (wmonBal.gt(ethers.utils.parseEther("0.1"))) {
        logger.trade(`Auto-unwrapping ${ethers.utils.formatEther(wmonBal)} WMON to Native MON...`);
        const tx = await wmon.withdraw(wmonBal, { gasLimit: 150000 });
        await tx.wait();
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
        const [kuruQ, uniQ] = await Promise.all([
          this.kuru.getQuote(pair.kuruMarket, pair.label, size),
          this.uni.getQuote(pair.tokenIn, pair.tokenOut, size, pair.uniFeeTier),
        ]);
        
        if (!kuruQ || !uniQ) continue;

        const gapA = ((uniQ.price - kuruQ.askPrice) / kuruQ.askPrice) * 100;
        const gapB = ((kuruQ.bidPrice - uniQ.price) / uniQ.price) * 100;

        logger.info(`${pair.label} [Size: ${size} MON] | On-Chain Gaps: A:${gapA.toFixed(2)}% B:${gapB.toFixed(2)}%`);

        // Dir A: Sell Uniswap V3 -> Buy Kuru
        if (gapA >= SETTINGS.minArbPercent) {
          const usdcFromUni = size * uniQ.price;
          const monFromKuru = usdcFromUni / kuruQ.askPrice;
          const expectedGain = monFromKuru - size;

          if (expectedGain > 0.15) {
            this.isTrading = true;
            logger.opportunity(`⚡ On-Chain Arb (Dir A: Sell Uni / Buy Kuru): Gap +${gapA.toFixed(2)}% | Net: +${expectedGain.toFixed(3)} MON`);
            await this._executeDirA(pair, kuruQ, size);
            this.isTrading = false;
            await sleep(10000);
          }
        } 
        // Dir B: Sell Kuru -> Buy Uniswap V3
        else if (gapB >= SETTINGS.minArbPercent) {
          const usdcFromKuru = kuruQ.usdcFromSell;
          const monFromUni = usdcFromKuru / uniQ.price;
          const expectedGain = monFromUni - size;

          if (expectedGain > 0.15) {
            this.isTrading = true;
            logger.opportunity(`⚡ On-Chain Arb (Dir B: Sell Kuru / Buy Uni): Gap +${gapB.toFixed(2)}% | Net: +${expectedGain.toFixed(3)} MON`);
            await this._executeDirB(pair, kuruQ, size);
            this.isTrading = false;
            await sleep(10000);
          }
        }
      } catch (err) {
        logger.error(`Scan error: ${err.message.slice(0, 70)}`);
      }
    }
  }

  async _executeDirA(pair, kuruQ, size) {
    try {
      const wallet = await this.signer.getAddress();
      const wmon = new ethers.Contract(TOKENS.WMON.address, WMON_ABI, this.signer);
      const usdc = new ethers.Contract(pair.tokenOut.address, ERC20_ABI, this.signer);
      const monWei = ethers.utils.parseEther(size.toString());

      // 1. Wrap MON -> WMON
      logger.trade(`Wrapping ${size} MON to WMON...`);
      await (await wmon.deposit({ value: monWei })).wait();

      // 2. Leg 1: Sell WMON on Uniswap V3 Router
      await this._ensureAllowance(TOKENS.WMON.address, UNISWAP.router, monWei);
      const usdcBefore = await usdc.balanceOf(wallet);
      
      logger.trade(`[Leg 1] Uniswap V3 Sell: Swapping ${size} WMON for USDC...`);
      const swapTx = await this.uniRouter.exactInputSingle({
        tokenIn: TOKENS.WMON.address,
        tokenOut: pair.tokenOut.address,
        fee: pair.uniFeeTier,
        recipient: wallet,
        amountIn: monWei,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
      }, { gasLimit: 350000 });
      await swapTx.wait();

      const usdcAfter = await usdc.balanceOf(wallet);
      const usdcReceived = usdcAfter.sub(usdcBefore);
      if (usdcReceived.eq(0)) throw new Error("Uniswap V1 returned 0 USDC");

      const usdcToSpend = ethers.utils.formatUnits(usdcReceived, 6);
      await this._ensureAllowance(pair.tokenOut.address, pair.kuruMarket, usdcReceived);

      // 3. Leg 2: Buy MON on Kuru Order Book
      logger.trade(`[Leg 2] Kuru Buy: Spending ${usdcToSpend} USDC for MON...`);
      const params = await this.kuru._getParams(pair.kuruMarket);
      const tx = await KuruSdk.IOC.placeMarket(this.signer, pair.kuruMarket, params, {
        approveTokens: false, 
        size: usdcToSpend, 
        isBuy: true,
        minAmountOut: (size * 1.001).toFixed(4),
        isMargin: false, 
        fillOrKill: true,
        txOptions: { value: 0 }
      });
      if (tx && tx.hash) await tx.wait();

      this.stats.trades++;
      logger.success(`🎉 100% On-Chain Cycle Complete! Total Successes: ${this.stats.trades}`);
    } catch (err) { 
      this.stats.failures++;
      logger.error(`Dir A Cancelled / Reverted: ${err.message.slice(0, 80)}`); 
    }
  }

  async _executeDirB(pair, kuruQ, size) {
    try {
      const wallet = await this.signer.getAddress();
      const usdc = new ethers.Contract(pair.tokenOut.address, ERC20_ABI, this.signer);
      const wmon = new ethers.Contract(TOKENS.WMON.address, WMON_ABI, this.signer);

      // 1. Leg 1: Sell Native MON on Kuru
      const usdcBefore = await usdc.balanceOf(wallet);
      logger.trade(`[Leg 1] Kuru Sell: Selling ${size} MON for USDC...`);
      const params = await this.kuru._getParams(pair.kuruMarket);
      const tx = await KuruSdk.IOC.placeMarket(this.signer, pair.kuruMarket, params, {
        approveTokens: false, 
        size: size.toString(), 
        isBuy: false,
        minAmountOut: (kuruQ.usdcFromSell * 0.999).toFixed(6),
        isMargin: false, 
        fillOrKill: true
      });
      if (tx && tx.hash) await tx.wait();

      const usdcAfter = await usdc.balanceOf(wallet);
      const usdcReceived = usdcAfter.sub(usdcBefore);
      if (usdcReceived.eq(0)) throw new Error("Kuru returned 0 USDC");

      // 2. Leg 2: Buy WMON on Uniswap V3 Router
      await this._ensureAllowance(pair.tokenOut.address, UNISWAP.router, usdcReceived);
      logger.trade(`[Leg 2] Uniswap V3 Buy: Swapping ${ethers.utils.formatUnits(usdcReceived, 6)} USDC for WMON...`);
      
      const swapTx = await this.uniRouter.exactInputSingle({
        tokenIn: pair.tokenOut.address,
        tokenOut: TOKENS.WMON.address,
        fee: pair.uniFeeTier,
        recipient: wallet,
        amountIn: usdcReceived,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
      }, { gasLimit: 350000 });
      await swapTx.wait();

      // 3. Unwrap WMON -> Native MON
      const wmonBal = await wmon.balanceOf(wallet);
      if (wmonBal.gt(0)) {
        logger.trade(`Unwrapping ${ethers.utils.formatEther(wmonBal)} WMON to Native MON...`);
        const unwrapTx = await wmon.withdraw(wmonBal, { gasLimit: 150000 });
        await unwrapTx.wait();
      }

      this.stats.trades++;
      logger.success(`🎉 100% On-Chain Cycle Complete! Total Successes: ${this.stats.trades}`);
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

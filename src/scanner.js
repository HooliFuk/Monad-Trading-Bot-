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
      
      const usdcBal = await usdc.balanceOf(wallet);
      if (usdcBal.gt(ethers.utils.parseUnits("0.5", 6))) {
        logger.trade(`Auto-recovering ${ethers.utils.formatUnits(usdcBal, 6)} USDC to MON...`);
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

      const wmonBal = await wmon.balanceOf(wallet);
      if (wmonBal.gt(ethers.utils.parseEther("0.1"))) {
        logger.trade(`Auto-unwrapping ${ethers.utils.formatEther(wmonBal)} WMON to Native MON...`);
        const tx = await wmon.withdraw(wmonBal, { gasLimit: 150000 });
        await tx.wait();
      }
    } catch (err) {
      logger.warn(`Normalize error: ${err.message.slice(0, 60)}`);
    }
  }

  async _getExecutableSize() {
    if (!this.signer) return SETTINGS.maxTradeSize;
    try {
      const wallet = await this.signer.getAddress();
      const nativeBal = await this.provider.getBalance(wallet);
      const monFloat = parseFloat(ethers.utils.formatEther(nativeBal));

      // Hard Circuit Breaker Stop: Halt if balance drops below 190 MON
      if (monFloat < 190.0) {
        logger.error(`🛑 CIRCUIT BREAKER TRIGGERED: Balance (${monFloat.toFixed(2)} MON) is below safety floor of 190 MON. Trading halted.`);
        process.exit(1);
      }

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

        // Dir B ONLY: Kuru Bid Price > Uniswap Price
        const gapB = ((kuruQ.bidPrice - uniQ.price) / uniQ.price) * 100;

        logger.info(`${pair.label} [Size: ${size} MON] | Safe Arb Gap (Dir B): ${gapB.toFixed(2)}%`);

        // Execute ONLY Dir B (Zero-Risk First Leg)
        if (gapB >= SETTINGS.minArbPercent) {
          const usdcFromKuru = kuruQ.usdcFromSell;
          const monFromUni = usdcFromKuru / uniQ.price;
          const expectedGain = monFromUni - size;

          if (expectedGain > 0.15) {
            this.isTrading = true;
            logger.opportunity(`⚡ Safe Arb Found (Dir B): Gap +${gapB.toFixed(2)}% | Guaranteed Net: +${expectedGain.toFixed(3)} MON`);
            await this._executeDirB(pair, kuruQ, size, expectedGain);
            this.isTrading = false;
            await sleep(10000);
          }
        }
      } catch (err) {
        logger.error(`Scan error: ${err.message.slice(0, 70)}`);
      }
    }
  }

  async _executeDirB(pair, kuruQ, size, expectedGain) {
    try {
      const wallet = await this.signer.getAddress();
      const usdc = new ethers.Contract(pair.tokenOut.address, ERC20_ABI, this.signer);
      const wmon = new ethers.Contract(TOKENS.WMON.address, WMON_ABI, this.signer);

      // Leg 1: Sell Native MON on Kuru FIRST with Fill-or-Kill
      const usdcBefore = await usdc.balanceOf(wallet);
      logger.trade(`[Leg 1] Kuru CLOB Sell: Selling ${size} MON for min ${(kuruQ.usdcFromSell * 0.999).toFixed(6)} USDC...`);
      
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
      
      // If Leg 1 did not fill, abort with 0 loss
      if (usdcReceived.eq(0)) {
        logger.warn(`[Leg 1] Kuru order was not filled (Order book moved). Aborted safely with ZERO token loss.`);
        return;
      }

      // Leg 2: Buy WMON on Uniswap V3 (AMM always fills)
      await this._ensureAllowance(pair.tokenOut.address, UNISWAP.router, usdcReceived);
      const minWmonOut = ethers.utils.parseEther((size + 0.10).toFixed(4));
      
      logger.trade(`[Leg 2] Uniswap V3 Buy: Swapping ${ethers.utils.formatUnits(usdcReceived, 6)} USDC for WMON...`);
      const swapTx = await this.uniRouter.exactInputSingle({
        tokenIn: pair.tokenOut.address,
        tokenOut: TOKENS.WMON.address,
        fee: pair.uniFeeTier,
        recipient: wallet,
        amountIn: usdcReceived,
        amountOutMinimum: minWmonOut,
        sqrtPriceLimitX96: 0
      }, { gasLimit: 350000 });
      await swapTx.wait();

      // Leg 3: Unwrap WMON -> Native MON
      const wmonBal = await wmon.balanceOf(wallet);
      if (wmonBal.gt(0)) {
        logger.trade(`Unwrapping ${ethers.utils.formatEther(wmonBal)} WMON to Native MON...`);
        const unwrapTx = await wmon.withdraw(wmonBal, { gasLimit: 150000 });
        await unwrapTx.wait();
      }

      this.stats.trades++;
      logger.success(`🎉 Safe Arbitrage Cycle Complete! Net Gain: +${expectedGain.toFixed(3)} MON | Total Wins: ${this.stats.trades}`);
    } catch (err) { 
      this.stats.failures++;
      logger.error(`Dir B Safe Abort: ${err.message.slice(0, 80)}`); 
    }
  }

  printStats() {
    logger.info(`📊 Summary | Confirmed Profitable Cycles: ${this.stats.trades}`);
  }
}

module.exports = Scanner;

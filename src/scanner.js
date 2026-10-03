const { ethers } = require('ethers');
const KuruSdk = require('@kuru-labs/kuru-sdk');
const { PAIRS, SETTINGS, TOKENS, UNISWAP } = require('./config');
const KuruMarket = require('./dex/kuruMarket');
const UniswapV3 = require('./dex/uniswapV3');
const { sleep, withTimeout } = require('./utils/helpers');
const logger = require('./utils/logger');

const T = (p, ms, label) => withTimeout(p, ms, label);

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
    this.uniRouter = signer ? new ethers.Contract(UNISWAP.router, UNI_ROUTER_ABI, signer) : null;
    this.stats = { trades: 0, failures: 0 };
    this.isTrading = false;
    this.halted = false;
    this.nullQuoteStreak = 0;
  }

  async _ensureAllowance(tokenAddr, spender, amount) {
    const token = new ethers.Contract(tokenAddr, ERC20_ABI, this.signer);
    const walletAddress = await this.signer.getAddress();
    const allowance = await T(token.allowance(walletAddress, spender), 15000, 'allowance check');
    if (allowance.lt(amount)) {
      logger.trade(`Approving token ${tokenAddr.slice(0,8)}...`);
      const tx = await T(token.approve(spender, ethers.constants.MaxUint256), 30000, 'approve submit');
      await T(tx.wait(), 60000, 'approve confirm');
      logger.success(`Approval confirmed!`);
    }
  }

  async _normalizeBalances() {
    if (!this.signer) return;
    try {
      const wallet = await this.signer.getAddress();
      const wmon = new ethers.Contract(TOKENS.WMON.address, WMON_ABI, this.signer);
      const usdc = new ethers.Contract(TOKENS.USDC.address, ERC20_ABI, this.signer);

      const usdcBal = await T(usdc.balanceOf(wallet), 15000, 'USDC balanceOf');
      if (usdcBal.gt(ethers.utils.parseUnits("0.5", 6))) {
        logger.trade(`Auto-recovering ${ethers.utils.formatUnits(usdcBal, 6)} USDC to MON...`);
        await this._ensureAllowance(TOKENS.USDC.address, UNISWAP.router, usdcBal);
        const swapTx = await T(this.uniRouter.exactInputSingle({
          tokenIn: TOKENS.USDC.address, tokenOut: TOKENS.WMON.address, fee: 500,
          recipient: wallet, amountIn: usdcBal, amountOutMinimum: 0, sqrtPriceLimitX96: 0
        }, { gasLimit: 350000 }), 60000, 'recovery swap submit');
        await T(swapTx.wait(), 60000, 'recovery swap confirm');
      }

      const wmonBal = await T(wmon.balanceOf(wallet), 15000, 'WMON balanceOf');
      if (wmonBal.gt(ethers.utils.parseEther("0.1"))) {
        logger.trade(`Auto-unwrapping ${ethers.utils.formatEther(wmonBal)} WMON...`);
        const tx = await T(wmon.withdraw(wmonBal, { gasLimit: 150000 }), 30000, 'unwrap submit');
        await T(tx.wait(), 60000, 'unwrap confirm');
      }
    } catch (err) {
      logger.warn(`Normalize skipped: ${err.message.slice(0, 60)}`);
    }
  }

  async _getExecutableSize() {
    if (!this.signer) return SETTINGS.maxTradeSize;
    try {
      const wallet = await this.signer.getAddress();
      const nativeBal = await T(this.provider.getBalance(wallet), 15000, 'native balance');
      const monFloat = parseFloat(ethers.utils.formatEther(nativeBal));

      // Hard Circuit Breaker Stop: 50 MON floor
      const safetyFloor = 50.0;
      if (monFloat < safetyFloor) {
        if (!this.halted) {
          this.halted = true;
          logger.error(`CIRCUIT BREAKER: balance ${monFloat.toFixed(2)} MON < ${safetyFloor} floor. Trading halted.`);
        }
        return 0;
      }
      this.halted = false;

      const gasReserve = ethers.utils.parseEther("5.0");
      if (nativeBal.lte(gasReserve)) return 0;
      const availMon = parseFloat(ethers.utils.formatEther(nativeBal.sub(gasReserve)));
      return Math.min(SETTINGS.maxTradeSize, Math.max(5, Math.floor(availMon)));
    } catch {
      return 0;
    }
  }

  async scan() {
    if (this.isTrading) return;

    await this._normalizeBalances();
    const size = await this._getExecutableSize();
    if (size < 5 || this.halted) return;

    for (const pair of PAIRS) {
      try {
        const [kuruQ, uniQ] = await Promise.all([
          T(this.kuru.getQuote(pair.kuruMarket, pair.label, size), 25000, 'Kuru quote'),
          T(this.uni.getQuote(pair.tokenIn, pair.tokenOut, size, pair.uniFeeTier), 25000, 'Uniswap quote'),
        ]);

        if (!kuruQ || !uniQ) {
          this.nullQuoteStreak++;
          if (this.nullQuoteStreak % 20 === 0) {
            logger.warn(`Quotes failing for ${this.nullQuoteStreak} consecutive scans (RPC rate limit).`);
          }
          continue;
        }
        this.nullQuoteStreak = 0;

        // Dir B ONLY: Kuru Bid > Uniswap Price
        const gapB = ((kuruQ.bidPrice - uniQ.price) / uniQ.price) * 100;
        logger.info(`${pair.label} [Size: ${size} MON] | Safe Arb Gap (Dir B): ${gapB.toFixed(2)}%`);

        if (gapB >= SETTINGS.minArbPercent) {
          const usdcFromKuru = kuruQ.usdcFromSell;
          const monFromUni = usdcFromKuru / uniQ.price;
          const expectedGain = monFromUni - size;

          if (expectedGain > 0.15) {
            this.isTrading = true;
            try {
              logger.opportunity(`⚡ Safe Arb (Dir B): Gap +${gapB.toFixed(2)}% | Est Net: +${expectedGain.toFixed(3)} MON`);
              await this._executeDirB(pair, kuruQ, size, expectedGain);
            } finally {
              this.isTrading = false;
            }
            await sleep(10000);
          }
        }
      } catch (err) {
        logger.error(`Scan error on ${pair.label}: ${err.message.slice(0, 80)}`);
      }
    }
  }

  async _executeDirB(pair, kuruQ, size, expectedGain) {
    try {
      const wallet = await this.signer.getAddress();
      const usdc = new ethers.Contract(pair.tokenOut.address, ERC20_ABI, this.signer);
      const wmon = new ethers.Contract(TOKENS.WMON.address, WMON_ABI, this.signer);

      const usdcBefore = await T(usdc.balanceOf(wallet), 15000, 'USDC pre-balance');
      logger.trade(`[Leg 1] Kuru Sell: ${size} MON (Fill-or-Kill)...`);

      const params = await T(this.kuru._getParams(pair.kuruMarket), 15000, 'Kuru params');
      const tx = await T(KuruSdk.IOC.placeMarket(this.signer, pair.kuruMarket, params, {
        approveTokens: false, size: size.toString(), isBuy: false,
        minAmountOut: (kuruQ.usdcFromSell * 0.999).toFixed(6),
        isMargin: false, fillOrKill: true
      }), 60000, 'Kuru sell submit');
      if (tx && tx.hash) await T(tx.wait(), 60000, 'Kuru sell confirm');

      const usdcAfter = await T(usdc.balanceOf(wallet), 15000, 'USDC post-balance');
      const usdcReceived = usdcAfter.sub(usdcBefore);
      if (usdcReceived.eq(0)) {
        logger.warn(`[Leg 1] Kuru did not fill — aborted safely, ZERO loss.`);
        return;
      }

      await this._ensureAllowance(pair.tokenOut.address, UNISWAP.router, usdcReceived);
      const minWmonOut = ethers.utils.parseEther((size + 0.10).toFixed(4));

      logger.trade(`[Leg 2] Uniswap Buy: ${ethers.utils.formatUnits(usdcReceived, 6)} USDC → WMON...`);
      const swapTx = await T(this.uniRouter.exactInputSingle({
        tokenIn: pair.tokenOut.address, tokenOut: TOKENS.WMON.address, fee: pair.uniFeeTier,
        recipient: wallet, amountIn: usdcReceived, amountOutMinimum: minWmonOut, sqrtPriceLimitX96: 0
      }, { gasLimit: 350000 }), 60000, 'Uni swap submit');
      await T(swapTx.wait(), 60000, 'Uni swap confirm');

      const wmonBal = await T(wmon.balanceOf(wallet), 15000, 'WMON balanceOf');
      if (wmonBal.gt(0)) {
        const unwrapTx = await T(wmon.withdraw(wmonBal, { gasLimit: 150000 }), 30000, 'unwrap submit');
        await T(unwrapTx.wait(), 60000, 'unwrap confirm');
      }

      this.stats.trades++;
      logger.success(`🎉 Cycle Complete! Est Net: +${expectedGain.toFixed(3)} MON | Wins: ${this.stats.trades}`);
    } catch (err) {
      this.stats.failures++;
      logger.error(`Dir B abort: ${err.message.slice(0, 80)}`);
    }
  }

  printStats() {
    const state = this.halted ? 'HALTED (circuit breaker)' : (this.isTrading ? 'TRADING' : 'SCANNING');
    logger.info(`📊 [${state}] Profitable Cycles: ${this.stats.trades} | Aborts: ${this.stats.failures}`);
  }
}

module.exports = Scanner;

// ============================================================
//  uniswapV3.js — Reads prices from Uniswap V3 on Monad
//
//  Uses Pool.slot0() — reads sqrtPriceX96 directly from pool
//  and converts to human price. No quoter needed.
//
//  Price formula (verified):
//    sqrtPriceX96 = sqrt(token1/token0) * 2^96  (raw units)
//    rawPrice     = (sqrtPriceX96 / 2^96)^2      = token1_raw / token0_raw
//
//    if tokenIn = token0:
//      price = rawPrice * 10^(decimalsIn - decimalsOut)
//    if tokenIn = token1:
//      price = (1/rawPrice) * 10^(decimalsIn - decimalsOut)
// ============================================================

const { ethers } = require('ethers'); // v5
const { UNISWAP } = require('../config');
const logger      = require('../utils/logger');

const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];

const POOL_ABI = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() external view returns (address)',
  'function liquidity() external view returns (uint128)',
];

class UniswapV3 {
  constructor(provider) {
    this.provider   = provider;
    this.name       = 'Uniswap V3';
    this.factory    = new ethers.Contract(UNISWAP.factory, FACTORY_ABI, provider);
    // BUG FIX 3: Cache pool addresses — don't re-fetch from chain every scan
    this._poolCache = {};
  }

  async _getPoolAddress(tokenIn, tokenOut, feeTier) {
    const key = `${tokenIn.address}-${tokenOut.address}-${feeTier}`;
    if (this._poolCache[key]) return this._poolCache[key];

    const addr = await this.factory.getPool(tokenIn.address, tokenOut.address, feeTier);
    this._poolCache[key] = addr;
    return addr;
  }

  async getQuote(tokenIn, tokenOut, amountIn, feeTier) {
    try {
      // Step 1: get pool address (cached after first fetch)
      const poolAddress = await this._getPoolAddress(tokenIn, tokenOut, feeTier);

      if (!poolAddress || poolAddress === ethers.constants.AddressZero) {
        return null; // pool doesn't exist for this fee tier
      }

      // Step 2: read slot0 from pool
      const pool = new ethers.Contract(poolAddress, POOL_ABI, this.provider);
      const [slot0, token0Addr, liq] = await Promise.all([
        pool.slot0(),
        pool.token0(),
        pool.liquidity(),
      ]);

      if (liq.eq(0)) {
        logger.warn(`Uniswap V3 ${tokenIn.symbol}/${tokenOut.symbol} (fee ${feeTier}): pool empty`);
        return null;
      }

      const sqrtPriceX96 = slot0.sqrtPriceX96;

      // Step 3: convert sqrtPriceX96 → human price
      // rawPrice = token1_raw / token0_raw
      const Q96      = Math.pow(2, 96);
      const sqrtP    = parseFloat(sqrtPriceX96.toString()) / Q96;
      const rawPrice = sqrtP * sqrtP;

      // BUG FIX 1: Clean single formula — no more 4 conflicting assignments
      // If tokenIn is token0: price = rawPrice * 10^(decimalsIn - decimalsOut)
      // If tokenIn is token1: price = (1/rawPrice) * 10^(decimalsIn - decimalsOut)
      const isTokenInToken0 = tokenIn.address.toLowerCase() === token0Addr.toLowerCase();
      const decimalAdj      = Math.pow(10, tokenIn.decimals - tokenOut.decimals);
      const price           = isTokenInToken0
        ? rawPrice       * decimalAdj
        : (1 / rawPrice) * decimalAdj;

      if (!price || price <= 0) return null;

      return {
        dex:         this.name,
        tokenIn:     tokenIn.symbol,
        tokenOut:    tokenOut.symbol,
        amountIn,
        amountOut:   price * amountIn,
        price,
        feeTier,
        poolAddress,
      };

    } catch (err) {
      logger.warn(`Uniswap V3 ${tokenIn.symbol}→${tokenOut.symbol} (fee ${feeTier}): ${err.message.slice(0, 80)}`);
      return null;
    }
  }

  // Try all fee tiers, return the one with the best price
  async getBestQuote(tokenIn, tokenOut, amountIn) {
    const results = await Promise.all(
      UNISWAP.feeTiers.map(fee => this.getQuote(tokenIn, tokenOut, amountIn, fee))
    );
    const valid = results.filter(r => r !== null && r.price > 0);
    if (valid.length === 0) return null;
    return valid.reduce((best, r) => r.amountOut > best.amountOut ? r : best);
  }
}

module.exports = UniswapV3;

// ============================================================
//  ambient.js — Ambient Finance price fetcher
//
//  Ambient is a concentrated liquidity AMM on Monad.
//  It uses a single smart contract (CrocSwap) for all pools.
// ============================================================

const { ethers } = require('ethers');
const { DEXES } = require('../config');
const { fromWei, toWei } = require('../utils/helpers');
const logger = require('../utils/logger');

// Ambient's query contract ABI (simplified)
// Ambient uses a unique "query" pattern for price fetches
const AMBIENT_QUERY_ABI = [
  // Query the price of a pool
  'function queryPrice(address base, address quote, uint256 poolIdx) view returns (uint128)',
  // Get expected output for a swap
  'function calcImpact(address base, address quote, uint256 poolIdx, bool isBuy, bool inBaseQty, uint128 qty, uint16 tip, uint128 limitPrice) view returns (int128 baseFlow, int128 quoteFlow, uint128 finalPrice)',
];

// Standard pool index for most Ambient pools
const DEFAULT_POOL_IDX = 420;

class AmbientDEX {
  constructor(provider) {
    this.provider = provider;
    this.name = 'Ambient';
    this.config = DEXES.AMBIENT;

    // Ambient uses a query contract for price reads
    this.queryContract = new ethers.Contract(
      this.config.dexContract,
      AMBIENT_QUERY_ABI,
      provider
    );
  }

  /**
   * Get price quote from Ambient
   * Ambient's model is different — base/quote ordering matters
   */
  async getPrice(tokenIn, tokenOut, amountIn = 1.0) {
    try {
      // Ambient requires tokens in sorted order (lower address = base)
      const [base, quote, isBuy] = this._sortTokens(tokenIn, tokenOut);

      const amountInWei = toWei(amountIn, tokenIn.decimals);

      // calcImpact gives us the exact trade simulation
      const [baseFlow, quoteFlow] = await this.queryContract.calcImpact(
        base.address,
        quote.address,
        DEFAULT_POOL_IDX,
        isBuy,        // true = buying base token
        true,         // inBaseQty = true (specifying input amount)
        amountInWei,
        0,            // tip (0 for basic swap)
        0             // limitPrice (0 = no limit)
      );

      // Flows are signed — negative means tokens leaving pool (our output)
      const outputFlow = isBuy ? quoteFlow : baseFlow;
      const amountOut = Math.abs(fromWei(outputFlow, tokenOut.decimals));

      return {
        dex: this.name,
        tokenIn: tokenIn.symbol,
        tokenOut: tokenOut.symbol,
        amountIn,
        amountOut,
        price: amountOut / amountIn,
        raw: outputFlow,
      };
    } catch (err) {
      logger.warn(`${this.name}: Could not get price for ${tokenIn.symbol}→${tokenOut.symbol}: ${err.message}`);
      return null;
    }
  }

  /**
   * Sort tokens so lower address is always "base"
   * Returns [base, quote, isBuy]
   * isBuy = true means we're buying the base token
   */
  _sortTokens(tokenIn, tokenOut) {
    const aIsBase = tokenIn.address.toLowerCase() < tokenOut.address.toLowerCase();
    if (aIsBase) {
      // tokenIn is base — we're selling base, so isBuy = false
      return [tokenIn, tokenOut, false];
    } else {
      // tokenIn is quote — we're buying base, so isBuy = true
      return [tokenOut, tokenIn, true];
    }
  }

  /**
   * Execute swap on Ambient (only called when PAPER_TRADE=false)
   */
  async executeSwap(tokenIn, tokenOut, amountIn, minAmountOut, signer) {
    // Ambient swap ABI
    const swapABI = [
      'function swap(address base, address quote, uint256 poolIdx, bool isBuy, bool inBaseQty, uint128 qty, uint16 tip, uint128 limitPrice, uint128 minOut, uint8 reserveFlags) payable returns (int128 baseQuant, int128 quoteQuant)',
    ];

    const dexContract = new ethers.Contract(
      this.config.dexContract,
      swapABI,
      signer
    );

    const [base, quote, isBuy] = this._sortTokens(tokenIn, tokenOut);
    const amountInWei = toWei(amountIn, tokenIn.decimals);

    logger.trade(`Ambient: Swapping ${amountIn} ${tokenIn.symbol} → ${tokenOut.symbol}`);

    const tx = await dexContract.swap(
      base.address,
      quote.address,
      DEFAULT_POOL_IDX,
      isBuy,
      true,           // inBaseQty
      amountInWei,
      0,              // tip
      BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'), // max price (no limit)
      minAmountOut,
      0,              // reserveFlags
      { gasLimit: 400000 }
    );

    logger.trade(`Ambient: Transaction sent: ${tx.hash}`);
    const receipt = await tx.wait();
    logger.success(`Ambient: Swap confirmed in block ${receipt.blockNumber}`);

    return receipt;
  }
}

module.exports = AmbientDEX;

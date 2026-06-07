// ============================================================
//  kuruSwap.js — Kuru PathFinder + TokenSwap
//
//  Uses pre-defined pool data (no API call needed)
//  Pool addresses sourced from docs.kuru.io/contracts
// ============================================================

const KuruSdk = require('@kuru-labs/kuru-sdk');
const logger  = require('../utils/logger');

// Kuru Flow Router (aggregator entrypoint)
const KURU_ROUTER = '0xb3e6778480b2e488385e8205ea05e20060b813cb';

// Pre-defined pool objects — avoids API call to exchange.kuru.io
// Format: { orderbook, baseToken, quoteToken }
const KURU_POOLS = [
  {
    orderbook:  '0x065c9d28e428a0db40191a54d33d5b7c71a9c394', // MON/USDC market
    baseToken:  '0x0000000000000000000000000000000000000000', // MON (native)
    quoteToken: '0x754704bc059f8c67012fed69bc8a327a5aafb603', // USDC
  },
  {
    orderbook:  '0x131a2e70a5b31a517a74b8c567149bc294470da9', // MON/AUSD market
    baseToken:  '0x0000000000000000000000000000000000000000', // MON (native)
    quoteToken: '0x00000000efe302beaa2b3e6e1b18d08d69a9012a', // AUSD
  },
];

// WMON is just wrapped MON — same pools apply
// PathFinder handles the wrapping internally
const WMON = '0x3bd359c1119da7da1d913d1c4d2b7c461115433a';
const MON  = '0x0000000000000000000000000000000000000000';

class KuruSwap {
  constructor(provider) {
    this.provider = provider;
    this.name     = 'Kuru Swap';
  }

  // Build pool list — include both MON and WMON variants
  _getPools() {
    return [
      ...KURU_POOLS,
      // Add WMON versions of the same pools
      {
        orderbook:  '0x065c9d28e428a0db40191a54d33d5b7c71a9c394',
        baseToken:  WMON,
        quoteToken: '0x754704bc059f8c67012fed69bc8a327a5aafb603',
      },
      {
        orderbook:  '0x131a2e70a5b31a517a74b8c567149bc294470da9',
        baseToken:  WMON,
        quoteToken: '0x00000000efe302beaa2b3e6e1b18d08d69a9012a',
      },
    ];
  }

  // ── GET PRICE ─────────────────────────────────────────────
  async getPrice(tokenIn, tokenOut, amountIn) {
    try {
      const routeOutput = await KuruSdk.PathFinder.findBestPath(
        this.provider,
        tokenIn.address.toLowerCase(),
        tokenOut.address.toLowerCase(),
        amountIn,
        'amountIn',
        undefined,        // no poolFetcher — we pass pools directly
        this._getPools(), // pass pre-defined pools
        undefined         // no estimator contract needed
      );

      if (!routeOutput?.output) return null;

      const amountOut = parseFloat(routeOutput.output.toString());
      const price     = amountOut / amountIn;

      return {
        dex:        this.name,
        tokenIn:    tokenIn.symbol,
        tokenOut:   tokenOut.symbol,
        amountIn,
        amountOut,
        price,
        routeOutput, // cache for execution
      };
    } catch (err) {
      logger.warn(`Kuru Swap price ${tokenIn.symbol}→${tokenOut.symbol}: ${err.message.slice(0,80)}`);
      return null;
    }
  }

  // ── EXECUTE SWAP ──────────────────────────────────────────
  async swap(tokenIn, tokenOut, amountIn, signer, slippagePct = 3) {
    logger.trade(`Kuru Swap: ${amountIn} ${tokenIn.symbol} → ${tokenOut.symbol}`);

    const routeOutput = await KuruSdk.PathFinder.findBestPath(
      this.provider,
      tokenIn.address.toLowerCase(),
      tokenOut.address.toLowerCase(),
      amountIn,
      'amountIn',
      undefined,
      this._getPools(),
      undefined
    );

    if (!routeOutput?.route) {
      throw new Error(`Kuru Swap: No route found for ${tokenIn.symbol}→${tokenOut.symbol}`);
    }

    logger.info(`Kuru Swap: Route found — executing`);

    const receipt = await KuruSdk.TokenSwap.swap(
      signer,
      KURU_ROUTER,
      routeOutput,
      amountIn,
      tokenIn.decimals,
      tokenOut.decimals,
      slippagePct,
      true,           // approveTokens
      (txHash) => { if (txHash) logger.trade(`Kuru Swap tx: ${txHash}`); }
    );

    if (!receipt || receipt.status === 0) {
      throw new Error('Kuru Swap: Transaction reverted');
    }

    logger.success(`Kuru Swap confirmed: ${receipt.transactionHash}`);
    return receipt;
  }
}

module.exports = KuruSwap;

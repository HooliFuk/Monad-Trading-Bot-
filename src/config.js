// ============================================================
//  config.js — 100% VERIFIED addresses from official sources
//
//  Uniswap V3 on Monad:
//    docs: developers.uniswap.org/docs/protocols/v3/deployments/v3-monad-deployments
//  Kuru on Monad
//    docs: docs.kuru.io/contracts/Contract-addresses
//  Network:
//    Chain ID 143 = Monad MAINNET (10143 = testnet)
// ============================================================

require('dotenv').config();

const RPC_URL  = process.env.RPC_URL || 'https://rpc.monad.xyz';
const CHAIN_ID = 143;

// ── TOKENS ───────────────────────────────────────────────────
const TOKENS = {
  MON: {
    address:  '0x0000000000000000000000000000000000000000',
    decimals: 18,
    symbol:   'MON',
    isNative: true,
  },
  WMON: {
    // Confirmed: Uniswap Monad docs + Kuru docs
    address:  '0x3bd359c1119da7da1d913d1c4d2b7c461115433a',
    decimals: 18,
    symbol:   'WMON',
  },
  USDC: {
    // Confirmed: Kuru mainnet docs
    address:  '0x754704bc059f8c67012fed69bc8a327a5aafb603',
    decimals: 6,
    symbol:   'USDC',
  },
  AUSD: {
    // Confirmed: Monad official token list (decimals=6 NOT 18)
    address:  '0x00000000efe302beaa2b3e6e1b18d08d69a9012a',
    decimals: 6,
    symbol:   'AUSD',
  },
};

// ── UNISWAP V3 — VERIFIED from official Uniswap docs ─────────
// Source: developers.uniswap.org/docs/protocols/v3/deployments/v3-monad-deployments
const UNISWAP = {
  factory:   '0x204faca1764b154221e35c0d20abb3c525710498',
  quoterV2:  '0x661e93cca42afacb172121ef892830ca3b70f08d', // ← CORRECTED
  router:    '0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900',
  feeTiers:  [500, 3000, 10000],
};

// ── KURU — VERIFIED from docs.kuru.io ────────────────────────
const KURU = {
  flowEntrypoint: '0xb3e6778480b2e488385e8205ea05e20060b813cb',
  router:         '0xd651346d7c789536ebf06dc72ae3c8502cd695cc',
  marginAccount:  '0x2a68ba1833cdf93fa9da1eebd7f46242ad8e90c5',
  markets: {
    MON_USDC: '0x065c9d28e428a0db40191a54d33d5b7c71a9c394',
    MON_AUSD: '0x131a2e70a5b31a517a74b8c567149bc294470da9',
  },
};

// ── PAIRS TO SCAN ─────────────────────────────────────────────
const PAIRS = [
  {
    label:      'WMON/USDC',
    tokenIn:    TOKENS.WMON,
    tokenOut:   TOKENS.USDC,
    kuruMarket: KURU.markets.MON_USDC,
    uniFeeTier: 500,
    tradeSize:  1,
  },
  {
    label:      'WMON/AUSD',
    tokenIn:    TOKENS.WMON,
    tokenOut:   TOKENS.AUSD,
    kuruMarket: KURU.markets.MON_AUSD,
    uniFeeTier: 500,
    tradeSize:  1,
  },
];

// ── BOT SETTINGS ──────────────────────────────────────────────
const SETTINGS = {
  paperTrade:      process.env.PAPER_TRADE !== 'false',
  minArbPercent:   parseFloat(process.env.MIN_ARB_PERCENT)  || 0.3,
  maxTradeSize:    parseFloat(process.env.MAX_TRADE_SIZE)   || 250,
  scanIntervalMs:  parseInt(process.env.SCAN_INTERVAL_MS)  || 5000,
};

module.exports = { RPC_URL, CHAIN_ID, TOKENS, UNISWAP, KURU, PAIRS, SETTINGS };

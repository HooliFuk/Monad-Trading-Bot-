// ============================================================
//  bot.js — Entry point  |  Run: node src/bot.js
// ============================================================

const { ethers }  = require('ethers');
const { RPC_URL, PAIRS, SETTINGS } = require('./config');
const Scanner     = require('./scanner');
const logger      = require('./utils/logger');
const { sleep }   = require('./utils/helpers');

async function main() {
  logger.banner();

  // ── CONNECT ──────────────────────────────────────────────
  logger.info(`Connecting to Monad: ${RPC_URL}`);

  // Use StaticJsonRpcProvider — tells ethers NOT to re-fetch network/chainId
  // on every call, which reduces the number of RPC calls and connection points
  const provider = new ethers.providers.StaticJsonRpcProvider(
    { url: RPC_URL, timeout: 30000 },  // 30 second timeout
    { chainId: 143, name: 'monad' }    // hardcode network — no extra RPC call needed
  );

  try {
    const net   = await provider.getNetwork();
    const block = await provider.getBlockNumber();
    logger.success(`Connected — Chain ID: ${net.chainId}  |  Block: #${block}`);
  } catch (err) {
    logger.error(`Cannot connect: ${err.message}`);
    process.exit(1);
  }

  // ── WALLET ───────────────────────────────────────────────
  let signer = null;
  if (!SETTINGS.paperTrade) {
    const key = process.env.PRIVATE_KEY;
    if (!key || key === '0xYOUR_PRIVATE_KEY_HERE') {
      logger.error('LIVE MODE requires PRIVATE_KEY in your .env file');
      logger.error('Set PAPER_TRADE=true to run safely without a key');
      process.exit(1);
    }
    signer = new ethers.Wallet(key, provider);
    const addr    = await signer.getAddress();
    const balance = await provider.getBalance(addr);
    const monBal  = parseFloat(ethers.utils.formatEther(balance));
    logger.success(`Wallet: ${addr}`);
    logger.success(`Balance: ${monBal.toFixed(4)} MON`);
    if (monBal < 10) {
      logger.warn('Balance below 10 MON — trades may fail due to insufficient funds');
    }
  } else {
    logger.info('📄 PAPER TRADE MODE — no real money will be spent');
    logger.info('   Set PAPER_TRADE=false in .env when ready to go live');
  }

  // ── SCANNER ──────────────────────────────────────────────
  const scanner = new Scanner(provider, signer);

  logger.info(`\nScanning ${PAIRS.length} pairs every ${SETTINGS.scanIntervalMs}ms`);
  logger.info(`Min arb to flag: ${SETTINGS.minArbPercent}%`);
  logger.info(`Max trade size:  ${SETTINGS.maxTradeSize} WMON`);
  logger.info(`DEXes:           Kuru (order book) vs Uniswap V3 (AMM)\n`);

  // Print stats every 60 seconds
  setInterval(() => scanner.printStats(), 60 * 1000);

  // ── MAIN LOOP ────────────────────────────────────────────
  while (true) {
    try {
      await scanner.scan();
    } catch (err) {
      logger.error(`Loop error: ${err.message}`);
      if (err.message.includes('429') || err.message.toLowerCase().includes('rate')) {
        logger.warn('Rate limited — waiting 15s...');
        await sleep(15000);
        continue;
      }
    }
    await sleep(SETTINGS.scanIntervalMs);
  }
}

process.on('SIGINT', () => { console.log('\n'); process.exit(0); });
process.on('uncaughtException', err => logger.error(`Uncaught: ${err.message}`));
main().catch(err => { logger.error(`Fatal: ${err.message}`); process.exit(1); });

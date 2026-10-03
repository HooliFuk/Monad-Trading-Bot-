const { ethers }  = require('ethers');
const { RPC_URL, PAIRS, SETTINGS } = require('./config');
const Scanner     = require('./scanner');
const logger      = require('./utils/logger');
const { sleep, withTimeout } = require('./utils/helpers');

// ── WATCHDOG ──────────────────────────────────────────────
let lastLoopSuccess = Date.now();
const MAX_STALL_MS = 8 * 60 * 1000; // 8 minutes

setInterval(() => {
  const stalledFor = Date.now() - lastLoopSuccess;
  if (stalledFor > MAX_STALL_MS) {
    logger.error(`WATCHDOG: main loop stalled ${Math.round(stalledFor / 1000)}s — exiting so PM2 restarts a fresh process`);
    process.exit(1);
  }
}, 30000);

async function main() {
  logger.banner();

  logger.info(`Connecting to Monad: ${RPC_URL}`);
  const provider = new ethers.providers.StaticJsonRpcProvider(
    { url: RPC_URL, timeout: 20000 },
    { chainId: 143, name: 'monad' }
  );

  try {
    const net   = await withTimeout(provider.getNetwork(), 15000, 'network check');
    const block = await withTimeout(provider.getBlockNumber(), 15000, 'block check');
    logger.success(`Connected — Chain ID: ${net.chainId}  |  Block: #${block}`);
  } catch (err) {
    logger.error(`Cannot connect: ${err.message}`);
    process.exit(1);
  }

  let signer = null;
  if (!SETTINGS.paperTrade) {
    const key = process.env.PRIVATE_KEY;
    if (!key || key === '0xYOUR_PRIVATE_KEY_HERE') {
      logger.error('LIVE MODE requires PRIVATE_KEY in .env');
      process.exit(1);
    }
    signer = new ethers.Wallet(key, provider);
    const addr    = await signer.getAddress();
    const balance = await withTimeout(provider.getBalance(addr), 15000, 'balance check');
    logger.success(`Wallet: ${addr}`);
    logger.success(`Balance: ${parseFloat(ethers.utils.formatEther(balance)).toFixed(4)} MON`);
  }

  const scanner = new Scanner(provider, signer);

  logger.info(`Scanning ${PAIRS.length} pairs every ${SETTINGS.scanIntervalMs}ms`);
  logger.info(`Min arb: ${SETTINGS.minArbPercent}% | Max size: ${SETTINGS.maxTradeSize} MON`);
  logger.info(`Watchdog armed: auto-restart if stalled > 8 min\n`);

  setInterval(() => scanner.printStats(), 60 * 1000);

  while (true) {
    try {
      // Hard cap: no scan cycle may ever exceed 5 minutes
      await withTimeout(scanner.scan(), 5 * 60 * 1000, 'scan cycle');
      lastLoopSuccess = Date.now();
    } catch (err) {
      logger.error(`Loop error: ${err.message}`);
      lastLoopSuccess = Date.now(); // error was caught = loop is alive, reset heartbeat
      await sleep(5000);
    }
    await sleep(SETTINGS.scanIntervalMs);
  }
}

process.on('SIGINT', () => { console.log('\n'); process.exit(0); });
process.on('uncaughtException', err => logger.error(`Uncaught: ${err.message}`));
process.on('unhandledRejection', (reason) => logger.error(`Unhandled rejection: ${(reason && reason.message) || reason}`));
main().catch(err => { logger.error(`Fatal: ${err.message}`); process.exit(1); });

// ============================================================
//  logger.js — Clean colored console output
// ============================================================

// We use chalk v4 (CommonJS compatible)
const chalk = require('chalk');

const logger = {
  // General info (white)
  info: (msg) => console.log(chalk.white(`[INFO]  ${timestamp()} ${msg}`)),

  // Good news (green)
  success: (msg) => console.log(chalk.green(`[✓]     ${timestamp()} ${msg}`)),

  // Opportunity found (yellow + bold)
  opportunity: (msg) => console.log(chalk.yellow.bold(`[💰]    ${timestamp()} ${msg}`)),

  // Trade executed (cyan)
  trade: (msg) => console.log(chalk.cyan(`[TRADE] ${timestamp()} ${msg}`)),

  // Warning (orange)
  warn: (msg) => console.log(chalk.hex('#FFA500')(`[WARN]  ${timestamp()} ${msg}`)),

  // Error (red)
  error: (msg) => console.log(chalk.red(`[ERROR] ${timestamp()} ${msg}`)),

  // Paper trade mode (magenta)
  paper: (msg) => console.log(chalk.magenta(`[PAPER] ${timestamp()} ${msg}`)),

  // Separator line
  divider: () => console.log(chalk.gray('─'.repeat(70))),

  // Big banner
  banner: () => {
    console.log(chalk.cyan.bold('\n╔══════════════════════════════════════════╗'));
    console.log(chalk.cyan.bold('║       MONAD CROSS-DEX ARBITRAGE BOT      ║'));
    console.log(chalk.cyan.bold('║       Scanning: Kuru | Ambient | Azaar    ║'));
    console.log(chalk.cyan.bold('╚══════════════════════════════════════════╝\n'));
  },
};

// Returns current time as HH:MM:SS
function timestamp() {
  return new Date().toTimeString().split(' ')[0];
}

module.exports = logger;

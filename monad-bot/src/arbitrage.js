// ============================================================
//  arbitrage.js — Core arbitrage engine
//
//  This is the brain of the bot.
//  It scans all DEX pairs, finds price gaps, and either:
//    - Logs the opportunity (paper trade mode)
//    - Executes the trade (live mode)
// ============================================================

const { ethers } = require('ethers');
const { ERC20_ABI, SETTINGS } = require('./config');
const { calculateArbitrageProfit, getMinAmountOut, formatUSD, formatAmount, safeCall } = require('./utils/helpers');
const logger = require('./utils/logger');

class ArbitrageEngine {
  constructor(provider, dexes, signer = null) {
    this.provider = provider;
    this.dexes = dexes;       // Array of DEX instances [KuruDEX, AmbientDEX, AzaarDEX]
    this.signer = signer;     // Wallet signer (null in paper trade mode)
    this.stats = {
      scansCompleted: 0,
      opportunitiesFound: 0,
      tradesExecuted: 0,
      totalProfitUSD: 0,
      errors: 0,
    };
  }

  /**
   * Scan all trading pairs across all DEX combinations
   * This is called on every tick of the main loop
   *
   * @param {Array} pairs - Trading pairs to scan (from config.TRADING_PAIRS)
   * @returns {Array} List of profitable opportunities found
   */
  async scanForOpportunities(pairs) {
    const opportunities = [];

    for (const pair of pairs) {
      const { tokenA, tokenB, label } = pair;

      // Get prices from ALL DEXes in parallel (faster than sequential)
      const pricePromises = this.dexes.map((dex) =>
        safeCall(() => dex.getPrice(tokenA, tokenB, SETTINGS.maxTradeAmountMON))
      );

      const prices = await Promise.all(pricePromises);
      const validPrices = prices.filter((p) => p !== null);

      if (validPrices.length < 2) {
        // Need at least 2 DEXes to have an arb opportunity
        continue;
      }

      // Find the best buy price (highest output = cheapest to buy tokenB)
      // and worst buy price to compare against
      const sorted = [...validPrices].sort((a, b) => b.price - a.price);
      const bestSell = sorted[0];  // Sell tokenA here (highest tokenB output)
      const bestBuy = sorted[sorted.length - 1]; // Buy tokenA here (lowest price)

      // Calculate if there's a profitable gap
      const gasCostUSD = 0.02; // ~$0.02 gas on Monad (very cheap)
      const profit = calculateArbitrageProfit(
        bestBuy.price,    // Buy price (we pay this)
        bestSell.price,   // Sell price (we receive this)
        SETTINGS.maxTradeAmountMON,
        gasCostUSD
      );

      if (profit.netProfit > SETTINGS.minProfitUSD) {
        const opportunity = {
          pair: label,
          tokenA,
          tokenB,
          buyDex: bestBuy.dex,
          sellDex: bestSell.dex,
          buyPrice: bestBuy.price,
          sellPrice: bestSell.price,
          tradeAmount: SETTINGS.maxTradeAmountMON,
          expectedProfit: profit,
          timestamp: Date.now(),
          allPrices: validPrices,
        };

        opportunities.push(opportunity);
        this.stats.opportunitiesFound++;

        this._logOpportunity(opportunity);
      } else {
        // Log price comparison even when not profitable (informational)
        logger.info(
          `${label}: ${validPrices.map((p) => `${p.dex}=${formatAmount(p.price, 4)}`).join(' | ')} ` +
          `Gap: ${formatUSD(profit.grossProfit)} (after gas: ${formatUSD(profit.netProfit)})`
        );
      }
    }

    this.stats.scansCompleted++;
    return opportunities;
  }

  /**
   * Execute an arbitrage opportunity
   *
   * The flow is:
   * 1. Buy tokenB cheaply on buyDex (send tokenA, receive tokenB)
   * 2. Sell tokenB for more tokenA on sellDex (send tokenB, receive tokenA)
   * Net result: more tokenA than we started with = profit
   */
  async executeArbitrage(opportunity) {
    if (SETTINGS.paperTrade) {
      // PAPER TRADE MODE — don't spend real money
      logger.paper(`[PAPER TRADE] Would execute: ${opportunity.pair}`);
      logger.paper(`  Buy  ${opportunity.tradeAmount} ${opportunity.tokenA.symbol} worth of ${opportunity.tokenB.symbol} on ${opportunity.buyDex}`);
      logger.paper(`  Sell on ${opportunity.sellDex}`);
      logger.paper(`  Expected profit: ${formatUSD(opportunity.expectedProfit.netProfit)}`);
      this.stats.totalProfitUSD += opportunity.expectedProfit.netProfit;
      this.stats.tradesExecuted++;
      return { success: true, paper: true };
    }

    // ── LIVE TRADE MODE ─────────────────────────────────────
    if (!this.signer) {
      logger.error('No signer configured for live trading. Set PAPER_TRADE=false and provide PRIVATE_KEY.');
      return { success: false };
    }

    const { tokenA, tokenB, tradeAmount } = opportunity;

    try {
      logger.trade(`Executing arb: ${opportunity.pair} | Expected profit: ${formatUSD(opportunity.expectedProfit.netProfit)}`);

      // Step 1: Approve DEX to spend our tokens (if not already approved)
      await this._ensureApproval(tokenA, opportunity.buyDex, tradeAmount);

      // Step 2: Buy on the cheaper DEX
      const buyDexInstance = this.dexes.find((d) => d.name === opportunity.buyDex);
      const minOut = getMinAmountOut(
        opportunity.tradeAmount * opportunity.buyPrice,
        SETTINGS.slippagePercent,
        tokenB.decimals
      );

      const buyReceipt = await buyDexInstance.executeSwap(
        tokenA, tokenB, tradeAmount, minOut, this.signer
      );

      // Step 3: Check how much tokenB we actually received
      const tokenBContract = new ethers.Contract(tokenB.address, ERC20_ABI, this.provider);
      const walletAddress = await this.signer.getAddress();
      const tokenBBalance = await tokenBContract.balanceOf(walletAddress);

      // Step 4: Sell on the more expensive DEX
      await this._ensureApproval(tokenB, opportunity.sellDex, null, tokenBBalance);

      const sellDexInstance = this.dexes.find((d) => d.name === opportunity.sellDex);
      const minSellOut = getMinAmountOut(
        opportunity.tradeAmount,
        SETTINGS.slippagePercent,
        tokenA.decimals
      );

      const sellReceipt = await sellDexInstance.executeSwap(
        tokenB, tokenA, null, minSellOut, this.signer, tokenBBalance
      );

      this.stats.tradesExecuted++;
      logger.success(`Arb complete! Tx: ${sellReceipt.transactionHash}`);

      return { success: true, buyTx: buyReceipt.hash, sellTx: sellReceipt.hash };
    } catch (err) {
      this.stats.errors++;
      logger.error(`Arb execution failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Ensure the DEX has approval to spend our tokens
   * ERC20 tokens require explicit approval before a contract can move them
   */
  async _ensureApproval(token, dexName, humanAmount, rawAmount = null) {
    const dexInstance = this.dexes.find((d) => d.name === dexName);
    const tokenContract = new ethers.Contract(token.address, ERC20_ABI, this.signer);
    const walletAddress = await this.signer.getAddress();

    const currentAllowance = await tokenContract.allowance(walletAddress, dexInstance.config.router);

    const requiredAmount = rawAmount || ethers.parseUnits(humanAmount.toString(), token.decimals);

    if (currentAllowance < requiredAmount) {
      logger.info(`Approving ${dexName} to spend ${token.symbol}...`);
      const tx = await tokenContract.approve(
        dexInstance.config.router,
        ethers.MaxUint256 // Approve max — only do this once per token/DEX pair
      );
      await tx.wait();
      logger.success(`Approval confirmed for ${token.symbol} on ${dexName}`);
    }
  }

  /**
   * Log a profitable opportunity clearly
   */
  _logOpportunity(opp) {
    logger.divider();
    logger.opportunity(`OPPORTUNITY FOUND: ${opp.pair}`);
    logger.opportunity(`  Buy  on ${opp.buyDex}  @ ${formatAmount(opp.buyPrice, 6)} ${opp.tokenB.symbol}/${opp.tokenA.symbol}`);
    logger.opportunity(`  Sell on ${opp.sellDex} @ ${formatAmount(opp.sellPrice, 6)} ${opp.tokenB.symbol}/${opp.tokenA.symbol}`);
    logger.opportunity(`  Spread: ${formatAmount(opp.expectedProfit.profitPercent, 4)}%`);
    logger.opportunity(`  Trade size: ${opp.tradeAmount} ${opp.tokenA.symbol}`);
    logger.opportunity(`  Gross profit: ${formatUSD(opp.expectedProfit.grossProfit)}`);
    logger.opportunity(`  Gas cost: ${formatUSD(opp.expectedProfit.gasCostUSD)}`);
    logger.opportunity(`  NET PROFIT: ${formatUSD(opp.expectedProfit.netProfit)}`);
    logger.divider();
  }

  /**
   * Print current bot statistics
   */
  printStats() {
    logger.divider();
    logger.info(`📊 BOT STATS`);
    logger.info(`  Scans completed:      ${this.stats.scansCompleted}`);
    logger.info(`  Opportunities found:  ${this.stats.opportunitiesFound}`);
    logger.info(`  Trades executed:      ${this.stats.tradesExecuted}`);
    logger.info(`  Total profit (sim):   ${formatUSD(this.stats.totalProfitUSD)}`);
    logger.info(`  Errors:               ${this.stats.errors}`);
    logger.info(`  Mode: ${SETTINGS.paperTrade ? '📄 PAPER TRADE (safe mode)' : '🔴 LIVE TRADING'}`);
    logger.divider();
  }
}

module.exports = ArbitrageEngine;

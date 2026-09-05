// ============================================================
//  helpers.js — Math utilities (ethers v5)
// ============================================================

const { ethers } = require('ethers');

function toWei(amount, decimals = 18) {
  return ethers.utils.parseUnits(amount.toString(), decimals);
}

function fromWei(amount, decimals = 18) {
  return parseFloat(ethers.utils.formatUnits(amount, decimals));
}

// Calculate arbitrage profit
// BUG FIX: removed Math.abs() — negative profit must show as negative
function calcProfit(buyPrice, sellPrice, size, gasCostUSD = 0.004) {
  const cost   = size * buyPrice;
  const income = size * sellPrice;
  const gross  = income - cost;
  const net    = gross - gasCostUSD;
  return {
    grossProfit:   gross,
    netProfit:     net,
    profitPercent: (gross / cost) * 100,
    gasCostUSD,
    isProfitable:  net > 0,
  };
}

// BUG FIX: show sign so losses are visible as negative numbers
// "$0.0012" = profit,  "-$0.0288" = loss
function fmtUSD(n) {
  if (n < 0) return `-$${Math.abs(n).toFixed(4)}`;
  return `$${n.toFixed(4)}`;
}

function fmtNum(n, d = 6) {
  return parseFloat(n.toFixed(d));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function deadline(mins = 5) {
  return Math.floor(Date.now() / 1000) + mins * 60;
}

module.exports = { toWei, fromWei, calcProfit, fmtUSD, fmtNum, sleep, deadline };

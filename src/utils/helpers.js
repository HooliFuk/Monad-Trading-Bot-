const { ethers } = require('ethers');

function toWei(amount, decimals = 18) {
  const str = typeof amount === 'number' ? amount.toFixed(decimals) : amount.toString();
  return ethers.utils.parseUnits(str, decimals);
}
function fromWei(amount, decimals = 18) {
  return parseFloat(ethers.utils.formatUnits(amount, decimals));
}
function calcProfit(buyPrice, sellPrice, size, gasCostUSD = 0.02) {
  const cost = size * buyPrice;
  const income = size * sellPrice;
  const gross = income - cost;
  const net = gross - gasCostUSD;
  return { grossProfit: gross, netProfit: net, profitPercent: cost > 0 ? (gross / cost) * 100 : 0, gasCostUSD, isProfitable: net > 0 };
}
function fmtUSD(n) {
  if (n < 0) return `-$${Math.abs(n).toFixed(4)}`;
  return `$${n.toFixed(4)}`;
}
function fmtNum(n, d = 6) { return parseFloat(n.toFixed(d)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function deadline(mins = 5) { return Math.floor(Date.now() / 1000) + mins * 60; }

// CRITICAL FIX: hard timeout guard — prevents any hung RPC/tx await
// from freezing the bot into a zombie state forever
function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms/1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { toWei, fromWei, calcProfit, fmtUSD, fmtNum, sleep, deadline, withTimeout };

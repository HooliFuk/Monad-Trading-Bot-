const { ethers } = require('ethers');

function toWei(amount, decimals = 18) {
  const str = typeof amount === 'number' ? amount.toFixed(decimals) : amount.toString();
  return ethers.utils.parseUnits(str, decimals);
}

function fromWei(amount, decimals = 18) {
  return parseFloat(ethers.utils.formatUnits(amount, decimals));
}

function calcProfit(buyPrice, sellPrice, size, gasCostUSD = 0.02) {
  const cost   = size * buyPrice;
  const income = size * sellPrice;
  const gross  = income - cost;
  const net    = gross - gasCostUSD;
  return {
    grossProfit:   gross,
    netProfit:     net,
    profitPercent: cost > 0 ? (gross / cost) * 100 : 0,
    gasCostUSD,
    isProfitable:  net > 0,
  };
}

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

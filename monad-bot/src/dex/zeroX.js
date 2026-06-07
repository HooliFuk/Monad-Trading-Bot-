// ============================================================
//  zeroX.js — 0x Swap API v2 for Monad (fixed)
//
//  Key fix: use quote.allowanceTarget (not hardcoded address)
//  and quote.transaction.to (not hardcoded router)
//  Per 0x docs: "Developers are strongly advised not to
//  hardcode this address. Use the value returned by transaction.to"
// ============================================================

const axios      = require('axios');
const { ethers } = require('ethers');
const logger     = require('../utils/logger');
const { toWei, fromWei } = require('../utils/helpers');

const CHAIN_ID   = 143;
const SLIPPAGE   = 500; // 5% in basis points

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

class ZeroX {
  constructor(provider) {
    this.provider = provider;
    this.name     = '0x Aggregator';
    this.apiKey   = process.env.ZEROx_API_KEY || '';
    this.baseUrl  = 'https://api.0x.org';
  }

  _headers() {
    return { '0x-api-key': this.apiKey, '0x-version': 'v2' };
  }

  _addr(a) { return ethers.utils.getAddress(a); }

  async getPrice(tokenIn, tokenOut, amountIn) {
    if (!this.apiKey) { logger.warn('0x: No API key'); return null; }
    try {
      const res = await axios.get(`${this.baseUrl}/swap/allowance-holder/price`, {
        params: {
          chainId:     CHAIN_ID,
          sellToken:   this._addr(tokenIn.address),
          buyToken:    this._addr(tokenOut.address),
          sellAmount:  toWei(amountIn, tokenIn.decimals).toString(),
          slippageBps: SLIPPAGE,
        },
        headers: this._headers(),
        timeout: 4000,
      });
      const amountOut = fromWei(res.data.buyAmount, tokenOut.decimals);
      return { dex: this.name, tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol, amountIn, amountOut, price: amountOut / amountIn };
    } catch (err) {
      const detail = err.response?.data?.reason || JSON.stringify(err.response?.data || err.message).slice(0,100);
      logger.warn(`0x price ${tokenIn.symbol}→${tokenOut.symbol} (${err.response?.status}): ${detail}`);
      return null;
    }
  }

  async getQuote(tokenIn, tokenOut, amountIn, walletAddress) {
    if (!this.apiKey) return null;
    try {
      const res = await axios.get(`${this.baseUrl}/swap/allowance-holder/quote`, {
        params: {
          chainId:     CHAIN_ID,
          sellToken:   this._addr(tokenIn.address),
          buyToken:    this._addr(tokenOut.address),
          sellAmount:  toWei(amountIn, tokenIn.decimals).toString(),
          taker:       walletAddress,
          slippageBps: SLIPPAGE,
        },
        headers: this._headers(),
        timeout: 8000,
      });
      return res.data;
    } catch (err) {
      const detail = err.response?.data?.reason || err.message;
      logger.warn(`0x quote: ${String(detail).slice(0,100)}`);
      return null;
    }
  }

  async executeSwapWithQuote(quote, tokenIn, amountIn, signer) {
    if (!quote?.transaction) throw new Error('0x: No transaction in quote');

    const walletAddr  = await signer.getAddress();
    const amountInWei = toWei(amountIn, tokenIn.decimals);

    // FIX: use allowanceTarget from quote, not hardcoded address
    const approvalTarget = quote.allowanceTarget || quote.issues?.allowance?.spender;
    if (approvalTarget) {
      const token     = new ethers.Contract(this._addr(tokenIn.address), ERC20_ABI, signer);
      const allowance = await token.allowance(walletAddr, approvalTarget);
      if (allowance.lt(amountInWei)) {
        logger.trade(`0x: Approving ${tokenIn.symbol}...`);
        const tx = await token.approve(approvalTarget, ethers.constants.MaxUint256);
        await tx.wait();
        logger.success(`0x: ${tokenIn.symbol} approved`);
      }
    }

    // FIX: use transaction.to from quote (not hardcoded router)
    const tx = quote.transaction;
    const txResp = await signer.sendTransaction({
      to:       tx.to,       // dynamic — from quote
      data:     tx.data,
      value:    ethers.BigNumber.from(tx.value || '0'),
      gasLimit: ethers.BigNumber.from(tx.gas  || '500000'),
    });

    logger.trade(`0x: Tx sent: ${txResp.hash}`);
    const receipt = await txResp.wait();

    if (receipt.status === 0) throw new Error(`0x: Reverted (${receipt.transactionHash})`);

    logger.success(`0x: Confirmed — ${receipt.transactionHash}`);
    return receipt;
  }

  async executeSwap(tokenIn, tokenOut, amountIn, signer) {
    const walletAddr = await signer.getAddress();
    logger.trade(`0x: ${amountIn} ${tokenIn.symbol} → ${tokenOut.symbol}`);
    const quote = await this.getQuote(tokenIn, tokenOut, amountIn, walletAddr);
    return this.executeSwapWithQuote(quote, tokenIn, amountIn, signer);
  }
}

module.exports = ZeroX;

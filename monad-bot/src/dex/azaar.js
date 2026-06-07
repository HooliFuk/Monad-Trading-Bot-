const { ethers } = require('ethers');
const { DEXES } = require('../config');
const { toWei, fromWei } = require('../utils/helpers');
const logger = require('../utils/logger');

const AZAAR_ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)',
];

class AzaarDEX {
  constructor(provider) {
    this.provider = provider;
    this.name = 'Azaar';
    this.config = DEXES.AZAAR;

    this.router = new ethers.Contract(
      this.config.router,
      AZAAR_ROUTER_ABI,
      provider
    );
  }

  async getPrice(tokenIn, tokenOut, amountIn = 1.0) {
    try {
      const amountInWei = toWei(amountIn, tokenIn.decimals);
      const path = [tokenIn.address, tokenOut.address];

      const amounts = await this.router.getAmountsOut(amountInWei, path);
      const amountOut = fromWei(amounts[amounts.length - 1], tokenOut.decimals);

      return {
        dex: this.name,
        tokenIn: tokenIn.symbol,
        tokenOut: tokenOut.symbol,
        amountIn,
        amountOut,
        price: amountOut / amountIn,
        raw: amounts[amounts.length - 1],
      };
    } catch (err) {
      logger.warn(`${this.name}: Could not get price for ${tokenIn.symbol}→${tokenOut.symbol}: ${err.message}`);
      return null;
    }
  }

  async executeSwap(tokenIn, tokenOut, amountIn, minAmountOut, signer) {
    const routerWithSigner = this.router.connect(signer);
    const amountInWei = toWei(amountIn, tokenIn.decimals);
    const path = [tokenIn.address, tokenOut.address];
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const walletAddress = await signer.getAddress();

    logger.trade(`Azaar: Swapping ${amountIn} ${tokenIn.symbol} → ${tokenOut.symbol}`);

    const tx = await routerWithSigner.swapExactTokensForTokens(
      amountInWei,
      minAmountOut,
      path,
      walletAddress,
      deadline,
      { gasLimit: 350000 }
    );

    logger.trade(`Azaar: Transaction sent: ${tx.hash}`);
    const receipt = await tx.wait();
    logger.success(`Azaar: Swap confirmed in block ${receipt.blockNumber}`);

    return receipt;
  }
}

module.exports = AzaarDEX;
const KuruSdk = require('@kuru-labs/kuru-sdk');

class KuruMarket {
  constructor(provider) {
    this.provider = provider;
    this.name = 'Kuru';
    this._cache = {};
  }

  async _getParams(marketAddress) {
    if (this._cache[marketAddress]) return this._cache[marketAddress];
    const params = await KuruSdk.ParamFetcher.getMarketParams(this.provider, marketAddress);
    this._cache[marketAddress] = params;
    return params;
  }

  async getQuote(marketAddress, label, actualSize = 30) {
    try {
      const params = await this._getParams(marketAddress);
      const tradeSize = parseFloat(actualSize);

      // BID: Estimate selling exact tradeSize MON -> USDC output
      const sellResult = await KuruSdk.CostEstimator.estimateMarketSell(
        this.provider, marketAddress, params, tradeSize
      );
      const usdcFromSell = parseFloat(sellResult.output.toString());
      if (!usdcFromSell || usdcFromSell <= 0) return null;

      const bidPrice = usdcFromSell / tradeSize;

      // ASK: Estimate spending that USDC to buy MON
      const buyResult = await KuruSdk.CostEstimator.estimateMarketBuy(
        this.provider, marketAddress, params, usdcFromSell
      );
      const monFromBuy = parseFloat(buyResult.output.toString());
      if (!monFromBuy || monFromBuy <= 0) return null;
      const askPrice = usdcFromSell / monFromBuy;

      return {
        dex: this.name,
        label,
        marketAddress,
        bidPrice,
        askPrice,
        usdcFromSell,
        monFromBuy
      };
    } catch (err) {
      return null;
    }
  }
}

module.exports = KuruMarket;

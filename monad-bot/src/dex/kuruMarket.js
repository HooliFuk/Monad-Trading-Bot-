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

  async getQuote(marketAddress, label) {
    try {
      const params = await this._getParams(marketAddress);

      // Get minimum size and probe size
      const sizePrecision = Math.pow(10, Math.round(Math.log10(parseFloat(params.sizePrecision.toString()))));
      const minSize = parseFloat(params.minSize.toString()) / sizePrecision;
      const tradeSize = Math.max(10, minSize * 2);

      // BID: Sell tradeSize MON → get USDC
      const sellResult = await KuruSdk.CostEstimator.estimateMarketSell(
        this.provider, marketAddress, params, tradeSize
      );
      const usdcFromSell = parseFloat(sellResult.output.toString());
      if (!usdcFromSell || usdcFromSell <= 0) return null;

      // FIX: Divide total USDC by MON sold to get price per MON
      const bidPrice = usdcFromSell / tradeSize;

      // ASK: Spend that USDC to buy back MON
      const buyResult = await KuruSdk.CostEstimator.estimateMarketBuy(
        this.provider, marketAddress, params, usdcFromSell
      );
      const monFromBuy = parseFloat(buyResult.output.toString());
      if (!monFromBuy || monFromBuy <= 0) return null;
      const askPrice = usdcFromSell / monFromBuy;

      const midPrice = (bidPrice + askPrice) / 2;
      const spread = askPrice - bidPrice;
      const spreadPct = midPrice > 0 ? (spread / midPrice) * 100 : 0;

      return {
        dex: this.name,
        label,
        marketAddress,
        bidPrice,
        askPrice,
        midPrice,
        spread,
        spreadPct,
        minSize,
      };
    } catch (err) {
      return null;
    }
  }
}

module.exports = KuruMarket;
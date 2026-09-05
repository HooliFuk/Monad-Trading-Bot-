# 🤖 Monad Cross-DEX Arbitrage Bot

A bot that scans Kuru, Ambient, and Azaar for price differences and profits from the gap.

---

## How It Works

```
Every 2 seconds:
  1. Ask Kuru:   "How much USDC for 10 WMON?"  → e.g. $42.10
  2. Ask Ambient: "How much USDC for 10 WMON?" → e.g. $42.50
  3. Ask Azaar:  "How much USDC for 10 WMON?"  → e.g. $41.90

  Best opportunity: Buy on Azaar ($41.90), sell on Ambient ($42.50)
  Profit: $0.60 - $0.02 gas = $0.58 net
  
  If $0.58 > $0.50 minimum → EXECUTE (or log in paper mode)
```

---

## Quick Start (5 Steps)

### Step 1 — Install Node.js
Download from https://nodejs.org (choose "LTS" version)

### Step 2 — Download this bot
```bash
# If you have git:
git clone <repo-url>
cd monad-arb-bot

# Or just unzip the folder and open terminal inside it
```

### Step 3 — Install dependencies
```bash
npm install
```

### Step 4 — Configure your settings
```bash
# Copy the example config
cp .env.example .env

# Open .env in any text editor and check the settings
# The defaults are safe (paper trade mode is ON)
```

### Step 5 — Run the bot
```bash
npm start
```

You should see the bot scanning and logging price differences immediately.

---

## Configuration (.env file)

| Setting | Default | What it does |
|---|---|---|
| `PAPER_TRADE` | `true` | Safe mode — finds opportunities but doesn't spend money |
| `MIN_PROFIT_USD` | `0.50` | Ignore opportunities below this profit |
| `MAX_TRADE_AMOUNT_MON` | `10` | Max trade size per opportunity |
| `SLIPPAGE_PERCENT` | `0.5` | Accept up to 0.5% worse price than quoted |
| `SCAN_INTERVAL_MS` | `2000` | Scan every 2 seconds |
| `RPC_URL` | Public Monad RPC | Blockchain connection URL |

---

## Going Live (When You Have Capital)

1. Open `.env`
2. Change `PAPER_TRADE=false`
3. Add your wallet private key: `PRIVATE_KEY=0xYourKeyHere`
4. Get a private RPC from [Alchemy](https://alchemy.com) or [QuickNode](https://quicknode.com) for faster execution
5. Fund your wallet with MON

> ⚠️ **Start small.** Test with 1–5 MON before increasing trade sizes.

---

## What You Need to Go Live

| Item | Where to get it |
|---|---|
| MON tokens | Buy on a CEX (Coinbase, etc.) and bridge to Monad |
| Private RPC | Alchemy or QuickNode (free tier works) |
| Wallet | MetaMask with Monad network added |

**Minimum capital recommendation:** ~50 MON ($3–$10 depending on price) to cover gas + meaningful trade sizes.

---

## File Structure

```
monad-arb-bot/
├── src/
│   ├── bot.js          ← Start here — main loop
│   ├── config.js       ← All addresses and settings
│   ├── arbitrage.js    ← Core logic: find and execute opportunities
│   ├── dex/
│   │   ├── kuru.js     ← Kuru Exchange connector
│   │   ├── ambient.js  ← Ambient Finance connector
│   │   └── azaar.js    ← Azaar aggregator connector
│   └── utils/
│       ├── logger.js   ← Colored console output
│       └── helpers.js  ← Math utilities
├── .env.example        ← Copy to .env and fill in
└── package.json
```

---

## Troubleshooting

**"Failed to connect to RPC"**
→ Check your internet connection. The public RPC (rpc.monad.xyz) can sometimes be slow.

**"Could not get price for WMON→USDC"**
→ Normal — some pairs may not have liquidity on all DEXes. The bot handles this.

**"Rate limited — waiting 10 seconds"**
→ You're hitting the public RPC limit. Get a free private RPC from Alchemy.

**Bot finds no opportunities**
→ Markets are efficient. Opportunities appear and disappear in seconds. 
→ Try lowering `MIN_PROFIT_USD` to `0.10` to see smaller gaps.
→ Consider adding more DEXes or token pairs.

---

## Important Warnings

- Never share your `.env` file or private key with anyone
- Never commit `.env` to GitHub (it's in `.gitignore`)
- Start with paper trading, understand the logs, then go live
- Arbitrage is competitive — other bots run too. Speed matters.
- This bot is educational — use at your own risk

---

## Upgrading the Bot (Next Steps)

Once you're comfortable, these improvements increase profitability:

1. **Flash loans** — Borrow capital for each trade, repay in same transaction. Zero upfront capital needed.
2. **Private RPC** — Faster price fetches = faster execution
3. **More DEXes** — Add PancakeSwap, Trader Joe, and other Monad DEXes
4. **MEV protection** — Submit transactions directly to validators to avoid front-running
5. **Dynamic trade sizing** — Larger trades on bigger opportunities

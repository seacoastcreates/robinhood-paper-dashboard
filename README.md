# Crypto Paper Trader

An hourly crypto paper-trading bot and its dashboard, both on Netlify. Paper only:
nothing here has brokerage credentials or places orders.

```
netlify/functions/hourly-run.mts   scheduled, every hour at :37
  -> netlify/lib/engine.mts pulls 1h candles from Coinbase (Kraken fallback, no keys),
     computes RSI(14), applies the rules in the stored state
  -> saves state / history / last_scan to the "paper-trader" Netlify Blobs store
netlify/functions/state.mts        GET /api/state, read by the page in public/
```

No tokens or environment variables are needed.

## Rules

Buy 1% of equity when a coin's 1h RSI(14) drops below 20; sell the whole position
when RSI gets back to 30 or above. Watchlist: all 49 Robinhood crypto pairs.

The live rules are in the stored state. `data/*.json` is only the seed used the first
time the store is empty (runs 1-19, before the bot moved to Netlify). To change rules
after that, ask for a small "update rules" change rather than editing `data/`.

## Running it

- **Now:** Netlify UI -> Logs & metrics -> Functions -> `hourly-run` -> Run now.
- **Locally, without saving anything:** `npm install && npm run dry-run`.
- **Raw data:** `/api/state` returns everything as JSON.

History: runs 1-18 ran as a claude.ai scheduled task using Robinhood's scanner; run 19
ran in GitHub Actions; later runs use Coinbase/Kraken prices on Netlify.

# Crypto Paper Trader dashboard

An hourly crypto paper-trading bot and its dashboard. Paper only: nothing here has
brokerage credentials or places orders.

```
GitHub Actions (.github/workflows/hourly.yml, hourly at :37)
  -> scripts/run_hourly.py pulls 1h candles from Coinbase (Kraken fallback, no keys),
     computes RSI(14), applies the rules in data/state.json
  -> commits data/*.json with the built-in GITHUB_TOKEN
Netlify site
  -> public/ (static page) + netlify/functions/state.mjs
  -> the function reads data/*.json from GitHub on each request (60s cache)
```

Commits that only change `data/` don't trigger a Netlify rebuild (see `ignore` in
`netlify.toml`). The page picks up new data on its own.

## Data files

| File | Written by | Contents |
|---|---|---|
| `data/state.json` | hourly run | the engine's state: cash, positions, rules, trade log, closed trades |
| `data/history.json` | hourly run | one equity snapshot per run, for the chart |
| `data/last_scan.json` | hourly run | latest RSI and price for every coin on the watchlist |

## Netlify environment variables

| Name | Value |
|---|---|
| `GITHUB_REPO` | `seacoastcreates/robinhood-paper-dashboard` |
| `GITHUB_TOKEN` | fine-grained token, this repo only, **Contents: read-only** |
| `GITHUB_BRANCH` | optional, defaults to `main` |

## Local preview

`npx netlify-cli dev` serves the site. With no `GITHUB_TOKEN` set, the function reads
`data/` from disk.

## Changing the rules

Edit `rule_sets` in `data/state.json` (entry/exit thresholds, position size) or
`universe.symbols`, commit, and the next run uses them. Run it on demand from the
Actions tab ("Hourly paper-trading run" -> Run workflow), or locally with
`python3 scripts/run_hourly.py --dry-run` to see the scan without writing anything.

History: runs 1-18 (2026-10-11 to 2026-10-12) ran as a claude.ai scheduled task using
Robinhood's scanner; later runs use Coinbase/Kraken prices.

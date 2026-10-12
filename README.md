# Crypto Paper Trader dashboard

A read-only dashboard for the hourly Robinhood crypto paper-trading bot. The bot itself
runs as a scheduled task in the Robinhood project on claude.ai.

```
claude.ai scheduled task (hourly at :37)
  -> paper_engine.py updates state
  -> scripts/push_to_github.py commits data/*.json to this repo
Netlify site
  -> public/ (static page) + netlify/functions/state.mjs
  -> the function reads data/*.json from GitHub on each request (60s cache)
```

Commits that only change `data/` don't trigger a Netlify rebuild (see `ignore` in
`netlify.toml`). The page picks up new data on its own.

## Data files

| File | Written by | Contents |
|---|---|---|
| `data/state.json` | hourly task | the engine's state: cash, positions, rules, trade log, closed trades |
| `data/history.json` | hourly task | one equity snapshot per run, for the chart |
| `data/last_scan.json` | hourly task | latest RSI and price for every coin on the watchlist |

## Netlify environment variables

| Name | Value |
|---|---|
| `GITHUB_REPO` | `seacoastcreates/robinhood-paper-dashboard` |
| `GITHUB_TOKEN` | fine-grained token, this repo only, **Contents: read-only** |
| `GITHUB_BRANCH` | optional, defaults to `main` |

## Local preview

`npx netlify-cli dev` serves the site. With no `GITHUB_TOKEN` set, the function reads
`data/` from disk.

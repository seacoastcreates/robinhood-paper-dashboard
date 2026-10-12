#!/usr/bin/env python3
"""
Publish one paper-trading run to the dashboard repo as a single commit.

Run by the hourly scheduled task after paper_engine.py has produced the new state:

    GITHUB_TOKEN=... GITHUB_REPO=owner/name \
      python3 push_to_github.py state.json market_data.json

Writes three files on the repo's main branch:
  data/state.json      the engine's updated state, verbatim
  data/last_scan.json  {"at": ..., "rows": [{"symbol", "rsi", "price"}]} from this run's scan
  data/history.json    previous history plus one equity snapshot for this run

Standard library only, so it works in a fresh container. Never touches a brokerage.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

API = "https://api.github.com"
REPO = os.environ["GITHUB_REPO"]
TOKEN = os.environ["GITHUB_TOKEN"]
BRANCH = os.environ.get("GITHUB_BRANCH", "main")
HISTORY_LIMIT = 24 * 365  # one year of hourly points


def gh(method, path, body=None, raw=False):
    req = urllib.request.Request(
        f"{API}/repos/{REPO}{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/vnd.github.raw+json" if raw else "application/vnd.github+json",
            "User-Agent": "paper-trader-hourly",
        },
    )
    with urllib.request.urlopen(req) as res:
        data = res.read()
        return data.decode() if raw else json.loads(data)


def load_history():
    try:
        return json.loads(gh("GET", f"/contents/data/history.json?ref={BRANCH}", raw=True))
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return []
        raise


def scan_rows(market):
    """Accepts {"SYM": {"rsi", "price"}} or [{"symbol", "rsi", "price"}]."""
    if isinstance(market, dict):
        market = market.get("symbols", market)
    if isinstance(market, dict):
        items = [{"symbol": s, **v} for s, v in market.items()]
    else:
        items = list(market)
    return [
        {"symbol": r.get("symbol"), "rsi": r.get("rsi"), "price": r.get("price", r.get("last_price"))}
        for r in items
        if r.get("symbol")
    ]


def snapshot(state, rows):
    prices = {r["symbol"]: r["price"] for r in rows if r.get("price") is not None}
    positions_value = sum(
        p["quantity"] * prices.get(sym, p.get("last_mark_price") or p["avg_cost_basis"])
        for sym, p in state.get("positions", {}).items()
    )
    cash = state["account"]["virtual_cash_usd"]
    return {
        "t": state.get("last_run_at") or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "equity": round(cash + positions_value, 2),
        "cash": round(cash, 2),
        "positions_value": round(positions_value, 2),
        "open_positions": len(state.get("positions", {})),
        "realized_pnl_usd": round(state.get("realized_pnl_usd", 0), 2),
    }


def main(state_path, market_path):
    state = json.load(open(state_path))
    rows = scan_rows(json.load(open(market_path)))
    point = snapshot(state, rows)

    history = [h for h in load_history() if h.get("t") != point["t"]]
    history = (history + [point])[-HISTORY_LIMIT:]

    files = {
        "data/state.json": json.dumps(state, indent=2),
        "data/last_scan.json": json.dumps({"at": point["t"], "rows": rows}),
        "data/history.json": json.dumps(history),
    }

    head = gh("GET", f"/git/ref/heads/{BRANCH}")["object"]["sha"]
    base_tree = gh("GET", f"/git/commits/{head}")["tree"]["sha"]
    tree = gh("POST", "/git/trees", {
        "base_tree": base_tree,
        "tree": [{"path": p, "mode": "100644", "type": "blob", "content": c} for p, c in files.items()],
    })["sha"]
    commit = gh("POST", "/git/commits", {
        "message": f"data: run {state.get('run_count', '?')} at {point['t']} (equity ${point['equity']:,.2f})",
        "tree": tree,
        "parents": [head],
    })["sha"]
    gh("PATCH", f"/git/refs/heads/{BRANCH}", {"sha": commit})
    print(f"Pushed {commit[:7]}: equity ${point['equity']:,.2f}, {point['open_positions']} open, {len(rows)} coins scanned")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])

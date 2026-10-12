#!/usr/bin/env python3
"""
Hourly crypto paper-trading run. Called by .github/workflows/hourly.yml.

1. Pulls ~300 hourly candles per watchlist coin from Coinbase (Kraken as fallback),
   both public endpoints with no API key.
2. Computes Wilder RSI(period) on closes, including the current in-progress candle,
   so a dip is caught on the run where it happens.
3. Applies each rule set in data/state.json:
     exit:  open position and RSI >= exit.threshold  -> sell the whole position
     entry: no position and RSI < entry.threshold    -> buy entry.position_size_pct_of_portfolio
                                                       of equity (measured at the start of the run)
4. Writes data/state.json, data/last_scan.json and appends to data/history.json.

Paper only: this script has no brokerage credentials and places no orders.
Usage: python3 scripts/run_hourly.py [--dry-run]
"""
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
HISTORY_LIMIT = 24 * 365
KRAKEN_ALIASES = {"BTC": "XBT", "DOGE": "XDG"}


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def get_json(url, tries=4):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "paper-trader/1.0"})
            with urllib.request.urlopen(req, timeout=20) as res:
                return json.load(res)
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return None
            if attempt == tries - 1:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == tries - 1:
                raise
        time.sleep(1.5 * (attempt + 1))


def coinbase_closes(symbol):
    rows = get_json(f"https://api.exchange.coinbase.com/products/{symbol}-USD/candles?granularity=3600")
    if not rows or not isinstance(rows, list):
        return None
    rows.sort(key=lambda r: r[0])  # [time, low, high, open, close, volume], newest first from the API
    return [float(r[4]) for r in rows]


def kraken_closes(symbol):
    pair = f"{KRAKEN_ALIASES.get(symbol, symbol)}USD"
    body = get_json(f"https://api.kraken.com/0/public/OHLC?pair={pair}&interval=60")
    if not body or body.get("error"):
        return None
    series = next((v for k, v in body["result"].items() if k != "last"), None)
    return [float(r[4]) for r in series] if series else None  # oldest first; last row is in progress


def wilder_rsi(closes, period):
    if len(closes) <= period:
        return None
    gains = losses = 0.0
    for prev, cur in zip(closes[:period], closes[1 : period + 1]):
        change = cur - prev
        gains += max(change, 0)
        losses += max(-change, 0)
    avg_gain, avg_loss = gains / period, losses / period
    for prev, cur in zip(closes[period:], closes[period + 1 :]):
        change = cur - prev
        avg_gain = (avg_gain * (period - 1) + max(change, 0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-change, 0)) / period
    if avg_loss == 0:
        return 50.0 if avg_gain == 0 else 100.0
    return 100 - 100 / (1 + avg_gain / avg_loss)


def scan(symbols, period):
    rows = []
    for symbol in symbols:
        source, closes = "coinbase", coinbase_closes(symbol)
        if not closes:
            source, closes = "kraken", kraken_closes(symbol)
        rsi = wilder_rsi(closes, period) if closes else None
        rows.append({
            "symbol": symbol,
            "rsi": round(rsi, 2) if rsi is not None else None,
            "price": closes[-1] if closes else None,
            "source": source if closes else None,
        })
        time.sleep(0.15)  # stay well under Coinbase's public rate limit
    return rows


def equity(state, prices):
    marks = sum(p["quantity"] * prices.get(s, p["last_mark_price"]) for s, p in state["positions"].items())
    return state["account"]["virtual_cash_usd"] + marks, marks


def apply_rules(state, rows, at):
    by_symbol = {r["symbol"]: r for r in rows if r["rsi"] is not None and r["price"]}
    prices = {s: r["price"] for s, r in by_symbol.items()}
    start_equity, _ = equity(state, prices)
    events = []

    for symbol, pos in state["positions"].items():
        if symbol in prices:
            pos["last_mark_price"] = prices[symbol]

    for rule in state["rule_sets"]:
        if rule.get("active_window", "always") != "always":
            continue  # time-windowed rule sets aren't defined yet
        entry, exit_ = rule["entry"], rule["exit"]

        for symbol in list(state["positions"]):
            pos = state["positions"][symbol]
            row = by_symbol.get(symbol)
            if pos.get("opened_by_rule") != rule["id"] or not row or row["rsi"] < exit_["threshold"]:
                continue
            proceeds = pos["quantity"] * row["price"]
            pnl = proceeds - pos["total_cost_usd"]
            state["account"]["virtual_cash_usd"] += proceeds
            state["realized_pnl_usd"] = state.get("realized_pnl_usd", 0) + pnl
            trade = {
                "timestamp": at, "symbol": symbol, "side": "sell", "rule_id": rule["id"],
                "rsi_at_trigger": row["rsi"], "price": row["price"], "quantity": pos["quantity"],
                "notional_usd": round(proceeds, 2), "realized_pnl_usd": round(pnl, 2), "mode": "paper",
            }
            state["trade_log"].append(trade)
            state["closed_trades"].append({
                "symbol": symbol, "rule_id": rule["id"], "opened_at": pos["opened_at"], "closed_at": at,
                "avg_cost_basis": pos["avg_cost_basis"], "exit_price": row["price"], "quantity": pos["quantity"],
                "cost_usd": pos["total_cost_usd"], "proceeds_usd": round(proceeds, 2),
                "realized_pnl_usd": round(pnl, 2),
            })
            del state["positions"][symbol]
            events.append(f"SELL {symbol} @ {row['price']} (RSI {row['rsi']}) P&L {pnl:+,.2f}")

        notional = start_equity * entry["position_size_pct_of_portfolio"] / 100
        for symbol in state["universe"]["symbols"]:
            row = by_symbol.get(symbol)
            if not row or symbol in state["positions"] or row["rsi"] >= entry["threshold"]:
                continue
            if state["account"]["virtual_cash_usd"] < notional:
                events.append(f"SKIP {symbol}: not enough paper cash")
                continue
            quantity = notional / row["price"]
            state["account"]["virtual_cash_usd"] -= notional
            state["positions"][symbol] = {
                "quantity": quantity, "avg_cost_basis": row["price"], "total_cost_usd": round(notional, 2),
                "last_mark_price": row["price"], "opened_by_rule": rule["id"], "opened_at": at, "tranches": 1,
            }
            state["trade_log"].append({
                "timestamp": at, "symbol": symbol, "side": "buy", "rule_id": rule["id"],
                "rsi_at_trigger": row["rsi"], "price": row["price"], "quantity": quantity,
                "notional_usd": round(notional, 2), "mode": "paper",
            })
            events.append(f"BUY {symbol} @ {row['price']} (RSI {row['rsi']}) ${notional:,.2f}")

    state["watch_state"] = {
        s: {"armed": s not in state["positions"], "has_open_position": s in state["positions"]}
        for s in state["universe"]["symbols"]
    }
    return events, prices


def main():
    dry_run = "--dry-run" in sys.argv
    state = json.loads((DATA / "state.json").read_text())
    state.setdefault("trade_log", [])
    state.setdefault("closed_trades", [])
    period = state["rule_sets"][0]["entry"]["rsi_period"]
    at = now_iso()

    rows = scan(state["universe"]["symbols"], period)
    events, prices = apply_rules(state, rows, at)

    state["run_count"] = state.get("run_count", 0) + 1
    state["last_run_at"] = state["updated_at"] = at
    state["data_source"] = "Coinbase Exchange public candles (Kraken fallback), 1h"
    total, marks = equity(state, prices)

    point = {
        "t": at,
        "equity": round(total, 2),
        "cash": round(state["account"]["virtual_cash_usd"], 2),
        "positions_value": round(marks, 2),
        "open_positions": len(state["positions"]),
        "realized_pnl_usd": round(state.get("realized_pnl_usd", 0), 2),
    }
    missing = [r["symbol"] for r in rows if r["rsi"] is None]
    print(f"Run {state['run_count']} at {at}: equity ${total:,.2f}, {len(state['positions'])} open, "
          f"{len(rows) - len(missing)}/{len(rows)} coins scanned" + (f", no data for {missing}" if missing else ""))
    for e in events:
        print("  " + e)

    if dry_run:
        print(json.dumps(sorted(rows, key=lambda r: r["rsi"] if r["rsi"] is not None else 999)[:8], indent=1))
        return

    history_path = DATA / "history.json"
    history = json.loads(history_path.read_text()) if history_path.exists() else []
    history = (history + [point])[-HISTORY_LIMIT:]
    (DATA / "state.json").write_text(json.dumps(state, indent=2) + "\n")
    (DATA / "last_scan.json").write_text(json.dumps({"at": at, "rows": rows}) + "\n")
    history_path.write_text(json.dumps(history) + "\n")


if __name__ == "__main__":
    main()

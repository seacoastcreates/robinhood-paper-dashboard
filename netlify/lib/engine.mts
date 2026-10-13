// Paper-trading engine shared by the hourly scheduled function and the local dry run.
//
// 1. Pulls ~300 hourly candles per watchlist coin from Coinbase (Kraken as fallback),
//    both public endpoints with no API key.
// 2. Computes Wilder RSI(period) on closes, including the current in-progress candle,
//    so a dip is caught on the run where it happens.
// 3. Applies each rule set in the state:
//      exit:  open position and RSI >= exit.threshold  -> sell the whole position
//      entry: no position and RSI < entry.threshold    -> buy entry.position_size_pct_of_portfolio
//                                                        of equity (measured at the start of the run)
//
// Paper only: nothing here has brokerage credentials or places orders.

export type ScanRow = { symbol: string; rsi: number | null; price: number | null; source: string | null };
export type HistoryPoint = {
  t: string;
  equity: number;
  cash: number;
  positions_value: number;
  open_positions: number;
  realized_pnl_usd: number;
};
// The state shape is defined by data/state.json; kept loose so new fields pass through.
export type State = Record<string, any>;

const KRAKEN_ALIASES: Record<string, string> = { BTC: "XBT", DOGE: "XDG" };
const CONCURRENCY = 6; // Coinbase allows ~10 public requests/second
export const HISTORY_LIMIT = 24 * 365;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round2 = (n: number) => Math.round(n * 100) / 100;

async function getJson(url: string, tries = 3): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "paper-trader/1.0" },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= tries) throw err;
      await sleep(700 * attempt);
    }
  }
}

async function coinbaseCloses(symbol: string): Promise<number[] | null> {
  const rows = await getJson(`https://api.exchange.coinbase.com/products/${symbol}-USD/candles?granularity=3600`);
  if (!Array.isArray(rows) || !rows.length) return null;
  // [time, low, high, open, close, volume], newest first from the API
  return rows.sort((a, b) => a[0] - b[0]).map((r) => Number(r[4]));
}

async function krakenCloses(symbol: string): Promise<number[] | null> {
  const pair = `${KRAKEN_ALIASES[symbol] ?? symbol}USD`;
  const body = await getJson(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=60`);
  if (!body || body.error?.length) return null;
  const series = Object.entries(body.result ?? {}).find(([k]) => k !== "last")?.[1] as any[] | undefined;
  // oldest first; the last row is the in-progress candle
  return series?.length ? series.map((r) => Number(r[4])) : null;
}

export function wilderRsi(closes: number[], period: number): number | null {
  if (closes.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

async function scanOne(symbol: string, period: number): Promise<ScanRow> {
  let source = "coinbase";
  let closes = await coinbaseCloses(symbol).catch(() => null);
  if (!closes) {
    source = "kraken";
    closes = await krakenCloses(symbol).catch(() => null);
  }
  if (!closes) return { symbol, rsi: null, price: null, source: null };
  const rsi = wilderRsi(closes, period);
  return { symbol, rsi: rsi == null ? null : round2(rsi), price: closes[closes.length - 1], source };
}

export async function scan(symbols: string[], period: number): Promise<ScanRow[]> {
  const rows: ScanRow[] = new Array(symbols.length);
  let next = 0;
  const worker = async () => {
    while (next < symbols.length) {
      const i = next++;
      rows[i] = await scanOne(symbols[i], period);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return rows;
}

function equity(state: State, prices: Record<string, number>) {
  let marks = 0;
  for (const [sym, p] of Object.entries<any>(state.positions)) {
    marks += p.quantity * (prices[sym] ?? p.last_mark_price);
  }
  return { total: state.account.virtual_cash_usd + marks, marks };
}

export function applyRules(state: State, rows: ScanRow[], at: string): string[] {
  const bySymbol = new Map(rows.filter((r) => r.rsi != null && r.price).map((r) => [r.symbol, r]));
  const prices = Object.fromEntries([...bySymbol].map(([s, r]) => [s, r.price as number]));
  const startEquity = equity(state, prices).total;
  const events: string[] = [];

  for (const [sym, pos] of Object.entries<any>(state.positions)) {
    if (sym in prices) pos.last_mark_price = prices[sym];
  }

  for (const rule of state.rule_sets) {
    if ((rule.active_window ?? "always") !== "always") continue; // time-windowed rule sets aren't defined yet
    const { entry, exit } = rule;

    for (const sym of Object.keys(state.positions)) {
      const pos = state.positions[sym];
      const row = bySymbol.get(sym);
      if (pos.opened_by_rule !== rule.id || !row || (row.rsi as number) < exit.threshold) continue;
      const price = row.price as number;
      const proceeds = pos.quantity * price;
      const pnl = proceeds - pos.total_cost_usd;
      state.account.virtual_cash_usd += proceeds;
      state.realized_pnl_usd = (state.realized_pnl_usd ?? 0) + pnl;
      state.trade_log.push({
        timestamp: at, symbol: sym, side: "sell", rule_id: rule.id, rsi_at_trigger: row.rsi, price,
        quantity: pos.quantity, notional_usd: round2(proceeds), realized_pnl_usd: round2(pnl), mode: "paper",
      });
      state.closed_trades.push({
        symbol: sym, rule_id: rule.id, opened_at: pos.opened_at, closed_at: at, avg_cost_basis: pos.avg_cost_basis,
        exit_price: price, quantity: pos.quantity, cost_usd: pos.total_cost_usd, proceeds_usd: round2(proceeds),
        realized_pnl_usd: round2(pnl),
      });
      delete state.positions[sym];
      events.push(`SELL ${sym} @ ${price} (RSI ${row.rsi}) P&L ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
    }

    const notional = (startEquity * entry.position_size_pct_of_portfolio) / 100;
    for (const sym of state.universe.symbols) {
      const row = bySymbol.get(sym);
      if (!row || sym in state.positions || (row.rsi as number) >= entry.threshold) continue;
      if (state.account.virtual_cash_usd < notional) {
        events.push(`SKIP ${sym}: not enough paper cash`);
        continue;
      }
      const price = row.price as number;
      const quantity = notional / price;
      state.account.virtual_cash_usd -= notional;
      state.positions[sym] = {
        quantity, avg_cost_basis: price, total_cost_usd: round2(notional), last_mark_price: price,
        opened_by_rule: rule.id, opened_at: at, tranches: 1,
      };
      state.trade_log.push({
        timestamp: at, symbol: sym, side: "buy", rule_id: rule.id, rsi_at_trigger: row.rsi, price,
        quantity, notional_usd: round2(notional), mode: "paper",
      });
      events.push(`BUY ${sym} @ ${price} (RSI ${row.rsi}) $${notional.toFixed(2)}`);
    }
  }

  state.watch_state = Object.fromEntries(
    state.universe.symbols.map((s: string) => [s, { armed: !(s in state.positions), has_open_position: s in state.positions }]),
  );
  return events;
}

// One full run: scan, apply rules, and return the updated state plus what to persist.
export async function runOnce(state: State, at = new Date().toISOString().replace(/\.\d+Z$/, "Z")) {
  state.trade_log ??= [];
  state.closed_trades ??= [];
  const rows = await scan(state.universe.symbols, state.rule_sets[0].entry.rsi_period);
  const events = applyRules(state, rows, at);

  state.run_count = (state.run_count ?? 0) + 1;
  state.last_run_at = state.updated_at = at;
  state.data_source = "Coinbase Exchange public candles (Kraken fallback), 1h";

  const prices = Object.fromEntries(rows.filter((r) => r.price).map((r) => [r.symbol, r.price as number]));
  const { total, marks } = equity(state, prices);
  const point: HistoryPoint = {
    t: at,
    equity: round2(total),
    cash: round2(state.account.virtual_cash_usd),
    positions_value: round2(marks),
    open_positions: Object.keys(state.positions).length,
    realized_pnl_usd: round2(state.realized_pnl_usd ?? 0),
  };
  const missing = rows.filter((r) => r.rsi == null).map((r) => r.symbol);
  const summary =
    `Run ${state.run_count} at ${at}: equity $${total.toFixed(2)}, ${point.open_positions} open, ` +
    `${rows.length - missing.length}/${rows.length} coins scanned` +
    (missing.length ? `, no data for ${missing.join(", ")}` : "");
  return { state, lastScan: { at, rows }, point, events, summary };
}

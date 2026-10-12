const $ = (id) => document.getElementById(id);

const usd = (n, digits = 2) =>
  n == null || Number.isNaN(n) ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
const signedUsd = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + usd(Math.abs(n));
const pct = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(2) + "%";
const price = (n) => {
  if (n == null) return "—";
  const digits = n >= 100 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 5 : 8;
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
};
const qty = (n) => (n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : 6 }));
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
const ago = (iso) => {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 48 ? `${hrs} hr ago` : `${Math.round(hrs / 24)} days ago`;
};
const cls = (n) => (n > 0 ? "pos" : n < 0 ? "neg" : "");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function table(columns, rows, emptyText) {
  if (!rows.length) return `<p class="empty">${emptyText}</p>`;
  const head = columns.map((c) => `<th class="${c.num ? "num" : ""}">${c.label}</th>`).join("");
  const body = rows
    .map((r) => "<tr>" + columns.map((c) => `<td class="${c.num ? "num " : ""}${c.cls ? c.cls(r) : ""}">${c.render(r)}</td>`).join("") + "</tr>")
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// Latest RSI/price per symbol, if the hourly job wrote last_scan.json.
function scanBySymbol(lastScan) {
  const map = new Map();
  for (const row of lastScan?.rows ?? []) map.set(row.symbol, row);
  return map;
}

function derive(state, scan) {
  const positions = Object.entries(state.positions ?? {}).map(([symbol, p]) => {
    const mark = scan.get(symbol)?.price ?? p.last_mark_price ?? p.avg_cost_basis;
    const value = p.quantity * mark;
    const unrealized = value - p.total_cost_usd;
    return { symbol, ...p, mark, value, unrealized, unrealizedPct: (unrealized / p.total_cost_usd) * 100, rsi: scan.get(symbol)?.rsi };
  });
  const cash = state.account.virtual_cash_usd;
  const start = state.account.virtual_starting_capital_usd;
  const positionsValue = positions.reduce((s, p) => s + p.value, 0);
  const equity = cash + positionsValue;
  const unrealized = positions.reduce((s, p) => s + p.unrealized, 0);
  return { positions, cash, start, positionsValue, equity, unrealized, totalPnl: equity - start };
}

function renderKpis(state, d) {
  const tiles = [
    { label: "Equity", value: usd(d.equity), note: `Started at ${usd(d.start, 0)}` },
    { label: "Total P&L", value: signedUsd(d.totalPnl), note: pct((d.totalPnl / d.start) * 100), cls: cls(d.totalPnl) },
    { label: "Unrealized", value: signedUsd(d.unrealized), note: `${d.positions.length} open position${d.positions.length === 1 ? "" : "s"}`, cls: cls(d.unrealized) },
    { label: "Realized", value: signedUsd(state.realized_pnl_usd ?? 0), note: `${(state.closed_trades ?? []).length} closed trade${(state.closed_trades ?? []).length === 1 ? "" : "s"}`, cls: cls(state.realized_pnl_usd ?? 0) },
    { label: "Cash", value: usd(d.cash), note: `${((d.cash / d.equity) * 100).toFixed(1)}% of equity` },
  ];
  $("kpis").innerHTML = tiles
    .map((t) => `<div class="kpi"><div class="kpi-label">${t.label}</div><div class="kpi-value ${t.cls ?? ""}">${t.value}</div><div class="kpi-note">${t.note}</div></div>`)
    .join("");
}

function renderEquity(history, d, startCapital) {
  const points = [...(history ?? [])].map((h) => ({ t: new Date(h.t), equity: h.equity, cash: h.cash, open: h.open_positions }));
  const el = $("equity-chart");

  $("equity-table").innerHTML = table(
    [
      { label: "Time", render: (r) => when(r.t) },
      { label: "Equity", num: true, render: (r) => usd(r.equity) },
      { label: "Cash", num: true, render: (r) => usd(r.cash) },
      { label: "Open", num: true, render: (r) => r.open ?? "—" },
    ],
    [...points].reverse(),
    "No history yet.",
  );

  if (points.length < 2) {
    el.innerHTML = `<p class="empty">The curve starts after the second hourly run. Current equity: ${usd(d.equity)}.</p>`;
    return;
  }

  const W = el.clientWidth || 800;
  const H = el.clientHeight || 260;
  const m = { top: 12, right: 12, bottom: 24, left: 72 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;

  const t0 = +points[0].t;
  const t1 = +points[points.length - 1].t;
  const vals = points.map((p) => p.equity).concat(startCapital);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.15, hi * 0.0005);
  lo -= pad;
  hi += pad;

  const x = (t) => m.left + ((t - t0) / (t1 - t0 || 1)) * iw;
  const y = (v) => m.top + (1 - (v - lo) / (hi - lo)) * ih;

  const ticks = 4;
  const grid = Array.from({ length: ticks + 1 }, (_, i) => lo + ((hi - lo) * i) / ticks)
    .map((v) => `<line class="gridline" x1="${m.left}" x2="${W - m.right}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.left - 8}" y="${y(v) + 4}" text-anchor="end">${usd(v, 0)}</text>`)
    .join("");
  const xTicks = [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]]
    .map((p, i) => `<text x="${x(+p.t)}" y="${H - 6}" text-anchor="${["start", "middle", "end"][i]}">${when(p.t.toISOString())}</text>`)
    .join("");

  const line = points.map((p, i) => `${i ? "L" : "M"}${x(+p.t).toFixed(1)},${y(p.equity).toFixed(1)}`).join("");
  const area = `${line}L${x(t1)},${m.top + ih}L${x(t0)},${m.top + ih}Z`;

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Equity over time">
    <g class="axis">${grid}${xTicks}</g>
    <line class="baseline" x1="${m.left}" x2="${W - m.right}" y1="${y(startCapital)}" y2="${y(startCapital)}"/>
    <path class="area" d="${area}"/>
    <path class="line" d="${line}"/>
    <line class="crosshair" id="xh" y1="${m.top}" y2="${m.top + ih}" visibility="hidden"/>
    <circle class="dot" id="xdot" r="5" visibility="hidden"/>
    <rect x="${m.left}" y="${m.top}" width="${iw}" height="${ih}" fill="transparent" id="hit"/>
  </svg>`;

  const tip = $("tooltip");
  const svg = el.querySelector("svg");
  const hit = el.querySelector("#hit");
  const xh = el.querySelector("#xh");
  const dot = el.querySelector("#xdot");

  hit.addEventListener("pointermove", (e) => {
    const box = svg.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * W;
    const t = t0 + ((sx - m.left) / iw) * (t1 - t0);
    let best = points[0];
    for (const p of points) if (Math.abs(+p.t - t) < Math.abs(+best.t - t)) best = p;
    const px = x(+best.t);
    const py = y(best.equity);
    xh.setAttribute("x1", px);
    xh.setAttribute("x2", px);
    xh.setAttribute("visibility", "visible");
    dot.setAttribute("cx", px);
    dot.setAttribute("cy", py);
    dot.setAttribute("visibility", "visible");
    const chg = best.equity - startCapital;
    tip.innerHTML = `<span>${when(best.t.toISOString())}</span><strong>${usd(best.equity)}</strong><span class="${cls(chg)}">${signedUsd(chg)} vs start</span>`;
    tip.hidden = false;
    const tx = box.left + (px / W) * box.width;
    const ty = box.top + (py / H) * box.height;
    const left = tx + 14 + tip.offsetWidth > window.innerWidth ? tx - 14 - tip.offsetWidth : tx + 14;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(8, ty - tip.offsetHeight - 10)}px`;
  });
  hit.addEventListener("pointerleave", () => {
    tip.hidden = true;
    xh.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
  });
}

function renderPositions(d) {
  $("positions").innerHTML = table(
    [
      { label: "Coin", render: (r) => `<span class="sym">${esc(r.symbol)}</span>` },
      { label: "Value", num: true, render: (r) => usd(r.value) },
      { label: "P&L", num: true, cls: (r) => cls(r.unrealized), render: (r) => `${signedUsd(r.unrealized)}<br><small>${pct(r.unrealizedPct)}</small>` },
      { label: "Avg cost", num: true, render: (r) => price(r.avg_cost_basis) },
      { label: "Mark", num: true, render: (r) => price(r.mark) },
      { label: "RSI", num: true, render: (r) => (r.rsi == null ? "—" : r.rsi.toFixed(1)) },
      { label: "Opened", render: (r) => when(r.opened_at) },
    ],
    d.positions.sort((a, b) => b.value - a.value),
    "No open positions. The bot buys when a coin's 1h RSI drops below the entry threshold.",
  );
}

function renderRules(state) {
  $("rules").innerHTML = (state.rule_sets ?? [])
    .map(
      (r) => `<div class="rule">
        <div class="rule-title">${esc(r.label)}</div>
        <dl>
          <dt>Buy when</dt><dd>RSI(${r.entry.rsi_period}, ${esc(r.entry.rsi_interval)}) &lt; ${r.entry.threshold}</dd>
          <dt>Size</dt><dd>${r.entry.position_size_pct_of_portfolio}% of equity</dd>
          <dt>Sell when</dt><dd>RSI(${r.exit.rsi_period}, ${esc(r.exit.rsi_interval)}) ≥ ${r.exit.threshold}</dd>
          <dt>Active</dt><dd>${esc(r.active_window)}</dd>
        </dl>
      </div>`,
    )
    .join("");
}

function renderWatchlist(state, scan, lastScan) {
  const entry = state.rule_sets?.[0]?.entry?.threshold ?? 20;
  const exit = state.rule_sets?.[0]?.exit?.threshold ?? 30;
  const symbols = state.universe?.symbols ?? Object.keys(state.watch_state ?? {});
  const held = new Set(Object.keys(state.positions ?? {}));

  const rows = symbols.map((s) => ({ symbol: s, rsi: scan.get(s)?.rsi, held: held.has(s) }));
  if (scan.size) rows.sort((a, b) => (a.rsi ?? 999) - (b.rsi ?? 999));

  $("watch-hint").textContent = scan.size
    ? `${symbols.length} coins, sorted by 1h RSI · red bar = below ${entry} (buy zone), amber = ${entry}–${exit} · scanned ${ago(lastScan.at)}`
    : `${symbols.length} coins · RSI values appear once the hourly job writes last_scan.json`;

  $("watchlist").innerHTML = rows
    .map((r) => {
      const state = r.rsi == null ? "" : r.rsi < entry ? "oversold" : r.rsi < exit ? "near" : "";
      const tag = r.held ? `<span class="tag held">HELD</span>` : state === "oversold" ? `<span class="tag">&lt;${entry}</span>` : "";
      return `<div class="coin ${state} ${r.held ? "held" : ""}" title="${esc(r.symbol)}${r.rsi == null ? "" : ` · RSI ${r.rsi.toFixed(1)}`}">
        <div class="coin-sym">${esc(r.symbol)}${tag}</div>
        <div class="coin-rsi">${r.rsi == null ? "RSI —" : `RSI ${r.rsi.toFixed(1)}`}</div>
        <div class="coin-bar"><span style="width:${Math.min(100, r.rsi ?? 0)}%"></span></div>
      </div>`;
    })
    .join("");
}

function renderTrades(state) {
  $("trades").innerHTML = table(
    [
      { label: "Time", render: (r) => when(r.timestamp) },
      { label: "Coin", render: (r) => `<span class="sym">${esc(r.symbol)}</span>` },
      { label: "Side", render: (r) => `<span class="pill ${esc(r.side)}">${esc(r.side)}</span>` },
      { label: "Price", num: true, render: (r) => price(r.price) },
      { label: "Qty", num: true, render: (r) => qty(r.quantity) },
      { label: "Notional", num: true, render: (r) => usd(r.notional_usd) },
      { label: "RSI", num: true, render: (r) => (r.rsi_at_trigger == null ? "—" : r.rsi_at_trigger.toFixed(1)) },
      { label: "P&L", num: true, cls: (r) => cls(r.realized_pnl_usd), render: (r) => (r.realized_pnl_usd == null ? "" : signedUsd(r.realized_pnl_usd)) },
    ],
    [...(state.trade_log ?? [])].reverse(),
    "No trades yet.",
  );
}

function renderClosed(state) {
  $("closed").innerHTML = table(
    [
      { label: "Coin", render: (r) => `<span class="sym">${esc(r.symbol)}</span>` },
      { label: "Opened", render: (r) => when(r.opened_at) },
      { label: "Closed", render: (r) => when(r.closed_at ?? r.timestamp) },
      { label: "Entry", num: true, render: (r) => price(r.avg_cost_basis ?? r.entry_price) },
      { label: "Exit", num: true, render: (r) => price(r.exit_price ?? r.price) },
      { label: "P&L", num: true, cls: (r) => cls(r.realized_pnl_usd), render: (r) => signedUsd(r.realized_pnl_usd ?? 0) },
    ],
    [...(state.closed_trades ?? [])].reverse(),
    "No closed trades yet. Positions close when RSI recovers to the exit threshold.",
  );
}

let last = null;

function render() {
  if (!last) return;
  const { state, history, lastScan } = last;
  const scan = scanBySymbol(lastScan);
  const d = derive(state, scan);
  $("subtitle").textContent = `Last run ${ago(state.last_run_at)} (${when(state.last_run_at)}) · ${state.run_count ?? 0} runs`;
  $("mode-badge").textContent = String(state.mode ?? "paper").toUpperCase();
  renderKpis(state, d);
  renderEquity(history, d, d.start);
  renderPositions(d);
  renderRules(state);
  renderWatchlist(state, scan, lastScan);
  renderTrades(state);
  renderClosed(state);
}

async function load() {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
    if (!body.state) throw new Error("No state file found in the repo yet.");
    last = body;
    $("error").hidden = true;
    render();
  } catch (err) {
    $("error").textContent = `Couldn't load data: ${err.message}`;
    $("error").hidden = false;
  }
}

document.querySelectorAll(".seg-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("is-on", b === btn));
    const table = btn.dataset.view === "table";
    $("equity-table").hidden = !table;
    $("equity-chart").hidden = table;
    if (!table) render();
  }),
);
$("refresh").addEventListener("click", load);
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 150);
});
setInterval(load, 5 * 60 * 1000);
load();

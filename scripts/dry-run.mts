// Runs one scan + rules pass against the seed state in data/ and prints the result.
// Writes nothing. Usage: npm run dry-run
import { readFileSync } from "node:fs";
import { runOnce } from "../netlify/lib/engine.mts";

const state = JSON.parse(readFileSync(new URL("../data/state.json", import.meta.url), "utf8"));
const { summary, events, lastScan } = await runOnce(state);
console.log(summary);
for (const e of events) console.log("  " + e);
const lowest = lastScan.rows.filter((r) => r.rsi != null).sort((a, b) => a.rsi - b.rsi).slice(0, 8);
console.table(lowest);

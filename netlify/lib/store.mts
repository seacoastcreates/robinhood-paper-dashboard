// Paper-trading data lives in one site-wide Blobs store, written only by the hourly
// function. The first time it's read and empty, it's seeded from data/*.json
// (runs 1-19, before the bot moved to Netlify).
import { getStore } from "@netlify/blobs";
import seedState from "../../data/state.json" with { type: "json" };
import seedHistory from "../../data/history.json" with { type: "json" };
import seedScan from "../../data/last_scan.json" with { type: "json" };
import type { HistoryPoint, State } from "./engine.mts";

const store = () => getStore({ name: "paper-trader", consistency: "strong" });

export async function loadAll(): Promise<{ state: State; history: HistoryPoint[]; lastScan: any }> {
  const s = store();
  const [state, history, lastScan] = await Promise.all([
    s.get("state", { type: "json" }),
    s.get("history", { type: "json" }),
    s.get("last_scan", { type: "json" }),
  ]);
  if (state) return { state, history: history ?? [], lastScan };
  return {
    state: structuredClone(seedState),
    history: structuredClone(seedHistory) as HistoryPoint[],
    lastScan: structuredClone(seedScan),
  };
}

export async function saveAll(state: State, history: HistoryPoint[], lastScan: any) {
  const s = store();
  await Promise.all([s.setJSON("state", state), s.setJSON("history", history), s.setJSON("last_scan", lastScan)]);
}

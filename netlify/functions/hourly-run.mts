import type { Config } from "@netlify/functions";
import { HISTORY_LIMIT, runOnce } from "../lib/engine.mts";
import { loadAll, saveAll } from "../lib/store.mts";

export default async () => {
  const { state, history } = await loadAll();
  const { lastScan, point, events, summary } = await runOnce(state);
  await saveAll(state, [...history, point].slice(-HISTORY_LIMIT), lastScan);
  console.log(summary);
  for (const e of events) console.log("  " + e);
};

export const config: Config = {
  schedule: "37 * * * *", // every hour at :37 UTC (also :37 past the hour in Eastern time)
};

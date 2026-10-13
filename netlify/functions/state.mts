// Returns { state, history, lastScan } for the dashboard.
import type { Config } from "@netlify/functions";
import { loadAll } from "../lib/store.mts";

export default async () => {
  try {
    return Response.json(await loadAll(), {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
};

export const config: Config = { path: "/api/state" };

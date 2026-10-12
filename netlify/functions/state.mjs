// Returns { state, history, lastScan } for the dashboard.
// In production it reads data/*.json from the private GitHub repo, so the hourly
// job's commits show up without a redeploy. With no GITHUB_TOKEN set (local dev),
// it reads the files from disk instead.
import { readFile } from "node:fs/promises";
import path from "node:path";

const FILES = {
  state: "data/state.json",
  history: "data/history.json",
  lastScan: "data/last_scan.json",
};

async function fromGitHub(file) {
  const repo = process.env.GITHUB_REPO;
  const ref = process.env.GITHUB_BRANCH || "main";
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${file}?ref=${ref}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github.raw+json",
      "User-Agent": "paper-dashboard",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${file}`);
  return res.json();
}

async function fromDisk(file) {
  try {
    return JSON.parse(await readFile(path.join(process.cwd(), file), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export default async () => {
  const load = process.env.GITHUB_TOKEN ? fromGitHub : fromDisk;
  try {
    const entries = await Promise.all(
      Object.entries(FILES).map(async ([key, file]) => [key, await load(file)]),
    );
    return Response.json(Object.fromEntries(entries), {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 502 });
  }
};

import { createHash } from "crypto";
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";

// Saved reading positions, one per USER per chapter URL.
//
// Storage:
//   • If UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set → Upstash Redis
//     (free tier, survives Render restarts, sleeps and redeploys).
//   • Otherwise → a local JSON file. NOTE: Render's free disk is wiped on every
//     restart/redeploy, so positions are lost there. Set up Upstash to fix that.

const REDIS_URL   = process.env["UPSTASH_REDIS_REST_URL"];
const REDIS_TOKEN = process.env["UPSTASH_REDIS_REST_TOKEN"];
const USE_REDIS   = Boolean(REDIS_URL && REDIS_TOKEN);
const FILE        = process.env["BOOKMARKS_FILE"] ?? join(process.cwd(), "data", "bookmarks.json");
const TTL_SECONDS = 60 * 60 * 24 * 90; // forget chapters untouched for 90 days (Redis only)

console.log(
  USE_REDIS
    ? "[bookmarks] using Upstash Redis — positions survive restarts ✅"
    : "[bookmarks] using a local file — positions are LOST on every Render restart. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to fix this."
);

export interface Bookmark {
  url:         string;
  chunkIndex:  number;
  totalChunks: number;
  title:       string;
}

function keyFor(userId: string, url: string): string {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 16);
  return `wct:bm:${userId}:${hash}`;
}

// ── Redis (Upstash REST) ──────────────────────────────────────────────────────

async function redis(command: (string | number)[]): Promise<unknown> {
  const res = await fetch(REDIS_URL!, {
    method:  "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body:    JSON.stringify(command),
  });
  const data = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
  if (!res.ok || data.error) throw new Error(data.error ?? `Redis HTTP ${res.status}`);
  return data.result;
}

// ── File fallback ─────────────────────────────────────────────────────────────

type Store = Record<string, Bookmark>;

async function loadFile(): Promise<Store> {
  try { return JSON.parse(await readFile(FILE, "utf8")) as Store; }
  catch { return {}; }
}

async function saveFile(store: Store): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(store, null, 2), "utf8");
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getBookmark(userId: string, url: string): Promise<Bookmark | null> {
  const key = keyFor(userId, url);
  if (USE_REDIS) {
    const raw = await redis(["GET", key]);
    return typeof raw === "string" ? (JSON.parse(raw) as Bookmark) : null;
  }
  return (await loadFile())[key] ?? null;
}

export async function saveBookmark(
  userId: string, url: string, chunkIndex: number, totalChunks: number, title: string,
): Promise<void> {
  const key      = keyFor(userId, url);
  const bookmark: Bookmark = { url, chunkIndex, totalChunks, title };
  if (USE_REDIS) {
    await redis(["SET", key, JSON.stringify(bookmark), "EX", TTL_SECONDS]);
    return;
  }
  const store = await loadFile();
  store[key] = bookmark;
  await saveFile(store);
}

export async function clearBookmark(userId: string, url: string): Promise<void> {
  const key = keyFor(userId, url);
  if (USE_REDIS) { await redis(["DEL", key]); return; }
  const store = await loadFile();
  if (key in store) { delete store[key]; await saveFile(store); }
}

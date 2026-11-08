import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";

// Tiny key-value store shared by bookmarks and voice preferences.
//   • UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN set → Upstash Redis (survives restarts)
//   • otherwise → a local JSON file (lost on every Render restart/redeploy)

const REDIS_URL   = process.env["UPSTASH_REDIS_REST_URL"];
const REDIS_TOKEN = process.env["UPSTASH_REDIS_REST_TOKEN"];
const USE_REDIS   = Boolean(REDIS_URL && REDIS_TOKEN);
const FILE        = process.env["STORE_FILE"] ?? process.env["BOOKMARKS_FILE"] ?? join(process.cwd(), "data", "store.json");

console.log(
  USE_REDIS
    ? "[storage] using Upstash Redis — saved positions and voices survive restarts ✅"
    : "[storage] using a local file — saved positions/voices are LOST on every Render restart. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to fix this."
);

// A slow or unreachable database must NEVER stall a command: every request has a short timeout, and after
// a failure Redis is skipped for a minute (reads count as "not found", writes are dropped with a warning).
const KV_TIMEOUT_MS = 4_000;
let downUntil = 0;
function markDown(err: unknown): void {
  const first = Date.now() >= downUntil;
  downUntil = Date.now() + 60_000;
  if (first) console.warn(`[storage] Redis didn't answer (${(err as Error).message}) — skipping it for 60s`);
}

async function redis(command: (string | number)[]): Promise<unknown> {
  const res = await fetch(REDIS_URL!, {
    signal:  AbortSignal.timeout(KV_TIMEOUT_MS),
    method:  "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body:    JSON.stringify(command),
  });
  const data = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
  if (!res.ok || data.error) throw new Error(data.error ?? `Redis HTTP ${res.status}`);
  return data.result;
}

type FileStore = Record<string, string>;

async function loadFile(): Promise<FileStore> {
  try { return JSON.parse(await readFile(FILE, "utf8")) as FileStore; }
  catch { return {}; }
}

async function saveFile(store: FileStore): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(store, null, 2), "utf8");
}

export async function kvGet(key: string): Promise<string | null> {
  if (USE_REDIS) {
    if (Date.now() < downUntil) return null;
    try {
      const raw = await redis(["GET", key]);
      return typeof raw === "string" ? raw : null;
    } catch (err) { markDown(err); return null; }
  }
  return (await loadFile())[key] ?? null;
}

export async function kvSet(key: string, value: string, ttlSeconds?: number): Promise<void> {
  if (USE_REDIS) {
    if (Date.now() < downUntil) return;
    try { await redis(ttlSeconds ? ["SET", key, value, "EX", ttlSeconds] : ["SET", key, value]); }
    catch (err) { markDown(err); }
    return;
  }
  const store = await loadFile();
  store[key] = value;
  await saveFile(store);
}

export async function kvDel(key: string): Promise<void> {
  if (USE_REDIS) {
    if (Date.now() < downUntil) return;
    try { await redis(["DEL", key]); } catch (err) { markDown(err); }
    return;
  }
  const store = await loadFile();
  if (key in store) { delete store[key]; await saveFile(store); }
}

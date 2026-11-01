import { createHash } from "crypto";
import { kvGet, kvSet, kvDel } from "./kv.js";

// Saved reading positions, one per USER per chapter URL (see kv.ts for where they live).

const TTL_SECONDS = 60 * 60 * 24 * 90; // forget chapters untouched for 90 days (Redis only)

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

export async function getBookmark(userId: string, url: string): Promise<Bookmark | null> {
  const raw = await kvGet(keyFor(userId, url));
  return raw ? (JSON.parse(raw) as Bookmark) : null;
}

export async function saveBookmark(
  userId: string, url: string, chunkIndex: number, totalChunks: number, title: string,
): Promise<void> {
  const bookmark: Bookmark = { url, chunkIndex, totalChunks, title };
  await kvSet(keyFor(userId, url), JSON.stringify(bookmark), TTL_SECONDS);
}

export async function clearBookmark(userId: string, url: string): Promise<void> {
  await kvDel(keyFor(userId, url));
}

import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";

// Saved reading positions, one per server. Stored as a small JSON file.
// NOTE: on Render's free tier the disk is wiped on every deploy/restart,
// so bookmarks only survive until the next restart unless you attach a disk
// and point BOOKMARKS_FILE at it.
const FILE = process.env["BOOKMARKS_FILE"] ?? join(process.cwd(), "data", "bookmarks.json");

export interface Bookmark {
  url:         string;
  chunkIndex:  number;
  totalChunks: number;
  title:       string;
}

type Store = Record<string, Bookmark>;

async function load(): Promise<Store> {
  try { return JSON.parse(await readFile(FILE, "utf8")) as Store; }
  catch { return {}; }
}

async function save(store: Store): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(store, null, 2), "utf8");
}

export async function getBookmark(guildId: string): Promise<Bookmark | null> {
  return (await load())[guildId] ?? null;
}

export async function saveBookmark(
  guildId: string, url: string, chunkIndex: number, totalChunks: number, title: string,
): Promise<void> {
  const store = await load();
  store[guildId] = { url, chunkIndex, totalChunks, title };
  await save(store);
}

export async function clearBookmark(guildId: string): Promise<void> {
  const store = await load();
  if (guildId in store) { delete store[guildId]; await save(store); }
}

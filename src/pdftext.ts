import axios from "axios";
import type { ChapterSection, ScrapedChapter } from "./scraper.js";

// Reads PDF and plain-text links (e.g. archive.org downloads) and turns them into paragraphs
// and chapters. Pick pages with a #pages=10-40 (or #page=10) at the end of the link.

const MAX_BYTES     = (Number(process.env["MAX_PDF_MB"])    || 80)  * 1024 * 1024;
const DEFAULT_PAGES = Number(process.env["MAX_PDF_PAGES"]) || 250;     // pages read per request when no range is given
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface FileRequest { kind: "pdf" | "txt"; fetchUrl: string; from: number | null; to: number | null }

function parseRequest(url: string): FileRequest | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  let path = u.pathname;
  try { path = decodeURIComponent(path); } catch { /* keep as is */ }
  const lower = path.toLowerCase();
  const kind  = lower.endsWith(".pdf") ? "pdf" : lower.endsWith(".txt") ? "txt" : null;
  if (!kind) return null;

  const m = u.hash.replace(/^#/, "").match(/(?:pages?|p)=(\d+)(?:\s*[-–:]\s*(\d*))?/i);
  const from = m ? parseInt(m[1]!, 10) : null;
  const to   = m && m[2] ? parseInt(m[2], 10) : null;
  u.hash = "";
  return { kind, fetchUrl: u.toString(), from, to };
}

// ─── Turning raw lines back into paragraphs ───────────────────────────────────

const END     = /[.!?…"”’)\]]$/;
const HEADING = /^(?:chapter|ch\.)\s+[\dIVXLC]+\b.*$|^(?:prologue|epilogue|interlude|afterword|foreword|preface|prelude)\b.*$|^(?:volume|vol\.|book|part|arc)\s+[\dIVXLC]+\b.*$/i;
const CHAPTER_ONLY = /^(?:chapter|ch\.)\s+[\dIVXLC]+[.:]?$/i;

/** Drop running headers/footers (a line repeated on many pages) and bare page numbers. */
function stripPageFurniture(pages: string[][]): string[][] {
  const norm = (l: string) => l.toLowerCase().replace(/\d+/g, "#");
  const edge = (lines: string[]) => [...lines.slice(0, 2), ...lines.slice(-2)];
  const counts = new Map<string, number>();
  for (const lines of pages) for (const e of new Set(edge(lines).map(norm))) counts.set(e, (counts.get(e) ?? 0) + 1);
  const limit = Math.max(3, Math.floor(pages.length * 0.4));

  return pages.map((lines) => lines.filter((l, i) => {
    if (!(i < 2 || i >= lines.length - 2)) return true;
    if (pages.length >= 3 && (counts.get(norm(l)) ?? 0) >= limit) return false;
    return !/^(?:page\s*)?\d{1,4}$/i.test(l.trim());
  }));
}

export function reflow(pages: string[][]): { paragraphs: string[]; sections: ChapterSection[] } {
  const lines = stripPageFurniture(pages).flat();
  const lens  = lines.map((l) => l.length).filter((n) => n > 20).sort((a, b) => a - b);
  const fullWidth = lens.length ? lens[Math.floor(lens.length * 0.9)]! : 80;      // roughly the width of a full line

  const paragraphs: string[] = [];
  const sections: ChapterSection[] = [];
  let buf = "";
  let prevLen = 0;
  const flush = () => { const t = buf.trim(); if (t) paragraphs.push(t); buf = ""; };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (line === "") { flush(); continue; }                                      // blank line = paragraph break

    // Chapter headings become their own paragraph and a navigable section
    if ((buf === "" || END.test(buf)) && line.length <= 80 && HEADING.test(line)) {
      flush();
      const next = lines[i + 1];
      if (CHAPTER_ONLY.test(line) && next && next.length <= 70 && !END.test(next) && !HEADING.test(next)) {
        line = `${line.replace(/[.:]$/, "")} – ${next}`;                         // "Chapter 12" + title on the next line
        i++;
      }
      sections.push({ title: line, startParagraph: paragraphs.length });
      paragraphs.push(line);
      prevLen = 0;
      continue;
    }

    if (!buf) buf = line;
    else if (buf.endsWith("-") && /^[a-z]/.test(line)) buf = buf.slice(0, -1) + line;   // "pre-" + "vious" → "previous"
    else if (END.test(buf) && (/^["“‘]/.test(line) || (prevLen < fullWidth * 0.9 && /^[A-Z"“‘'(\[0-9]/.test(line)))) { flush(); buf = line; }   // new dialogue, or a sentence ending on a not-full line
    else buf += " " + line;
    prevLen = line.length;
  }
  flush();
  return { paragraphs, sections };
}

// ─── PDF text ─────────────────────────────────────────────────────────────────

interface TextItem { str?: string; hasEOL?: boolean; transform?: number[] }

function itemsToLines(items: TextItem[]): string[] {
  const lines: string[] = [];
  let cur = "";
  let lastY: number | undefined;
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    const y = Array.isArray(it.transform) ? it.transform[5] : undefined;
    if (cur && y !== undefined && lastY !== undefined && Math.abs(y - lastY) > 2) { lines.push(cur); cur = ""; }
    cur += it.str;
    if (y !== undefined) lastY = y;
    if (it.hasEOL) { lines.push(cur); cur = ""; }
  }
  if (cur) lines.push(cur);
  return lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}

async function readPdf(buf: Uint8Array, req: FileRequest): Promise<{ pages: string[][]; total: number; from: number; to: number; title: string }> {
  const { getDocumentProxy, getMeta } = await import("unpdf");
  const pdf   = await getDocumentProxy(buf);
  const total = pdf.numPages as number;

  const from = Math.min(Math.max(1, req.from ?? 1), total);
  const to   = Math.min(total, req.to ?? total, from + DEFAULT_PAGES - 1);

  const pages: string[][] = [];
  for (let p = from; p <= to; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    pages.push(itemsToLines(content.items as TextItem[]));
    page.cleanup();
    await new Promise<void>((r) => setImmediate(r));          // let audio for other servers keep flowing
  }

  let title = "";
  try { title = String(((await getMeta(pdf)).info as Record<string, unknown>)?.["Title"] ?? "").trim(); } catch { /* no metadata */ }
  return { pages, total, from, to, title };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

function nameFromUrl(fetchUrl: string): string {
  const last = new URL(fetchUrl).pathname.split("/").pop() ?? "Document";
  try { return decodeURIComponent(last).replace(/\.(pdf|txt)$/i, "").replace(/[_]+/g, " ").trim() || "Document"; }
  catch { return last.replace(/\.(pdf|txt)$/i, ""); }
}

/** Returns null when the link isn't a .pdf/.txt file (the normal web-page scraper handles those). */
export async function scrapeFileUrl(url: string): Promise<ScrapedChapter | null> {
  const req = parseRequest(url);
  if (!req) return null;

  let data: ArrayBuffer;
  try {
    const res = await axios.get<ArrayBuffer>(req.fetchUrl, {
      responseType: "arraybuffer", timeout: 120_000, maxContentLength: MAX_BYTES, maxBodyLength: MAX_BYTES,
      headers: { "User-Agent": UA },
    });
    data = res.data;
  } catch (err) {
    const msg = (err as Error).message;
    if (/maxContentLength|exceeded/i.test(msg)) throw new Error(`That file is larger than ${Math.round(MAX_BYTES / 1048576)} MB.`);
    throw new Error(`Couldn't download that file (${msg}).`);
  }

  if (req.kind === "txt") {
    const { paragraphs, sections } = reflow([Buffer.from(data).toString("utf8").split(/\r?\n/).map((l) => l.trim())]);
    if (paragraphs.length === 0) throw new Error("That text file is empty.");
    return { title: nameFromUrl(req.fetchUrl), content: paragraphs.join("\n\n"), url, paragraphs, sections };
  }

  let read;
  try { read = await readPdf(new Uint8Array(data), req); }
  catch (err) { throw new Error(`Couldn't read that PDF (${(err as Error).message}).`); }

  const { paragraphs, sections } = reflow(read.pages);
  const chars = paragraphs.reduce((n, p) => n + p.length, 0);
  if (chars < 200) {
    throw new Error("That PDF has no readable text — it's probably scanned images, which would need OCR.");
  }

  const base  = read.title || nameFromUrl(req.fetchUrl);
  const title = read.from === 1 && read.to === read.total ? base : `${base} (pages ${read.from}–${read.to} of ${read.total})`;
  return { title, content: paragraphs.join("\n\n"), url, paragraphs, sections };
}

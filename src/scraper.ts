import axios from "axios";
import * as cheerio from "cheerio";
import { scrapeFileUrl } from "./pdftext.js";

export interface ChapterSection {
  title: string;
  startParagraph: number; // index into paragraphs[]
}

export interface ScrapedChapter {
  title: string;
  content: string;
  url: string;
  paragraphs: string[];
  /** Detected sections/chapters within the page (headings, scene breaks, hr). */
  sections: ChapterSection[];
}

const SELECTORS_BY_HOST: Record<string, { content: string[]; title: string[] }> = {
  "witchculttranslations.com": {
    title: [".entry-title", "h1.title", "h1"],
    content: [".entry-content", ".post-content", "article"],
  },
  "witchculttranslation.com": {
    title: [".entry-title", "h1.title", "h1"],
    content: [".entry-content", ".post-content", "article"],
  },
  "witchcult.com": {
    title: [".entry-title", "h1"],
    content: [".entry-content", ".post-content"],
  },
  "archiveofourown.org": {
    title: ["h2.title.heading", "h3.title", "h2.title"],
    content: [".userstuff[role='article']", "#chapters .userstuff", ".userstuff"],
  },
};

const GENERIC_CONTENT_SELECTORS = [
  "article .entry-content",
  ".entry-content",
  ".post-content",
  ".chapter-content",
  ".content-text",
  "article",
  ".post-body",
  "main p",
];

const GENERIC_TITLE_SELECTORS = [
  ".entry-title",
  ".post-title",
  ".chapter-title",
  "h1.title",
  "h1",
];

const SKIP_TAGS = new Set(["script", "style", "nav", "header", "footer", "aside", "noscript"]);

function cleanText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Check if a paragraph is a scene-divider (---, ***, ~~~, etc.) */
function isSceneDivider(text: string): boolean {
  return /^[-*~=✦◆·•]{3,}$/.test(text.replace(/\s/g, ""));
}

// AO3 heading text that is structural metadata, not story content
const AO3_META_HEADINGS = /^(notes?|summary|end notes?|beginning notes?|author.?s note|works inspired)/i;

interface ExtractResult {
  paragraphs: string[];
  sections: ChapterSection[];
}

/** True for real pictures; false for emoji, icons, avatars, buttons and 1px trackers. */
function isContentImage($: cheerio.CheerioAPI, el: any): boolean {
  const img = $(el);
  const src = `${img.attr("src") ?? ""} ${img.attr("data-src") ?? ""} ${img.attr("data-lazy-src") ?? ""}`.toLowerCase();
  if (!src.trim()) return false;
  if (/emoji|smilies|gravatar|avatar|spacer|pixel|tracking|stat\.|logo|icon|sprite|badge|button|banner-ad/.test(src)) return false;
  if (/(^|\s)(wp-smiley|emoji|avatar|icon)(\s|$)/i.test(img.attr("class") ?? "")) return false;
  const w = parseInt(img.attr("width") ?? "", 10);
  const h = parseInt(img.attr("height") ?? "", 10);
  if ((Number.isFinite(w) && w > 0 && w < 60) || (Number.isFinite(h) && h > 0 && h < 60)) return false;
  return true;
}

/** Text of a bullet/numbered item (its own text only — nested lists and <p> children are read separately). */
function listItemText($: cheerio.CheerioAPI, el: any): string {
  const item = $(el);
  if (item.find("p, h1, h2, h3, h4, h5, h6").length > 0) return "";
  const own = cleanText(item.clone().find("ul, ol").remove().end().text());
  if (!own) return "";
  const list = item.parent();
  if (list.is("ol")) {
    const start = parseInt(list.attr("start") ?? "1", 10) || 1;
    return `${start + item.prevAll("li").length}. ${own}`;
  }
  return own;
}

function extractParagraphs(
  $: cheerio.CheerioAPI,
  contentEl: cheerio.Cheerio<any>,
  opts: { hrAsSceneBreak: boolean; includeListItems?: boolean } = { hrAsSceneBreak: true },
): ExtractResult {
  const paragraphs: string[] = [];
  const sections: ChapterSection[] = [];
  let partCounter = 0;

  contentEl.find("p, li, h1, h2, h3, h4, h5, h6, hr, img").each((_, el) => {
    const tag = (el as any).tagName?.toLowerCase() ?? "";
    if (SKIP_TAGS.has(tag)) return;

    // Pictures: say so (no sound or marker) — but not emoji, avatars, icons or tracking pixels
    if (tag === "img") {
      if (isContentImage($, el)) paragraphs.push("Image file.");
      return;
    }

    // Horizontal rule — only treat as scene break on non-AO3 sites
    if (tag === "hr") {
      if (opts.hrAsSceneBreak && paragraphs.length > 0) {
        partCounter++;
        sections.push({ title: `Part ${partCounter}`, startParagraph: paragraphs.length });
      }
      return;
    }

    const text = tag === "li" ? listItemText($, el) : cleanText($(el).text());
    if (!text) return;

    // Heading = named chapter/section boundary
    if (/^h[1-6]$/.test(tag) && text.length < 200) {
      // Skip AO3 structural metadata headings
      if (AO3_META_HEADINGS.test(text)) return;
      // Mark boundary at the current paragraph position
      sections.push({ title: text, startParagraph: paragraphs.length });
      // Also include heading as a spoken paragraph so TTS announces it
      if (text.length > 3) paragraphs.push(text);
      return;
    }

    if (text.length < 2) return;

    // Scene divider pattern (text-based, works everywhere)
    if (isSceneDivider(text)) {
      if (paragraphs.length > 0) {
        partCounter++;
        sections.push({ title: `Part ${partCounter}`, startParagraph: paragraphs.length });
      }
      return;
    }

    paragraphs.push(text);
  });

  // If no paragraphs found via <p> tags, fall back to full text split
  if (paragraphs.length === 0) {
    const fullText = cleanText(contentEl.text());
    const lines = fullText.split(/\n+/).filter((l) => l.trim().length > 20);
    paragraphs.push(...lines);
  }

  return { paragraphs, sections };
}

// ─── Fetching pages (browser-like, with backup routes when a site refuses this server) ──────────

const READER_BASE  = process.env["READER_BASE"]  ?? "https://r.jina.ai/";                 // a page-reader service
const WAYBACK_BASE = process.env["WAYBACK_BASE"] ?? "https://web.archive.org/web/2id_/";   // the Internet Archive's saved copy
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// What a real browser sends. Sites like AO3 reject bare, bot-looking requests with 403.
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":                CHROME_UA,
  Accept:                      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language":           "en-US,en;q=0.9",
  "Accept-Encoding":           "gzip, deflate, br",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest":            "document",
  "Sec-Fetch-Mode":            "navigate",
  "Sec-Fetch-Site":            "none",
  "Sec-Fetch-User":            "?1",
  "Sec-Ch-Ua":                 '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "Sec-Ch-Ua-Mobile":          "?0",
  "Sec-Ch-Ua-Platform":        '"Windows"',
  "Cache-Control":             "max-age=0",
};

interface Fetched { status: number; html: string; retryAfter: number | null }

async function getOnce(url: string, headers: Record<string, string>, timeout: number): Promise<Fetched> {
  try {
    const res = await axios.get<string>(url, {
      headers, timeout, responseType: "text", transformResponse: (d) => d, maxRedirects: 5, validateStatus: () => true,
    });
    const ra = parseInt(String(res.headers["retry-after"] ?? ""), 10);
    return { status: res.status, html: typeof res.data === "string" ? res.data : String(res.data ?? ""), retryAfter: Number.isFinite(ra) ? ra : null };
  } catch {
    return { status: 0, html: "", retryAfter: null };           // network error or timeout
  }
}

const CHALLENGE = /just a moment|cf-chl|attention required|enable javascript and cookies|checking your browser|verify you are human|access denied|retry later|rate limit/i;
const looksBlocked = (html: string): boolean => html.length < 6000 && CHALLENGE.test(html);       // real chapter pages are much bigger
const hasContent = (html: string, ao3: boolean): boolean =>
  ao3 ? /userstuff|id="workskin"|class="chapter/i.test(html) : html.length > 1500 && !looksBlocked(html);

export async function fetchPageHtml(url: string, opts: { ao3?: boolean; extraHeaders?: Record<string, string> } = {}): Promise<string> {
  const ao3 = opts.ao3 === true;
  const [base = url, hash = ""] = url.split("#");
  // AO3 puts adult works behind a click-through page unless this flag is set
  const target = ao3 && !/[?&]view_adult=/.test(base) ? `${base}${base.includes("?") ? "&" : "?"}view_adult=true${hash ? `#${hash}` : ""}` : url;

  let res = await getOnce(target, { ...BROWSER_HEADERS, ...(opts.extraHeaders ?? {}) }, 12_000);
  if ([429, 502, 503, 504].includes(res.status)) {                // busy or rate-limited: wait a moment and try once more
    await new Promise((r) => setTimeout(r, Math.min(5_000, (res.retryAfter ?? 2) * 1000)));
    res = await getOnce(target, { ...BROWSER_HEADERS, ...(opts.extraHeaders ?? {}) }, 12_000);
  }
  if (res.status === 200 && hasContent(res.html, ao3)) return res.html;

  // The site is refusing this server — try the backup routes
  const host  = new URL(url).hostname.replace("www.", "");
  const notes = [`direct: ${res.status ? `HTTP ${res.status}` : "no answer"}`];
  const backups: Array<[string, string, Record<string, string>]> = [
    ["page reader",  `${READER_BASE}${target}`,  { "X-Return-Format": "html", Accept: "text/html", "User-Agent": CHROME_UA }],
    ["web archive",  `${WAYBACK_BASE}${url}`,    { "User-Agent": CHROME_UA }],
  ];
  for (const [name, backupUrl, headers] of backups) {
    const r = await getOnce(backupUrl, headers, 20_000);
    if (r.status === 200 && hasContent(r.html, ao3)) {
      console.log(`[scrape] ${host}: direct request failed (${notes[0]}) — loaded it through the ${name} instead`);
      return r.html;
    }
    notes.push(`${name}: ${r.status ? `HTTP ${r.status}` : "no answer"}`);
  }

  const status = res.status || "no answer";
  throw new Error(
    (ao3
      ? `AO3 is refusing requests from this server (${status}) and the backup routes couldn't load it either. `
      : `${host} refused the request (${status}) and the backup routes couldn't load it either. `) +
    `This usually clears up on its own — try again in a few minutes, and make sure the link is public. (${notes.join("; ")})`
  );
}

function extraConfig(hostname: string): { headers?: Record<string, string>; params?: Record<string, string> } {
  if (hostname === "archiveofourown.org") {
    return {
      headers: { Cookie: "view_adult=true" },
    };
  }
  return {};
}

/** Dedicated AO3 extractor. Walks each div.chapter in order, pulling the
 *  h3.title from the chapter preface and the story text from .userstuff.module.
 *  Notes, summaries, end-notes, and converter credits are never touched. */
function extractAo3(
  $: cheerio.CheerioAPI,
  workTitle: string,
): { title: string; paragraphs: string[]; sections: ChapterSection[] } {
  const allParagraphs: string[] = [];
  const sections: ChapterSection[] = [];

  const chapterDivs = $("#chapters div.chapter[id^='chapter-']").toArray();

  // Single-chapter page — AO3 individual chapter URL
  // The chapter div exists but there's only one; still extract correctly.
  for (const chDiv of chapterDivs) {
    const chEl = $(chDiv);

    // Chapter title: first h3.title inside the first .chapter.preface.group
    // (not the end-notes preface that also lives inside the same chapter div)
    const prefaceEl  = chEl.children(".chapter.preface.group").first();
    const rawTitle   = cleanText(prefaceEl.find("h3.title").first().text());
    const chTitle    = rawTitle || `Chapter ${sections.length + 1}`;

    // Story content only — ignore everything outside .userstuff.module
    const userstuff  = chEl.children(".userstuff.module, .userstuff[role='article']").first();
    if (!userstuff.length) continue;

    // Remove any stray notes/credits that snuck inside userstuff
    userstuff.find(
      ".notes, p:contains('AOYeet'), p:contains('converted for free')"
    ).remove();

    // Extract paragraphs (no hr-as-scene-break — AO3 uses hr as narrative breaks too,
    // but we handle them as Part N scene breaks within each chapter)
    const { paragraphs: chParas, sections: chSections } = extractParagraphs(
      $, userstuff, { hrAsSceneBreak: true }
    );
    if (chParas.length === 0) continue;

    // Record this chapter as a section boundary
    const startParagraph = allParagraphs.length;
    sections.push({ title: chTitle, startParagraph });

    // Offset inner scene-break sections relative to the full paragraph array
    for (const s of chSections) {
      // Skip index-0 offsets — those duplicate the chapter boundary itself
      if (s.startParagraph === 0) continue;
      sections.push({ title: `${chTitle} — ${s.title}`, startParagraph: startParagraph + s.startParagraph });
    }

    allParagraphs.push(...chParas);
  }

  return { title: workTitle, paragraphs: allParagraphs, sections };
}

// ─── Google Docs ─────────────────────────────────────────────────────────────
// Works for docs shared as "Anyone with the link can view" and for docs
// "Published to the web" (/d/e/.../pub). Private docs can't be read.

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function googleDocUrl(url: string): { fetchUrl: string } | null {
  const u = new URL(url);
  if (u.hostname !== "docs.google.com") return null;
  // Published-to-web doc: /document/d/e/<pubId>/pub
  const pub = u.pathname.match(/^\/document\/d\/e\/([^/]+)/);
  if (pub) return { fetchUrl: `https://docs.google.com/document/d/e/${pub[1]}/pub` };
  const m = u.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  return { fetchUrl: `https://docs.google.com/document/d/${m[1]}/export?format=html` };
}

async function scrapeGoogleDoc(url: string, fetchUrl: string): Promise<ScrapedChapter> {
  const res = await axios.get(fetchUrl, {
    headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml" },
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: (s) => s < 500,
  });

  const finalUrl: string = res.request?.res?.responseUrl ?? fetchUrl;
  const html = typeof res.data === "string" ? res.data : String(res.data);
  const needsLogin =
    res.status === 401 || res.status === 403 || res.status === 404 ||
    finalUrl.includes("accounts.google.com") ||
    /ServiceLogin|accounts\.google\.com\/v3\/signin/.test(html.slice(0, 5000));
  if (needsLogin) {
    throw new Error(
      "That Google Doc isn't public. Open it → Share → General access → \"Anyone with the link\" (Viewer), then try again."
    );
  }

  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  // Published docs wrap content in #contents; exported docs use <body>
  const root = $("#contents").length ? $("#contents").first() : $("body").first();

  const title =
    cleanText($("title").first().text()).replace(/\s*-\s*Google Docs$/i, "") ||
    cleanText($("p.title").first().text()) ||
    "Google Doc";

  const { paragraphs, sections } = extractParagraphs($, root, { hrAsSceneBreak: true, includeListItems: true });
  if (paragraphs.length === 0) {
    throw new Error("That Google Doc looks empty (or only contains images).");
  }
  return { title, content: paragraphs.join("\n\n"), url, paragraphs, sections };
}

export async function scrapeChapter(url: string): Promise<ScrapedChapter> {
  const gdoc = googleDocUrl(url);
  if (gdoc) return scrapeGoogleDoc(url, gdoc.fetchUrl);

  const file = await scrapeFileUrl(url);          // direct .pdf / .txt links
  if (file) return file;

  const hostname = new URL(url).hostname.replace("www.", "");
  const extra    = extraConfig(hostname);

  const html = await fetchPageHtml(url, { ao3: hostname === "archiveofourown.org", ...(extra.headers ? { extraHeaders: extra.headers } : {}) });

  const $ = cheerio.load(html);

  $(
    "script, style, nav, header, footer, aside, noscript, " +
    ".sharedaddy, .jp-relatedposts, .comments-area, #comments, " +
    "#header, #footer, #main > .wrapper > .message, " +
    ".kudos, .bookmarks, .hits, #kudos, .comment_count"
  ).remove();

  // ── AO3: use dedicated per-chapter extractor ──────────────────────────────
  if (hostname === "archiveofourown.org") {
    const workTitle = cleanText($("h2.title.heading").first().text())
      || $("title").text().split("|")[0]?.trim()
      || "Chapter";
    const { title, paragraphs, sections } = extractAo3($, workTitle);
    if (paragraphs.length === 0) {
      throw new Error("Could not extract readable content from that AO3 page. Make sure it's a public chapter or full-work URL.");
    }
    return { title, content: paragraphs.join("\n\n"), url, paragraphs, sections };
  }

  // ── Generic extraction for non-AO3 sites ─────────────────────────────────
  const siteSelectors = SELECTORS_BY_HOST[hostname];

  let title = "";
  const titleSelectors = siteSelectors?.title ?? GENERIC_TITLE_SELECTORS;
  for (const sel of titleSelectors) {
    const el = $(sel).first();
    if (el.length && el.text().trim()) {
      title = cleanText(el.text());
      break;
    }
  }
  if (!title) title = $("title").text().split("|")[0]?.trim() ?? "Chapter";

  let paragraphs: string[] = [];
  let sections: ChapterSection[] = [];
  const contentSelectors = siteSelectors?.content ?? GENERIC_CONTENT_SELECTORS;

  for (const sel of contentSelectors) {
    const el = $(sel).first();
    if (el.length) {
      const found = extractParagraphs($, el, { hrAsSceneBreak: true });
      if (found.paragraphs.length >= 3) {
        paragraphs = found.paragraphs;
        sections   = found.sections;
        break;
      }
    }
  }

  if (paragraphs.length === 0) {
    throw new Error(
      "Could not extract readable content from that page. " +
      "Make sure it's a public chapter URL (AO3, WCT, or similar)."
    );
  }

  return {
    title,
    content: paragraphs.join("\n\n"),
    url,
    paragraphs,
    sections,
  };
}

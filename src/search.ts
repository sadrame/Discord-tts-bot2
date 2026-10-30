// Typo-tolerant paragraph search used by /find and !find.
//
// Strategy:
//   1. Exact (accent/punctuation/case-insensitive) phrase match.
//   2. If nothing matches exactly, fall back to fuzzy word matching:
//      every query word must match some word in the paragraph, allowing
//      small spelling mistakes and word prefixes ("hero" matches "heroine").

export interface SearchResult {
  matches: number[];   // paragraph indices in document order
  fuzzy:   boolean;    // true when the fuzzy fallback produced the results
}

function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")       // strip accents
    .toLowerCase()
    .replace(/['’‘`´]/g, "")               // don't → dont
    .replace(/[^\p{L}\p{N}\s]/gu, " ")     // punctuation → space
    .replace(/\s+/g, " ")
    .trim();
}

/** Max allowed edit distance for a query word of this length. */
function allowedEdits(len: number): number {
  if (len <= 3) return 0;
  if (len <= 6) return 1;
  return 2;
}

/** True if the edit distance between a and b is <= max.
 *  Uses Damerau-Levenshtein (optimal string alignment) so swapped letters
 *  ("wietz" vs "weitz") count as ONE typo instead of two. */
function withinDistance(a: string, b: string, max: number): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > max) return false;

  let prev2: number[] = [];
  let prev:  number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  let prevMin = 0;

  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (
        i > 1 && j > 1 &&
        a.charCodeAt(i - 1) === b.charCodeAt(j - 2) &&
        a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
      ) {
        v = Math.min(v, prev2[j - 2]! + 1);   // transposition
      }
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    // transpositions look two rows back, so only give up when BOTH rows are over budget
    if (rowMin > max && prevMin > max) return false;
    prev2 = prev;
    prev = cur;
    prevMin = rowMin;
  }
  return prev[b.length]! <= max;
}

function wordMatches(word: string, q: string): boolean {
  if (word === q) return true;
  if (q.length >= 4 && word.startsWith(q)) return true;     // partial word
  const edits = allowedEdits(q.length);
  return edits > 0 && withinDistance(word, q, edits);
}

export function searchParagraphs(paragraphs: string[], rawQuery: string): SearchResult {
  const q = normalize(rawQuery);
  if (!q) return { matches: [], fuzzy: false };

  const norm = paragraphs.map(normalize);

  // 1) exact phrase
  const exact: number[] = [];
  for (let i = 0; i < norm.length; i++) {
    if (norm[i]!.includes(q)) exact.push(i);
  }
  if (exact.length > 0) return { matches: exact, fuzzy: false };

  // 2) fuzzy words
  const qWords = q.split(" ");
  const need   = qWords.length <= 3 ? qWords.length : Math.ceil(qWords.length * 0.7);
  const fuzzy: number[] = [];
  for (let i = 0; i < norm.length; i++) {
    const words = norm[i]!.split(" ");
    let hit = 0;
    for (const qw of qWords) {
      if (words.some((w) => wordMatches(w, qw))) hit++;
    }
    if (hit >= need) fuzzy.push(i);
  }
  return { matches: fuzzy, fuzzy: true };
}

/** Index (into `matches`) of the first match at/after the current paragraph, wrapping to 0. */
export function pickStartPosition(matches: number[], currentParagraph: number): number {
  const idx = matches.findIndex((m) => m >= currentParagraph);
  return idx === -1 ? 0 : idx;
}

/** Short preview of a paragraph, centred on the query when it appears literally. */
export function snippetFor(paragraph: string, query: string, maxLen = 90): string {
  const text = paragraph.replace(/\s+/g, " ").trim();
  if (text.length <= maxLen) return text;
  const at = text.toLowerCase().indexOf(query.trim().toLowerCase());
  const start = at === -1 ? 0 : Math.max(0, at - Math.floor((maxLen - query.length) / 2));
  const end = Math.min(text.length, start + maxLen);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

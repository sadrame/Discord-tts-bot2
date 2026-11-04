import { dividerType } from "./markers.js";
import type { ChapterSection } from "./scraper.js";

// Tidies the gaps in a document before it's read, so the bot never sits in silence:
//  • blank paragraphs — including ones made of invisible characters (zero-width spaces, braille
//    blanks, soft hyphens…) that look empty but aren't — are dropped
//  • runs of the same kind of gap collapse to ONE: five "……" lines → one pause, two "△▼△▼" → one scene break
//  • stretches of spaces/newlines inside a paragraph become a single space; "........" → "..."

// Characters that render as nothing but aren't matched by \s
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0]/g;
const HAS_WORDS = /[\p{L}\p{N}]/u;

function normalize(p: string): string {
  return p.replace(INVISIBLE, "").replace(/[\s\u00a0]+/g, " ").trim();
}

/** Very long dot / ellipsis / dash runs make the voice drag; shorten them (only in real sentences). */
function shortenPunctuation(t: string): string {
  return t.replace(/\.{4,}/g, "...").replace(/…{2,}/g, "…").replace(/([—–])\1{1,}/g, "$1");
}

export interface TidyResult {
  paragraphs: string[];
  sections:   ChapterSection[];
  removed:    number;
}

export function tidyChapter(paragraphs: string[], sections: ChapterSection[] = []): TidyResult {
  const kept: string[] = [];
  const keptBefore: number[] = [];          // keptBefore[i] = how many paragraphs were kept before original paragraph i
  let prevKind: string | null = null;

  for (let i = 0; i < paragraphs.length; i++) {
    keptBefore.push(kept.length);
    const t = normalize(paragraphs[i] ?? "");
    if (!t) continue;                                          // blank / invisible-only → gone

    const hasWords = HAS_WORDS.test(t);
    const kind     = hasWords ? "text" : (dividerType(t) ?? "pause");
    if (!hasWords && kind === prevKind) continue;              // same kind of gap twice in a row → keep one

    kept.push(hasWords ? shortenPunctuation(t) : t);
    prevKind = kind;
  }

  if (kept.length === 0) return { paragraphs, sections, removed: 0 };   // nothing readable — leave it to the caller

  const remapped = sections.map((s) => ({
    ...s,
    startParagraph: Math.min(keptBefore[s.startParagraph] ?? kept.length - 1, kept.length - 1),
  }));
  return { paragraphs: kept, sections: remapped, removed: paragraphs.length - kept.length };
}

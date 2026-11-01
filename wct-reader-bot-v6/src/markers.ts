import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { textToMp3File, cleanupFile } from "./tts.js";
import { concatAudio, silenceFile, synthTones } from "./media.js";
import type { ToneSpec } from "./media.js";
import type { VoiceOption } from "./voices.js";

// Chapter markers: divider rows like "※ ※ ※ ※" and "△▼△▼△▼△" have no words, so a voice would
// read them as silence (or fail on empty audio). Here they become announced events — a chime,
// a spoken cue, or both — and translator's notes between ※ rows can optionally be skipped.

export type MarkerKind = "scene" | "break" | "note-start" | "note-end" | "chapter-end";
export type MarkerMode = "chime" | "voice" | "both" | "off";
export type NotesMode  = "read" | "skip";

export const MARKER_MODES: MarkerMode[] = ["chime", "voice", "both", "off"];

// ─── Detecting markers in the scraped paragraphs ──────────────────────────────

const HAS_WORDS   = /[\p{L}\p{N}]/u;
const REF_ROW     = /^[\s\u3000]*(?:※[\s\u3000]*){3,}$/u;                        // ※ ※ ※ ※ …
const DECORATIVE  = /[△▲▽▼◇◆◈□■○●◎☆★＊♦♢◊✦✧❖]/u;                                  // marks that only ever decorate
const RULE_LINE   = /^[\s\u3000*＊#＃~〜=＝_＿\-ー―─━・·•]+$/u;                    // *** --- === ~~~ ・・・
const TL_NOTE     = /^\s*(?:tl|t\/l|translator'?s?|tn|t\/n|author'?s?|editor'?s?|ed)\.?\s*(?:note|notes)\b/i;

/** What a paragraph is, if it's a divider rather than story text. */
export function dividerType(text: string): "ref" | "scene" | null {
  const t = text.trim();
  if (!t || HAS_WORDS.test(t)) return null;
  if (REF_ROW.test(t)) return "ref";
  if (DECORATIVE.test(t)) return "scene";
  if (RULE_LINE.test(t) && t.replace(/[\s\u3000]/g, "").length >= 3) return "scene";
  return null;    // plain punctuation like "……" or "?!" stays a pause, not a scene break
}

export interface ParagraphPlan {
  kind:   MarkerKind | null;   // set → this paragraph is a marker
  inNote: boolean;             // inside a translator's note (between two ※ rows)
}

export function planParagraphs(paragraphs: string[]): ParagraphPlan[] {
  const plans: ParagraphPlan[] = paragraphs.map(() => ({ kind: null, inNote: false }));
  const isText = (i: number) => dividerType(paragraphs[i]!) === null && HAS_WORDS.test(paragraphs[i]!);

  const nextTextIndex = (from: number): number => {
    for (let j = from; j < paragraphs.length; j++) if (isText(j)) return j;
    return -1;
  };

  let inNote = false;
  for (let i = 0; i < paragraphs.length; i++) {
    const type = dividerType(paragraphs[i]!);

    if (type === "ref") {
      if (inNote) {
        // closing row — if nothing follows, this is the end of the chapter
        plans[i] = { kind: nextTextIndex(i + 1) === -1 ? "chapter-end" : "note-end", inNote: true };
        inNote = false;
      } else {
        const next = nextTextIndex(i + 1);
        if (next !== -1 && TL_NOTE.test(paragraphs[next]!)) { plans[i] = { kind: "note-start", inNote: true }; inNote = true; }
        else if (next === -1)                               plans[i] = { kind: "chapter-end", inNote: false };
        else                                                plans[i] = { kind: "break",       inNote: false };
      }
    } else if (type === "scene") {
      plans[i] = { kind: "scene", inNote };
    } else {
      plans[i]!.inNote = inNote;
    }
  }
  return plans;
}

// ─── Marker chunks (what goes into the reader's chunk list) ───────────────────

const PREFIX = "\uE000MARK:";

export function markerChunk(kind: MarkerKind): string {
  return PREFIX + kind;
}

export function parseMarkerChunk(text: string): MarkerKind | null {
  if (!text.startsWith(PREFIX)) return null;
  const kind = text.slice(PREFIX.length);
  return kind === "scene" || kind === "break" || kind === "note-start" || kind === "note-end" || kind === "chapter-end" ? kind : null;
}

// ─── The sounds ───────────────────────────────────────────────────────────────

const SPOKEN: Record<MarkerKind, string> = {
  "scene":       "Scene break.",
  "break":       "Section break.",
  "note-start":  "Translator's note.",
  "note-end":    "End of note.",
  "chapter-end": "End of chapter.",
};

// Each kind has its own melody so you can tell them apart by ear
const TONES: Record<MarkerKind, ToneSpec[]> = {
  "scene":       [{ freq: 523, dur: 0.45 }, { freq: 784, dur: 0.6 }],                                   // low → high  (ding-ding, rising)
  "break":       [{ freq: 659, dur: 0.8 }],                                                             // one soft bell
  "note-start":  [{ freq: 988, dur: 0.22 }, { freq: 988, dur: 0.22 }, { freq: 988, dur: 0.4 }],         // three quick pings
  "note-end":    [{ freq: 784, dur: 0.4 }, { freq: 587, dur: 0.6 }],                                    // high → low  (falling)
  "chapter-end": [{ freq: 784, dur: 0.45 }, { freq: 659, dur: 0.45 }, { freq: 523, dur: 1.0 }],         // slow falling cadence
};

const chimeCache = new Map<MarkerKind, Buffer>();

/** A fresh temp copy of the chime (the player deletes files after use, so never share one path). */
async function chimeFile(kind: MarkerKind): Promise<string> {
  let buf = chimeCache.get(kind);
  if (!buf) {
    const made = await synthTones(TONES[kind]);
    buf = await readFile(made);
    await cleanupFile(made);
    chimeCache.set(kind, buf);
  }
  const out = join(tmpdir(), `wct-chime-${randomUUID()}.mp3`);
  await writeFile(out, buf);
  return out;
}

/** Audio for a marker, in the chosen style. Never throws — worst case it's a moment of silence. */
export async function markerToFile(kind: MarkerKind, mode: MarkerMode, voice: VoiceOption): Promise<string> {
  try {
    if (mode === "off")   return await silenceFile(0.2);
    if (mode === "chime") return await chimeFile(kind);

    const spoken = await textToMp3File(SPOKEN[kind], voice);
    if (mode === "voice") return spoken;

    const chime = await chimeFile(kind);
    try { return await concatAudio([{ file: chime }, { file: spoken }]); }
    finally { await cleanupFile(chime); await cleanupFile(spoken); }
  } catch (err) {
    console.warn(`[markers] couldn't make "${kind}" audio (${(err as Error).message}) — using silence`);
    return silenceFile(0.2);
  }
}

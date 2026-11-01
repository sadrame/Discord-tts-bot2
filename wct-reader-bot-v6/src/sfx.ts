import { readdir, writeFile, mkdir, stat } from "fs/promises";
import { basename, extname, join } from "path";
import { tmpdir } from "os";
import { elevenEnabled, generateSoundEffect } from "./eleven.js";
import { kvGet, kvSet } from "./kv.js";

// Reactions for Bing (Edge) voices. Edge TTS can't scream, so text like "AAAAAH", "Skreeee"
// or "*scratches*" is swapped for a real sound clip (or, failing that, a spoken approximation
// instead of the voice spelling out letters).
//
// Where the sounds come from, in order:
//   1. Your own files in ./sounds (scream.mp3, screech-2.wav, scratch.ogg …) — random pick if several
//   2. ElevenLabs sound generation, if SFX_ELEVENLABS=1 and ELEVENLABS_API_KEY is set
//      (≈50 credits per effect, generated once and then cached)
//   3. A spoken fallback ("Aaaah!") — or silence for sounds that can't be spoken

export type SfxName = "scream" | "screech" | "scratch" | "gasp" | "laugh" | "sob" | "growl" | "thud" | "bang";

export type Segment =
  | { type: "text"; text: string }
  | { type: "sfx";  name: SfxName; raw: string };

export const SFX_ENABLED = (process.env["SFX"] ?? "on").toLowerCase() !== "off";
const SOUNDS_DIR       = process.env["SOUNDS_DIR"] ?? join(process.cwd(), "sounds");
const USE_ELEVEN_SFX   = ["1", "true", "on", "yes"].includes((process.env["SFX_ELEVENLABS"] ?? "").toLowerCase());

/** What the voice says when no sound clip is available ("" = stay silent). */
export const FALLBACK_SPEECH: Record<SfxName, string> = {
  scream: "Aaaaah!", screech: "Eeeek!", scratch: "", gasp: "Haah!", laugh: "Ha ha ha!",
  sob: "Hnnh... hnnh...", growl: "Grrrrr.", thud: "", bang: "Bang!",
};

const PROMPTS: Record<SfxName, string> = {
  scream:  "a short, sharp human scream of fear",
  screech: "a short, high-pitched creature screech",
  scratch: "claws scratching against wood",
  gasp:    "a sudden sharp gasp of surprise",
  laugh:   "a short menacing laugh",
  sob:     "a person sobbing quietly",
  growl:   "a low animal growl",
  thud:    "a heavy thud",
  bang:    "a loud bang",
};

// ─── Detection ────────────────────────────────────────────────────────────────

// Words that turn *asterisk*, [bracket] and (paren) actions into sounds
const WORDS: Record<string, SfxName> = {
  scream: "scream", screams: "scream", screamed: "scream", screaming: "scream",
  shriek: "scream", shrieks: "scream", shrieked: "scream", shrieking: "scream",
  screech: "screech", screeches: "screech", screeching: "screech",
  scratch: "scratch", scratches: "scratch", scratching: "scratch", claw: "scratch", claws: "scratch", clawing: "scratch",
  gasp: "gasp", gasps: "gasp", gasped: "gasp",
  laugh: "laugh", laughs: "laugh", laughing: "laugh", giggle: "laugh", giggles: "laugh", chuckle: "laugh", chuckles: "laugh", cackle: "laugh", cackles: "laugh",
  sob: "sob", sobs: "sob", sobbing: "sob", cry: "sob", cries: "sob", crying: "sob", weep: "sob", weeps: "sob", weeping: "sob", whimper: "sob", whimpers: "sob",
  growl: "growl", growls: "growl", growling: "growl", snarl: "growl", snarls: "growl", snarling: "growl",
  thud: "thud", thuds: "thud", thump: "thud", thumps: "thud",
  bang: "bang", bangs: "bang", slam: "bang", slams: "bang", crash: "bang", crashes: "bang",
};

// Words allowed next to the action word, so "*she screams*" works but "*I can't scream*" doesn't
const FILLERS = new Set([
  "he", "she", "they", "it", "i", "we", "you", "a", "an", "the", "her", "his", "their", "and", "then", "more", "again", "out",
  "loud", "loudly", "softly", "quietly", "suddenly", "faintly", "wildly", "briefly",
]);

const MARKER_RE = /\*\s*([^*\n]{2,40}?)\s*\*|\[\s*([^\]\n]{2,40}?)\s*\]|\(\s*([^)\n]{2,40}?)\s*\)/g;

const TOKENS: { name: SfxName; re: RegExp }[] = [
  { name: "scream",  re: /\b(?:a{4,}h*|a{3,}h+|a{2,}r+g+h*|[kg]y+a{2,}h*|e{2,}k+|i{3,}k+)\b[!?.…]*/gi },
  { name: "screech", re: /\b(?:s|k|sk)c?r+e{3,}(?:ch+|k+)?\b[!?.…]*/gi },
  { name: "scratch", re: /\b(?:scritch|skritch|skrtch|scr{2,}tch?|skr{2,}t+)\b[!?.…]*/gi },
];

function classifyMarker(inner: string): SfxName | null {
  const words = inner.toLowerCase().replace(/[^a-z' ]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 3) return null;
  let found: SfxName | null = null;
  for (const w of words) {
    const name = WORDS[w];
    if (name) {
      if (found) return null;          // two action words → probably prose, leave it
      found = name;
    } else if (!FILLERS.has(w)) {
      return null;
    }
  }
  return found;
}

interface Hit { start: number; end: number; name: SfxName }

/** Split text into spoken parts and sound-effect parts. */
export function splitWithSfx(text: string): Segment[] {
  const hits: Hit[] = [];

  for (const m of text.matchAll(MARKER_RE)) {
    const inner = m[1] ?? m[2] ?? m[3] ?? "";
    const name  = classifyMarker(inner);
    if (name && m.index !== undefined) hits.push({ start: m.index, end: m.index + m[0].length, name });
  }
  for (const { name, re } of TOKENS) {
    for (const m of text.matchAll(re)) {
      if (m.index !== undefined) hits.push({ start: m.index, end: m.index + m[0].length, name });
    }
  }
  if (hits.length === 0) return [{ type: "text", text }];

  hits.sort((a, b) => a.start - b.start);
  const segments: Segment[] = [];
  let cursor = 0;
  const pushText = (s: string) => {
    if (/[\p{L}\p{N}]/u.test(s)) segments.push({ type: "text", text: s });   // drop punctuation-only gaps
  };
  for (const h of hits) {
    if (h.start < cursor) continue;                                           // overlapped by an earlier hit
    pushText(text.slice(cursor, h.start));
    const prev = segments[segments.length - 1];
    if (prev && prev.type === "sfx" && prev.name === h.name) prev.raw += text.slice(h.start, h.end);   // "Aaah! Aaah!" → one scream
    else segments.push({ type: "sfx", name: h.name, raw: text.slice(h.start, h.end) });
    cursor = h.end;
  }
  pushText(text.slice(cursor));
  return segments;
}

/** "AAAAAAAH" → "aaah": stops the voice spelling out letters when it's shouting. */
export function softenShouting(text: string): string {
  return text.replace(/\b[A-Za-z]*([A-Za-z])\1{2,}[A-Za-z]*\b/g, (w) =>
    w.toLowerCase().replace(/([a-z])\1{3,}/g, "$1$1$1")
  );
}

// ─── Sound sources ────────────────────────────────────────────────────────────

const AUDIO_EXTS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac"]);

async function localFile(name: SfxName): Promise<string | null> {
  try {
    const matches = (await readdir(SOUNDS_DIR)).filter((f) => {
      if (!AUDIO_EXTS.has(extname(f).toLowerCase())) return false;
      const stem = basename(f, extname(f)).toLowerCase();
      return stem === name || stem.startsWith(`${name}-`) || stem.startsWith(`${name}_`) || stem.startsWith(`${name} `);
    });
    if (matches.length > 0) return join(SOUNDS_DIR, matches[Math.floor(Math.random() * matches.length)]!);
  } catch { /* no sounds folder */ }
  return null;
}

const pending = new Map<SfxName, Promise<string | null>>();

async function elevenFile(name: SfxName): Promise<string | null> {
  if (!USE_ELEVEN_SFX || !elevenEnabled()) return null;
  const existing = pending.get(name);
  if (existing) return existing;

  const job = (async (): Promise<string | null> => {
    const dir  = join(tmpdir(), "wct-sfx");
    const file = join(dir, `${name}.mp3`);
    try {
      await mkdir(dir, { recursive: true });
      if (await stat(file).then((s) => s.size > 0).catch(() => false)) return file;       // already on disk

      const cached = await kvGet(`wct:sfx:${name}`).catch(() => null);                      // generated before (survives restarts)
      if (cached) { await writeFile(file, Buffer.from(cached, "base64")); return file; }

      console.log(`[sfx] generating "${name}" with ElevenLabs (one-time, cached afterwards)`);
      const audio = await generateSoundEffect(PROMPTS[name], 2);
      await writeFile(file, audio);
      await kvSet(`wct:sfx:${name}`, audio.toString("base64"), 60 * 60 * 24 * 365).catch(() => {});
      return file;
    } catch (err) {
      console.warn(`[sfx] couldn't generate "${name}": ${(err as Error).message}`);
      return null;
    } finally {
      pending.delete(name);
    }
  })();
  pending.set(name, job);
  return job;
}

/** Path of an audio clip for this sound, or null if none is available. */
export async function getSfxFile(name: SfxName): Promise<string | null> {
  return (await localFile(name)) ?? (await elevenFile(name));
}

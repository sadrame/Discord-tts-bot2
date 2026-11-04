import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { VoiceOption } from "./voices.js";
import { DEFAULT_VOICE } from "./voices.js";
import { elevenSynthesize, ElevenError } from "./eleven.js";
import { expressiveBody } from "./expressive.js";
import type { ExpressionLevel } from "./expressive.js";
import { splitWithSfx, softenShouting, getSfxFile, FALLBACK_SPEECH, SFX_ENABLED } from "./sfx.js";
import type { Segment } from "./sfx.js";
import { concatAudio, silenceFile } from "./media.js";
import type { AudioPart } from "./media.js";

const TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sanitizeText(text: string): string {
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/[^\S\n]+/g, " ")
    .trim();
}

// ─── Engine pool + shared concurrency limit ──────────────────────────────────
// Several servers read at the same time, so synthesis must not funnel through ONE connection
// or ONE lock (that made servers wait on each other and reconnect on every voice change).
//
//  • Up to TTS_CONCURRENCY syntheses run in parallel (default 3), each on its own connection.
//  • Idle connections are kept; a request prefers one already set to its voice (no reconnect).
//  • When a request fails, only THAT connection is thrown away — other servers are unaffected.

const MAX_CONCURRENT = Math.max(1, Math.min(8, Number(process.env["TTS_CONCURRENCY"]) || 3));
const EDGE_FORMAT    = OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3;

interface PooledEngine { engine: MsEdgeTTS; voiceId: string | null }
const idleEngines: PooledEngine[] = [];

function closeEngine(p: PooledEngine): void {
  try { (p.engine as unknown as { close?: () => void }).close?.(); } catch { /* already closed */ }
}

async function checkoutEngine(voiceId: string): Promise<PooledEngine> {
  let i = idleEngines.findIndex((e) => e.voiceId === voiceId);   // same voice → reuse as-is
  if (i === -1 && idleEngines.length > 0) i = 0;                 // otherwise re-point an idle one
  const pooled: PooledEngine = i !== -1 ? idleEngines.splice(i, 1)[0]! : { engine: new MsEdgeTTS(), voiceId: null };

  if (pooled.voiceId !== voiceId) {
    try {
      await pooled.engine.setMetadata(voiceId, EDGE_FORMAT);
      pooled.voiceId = voiceId;
      console.log(`[tts] connection set to voice: ${voiceId}`);
    } catch (err) {
      closeEngine(pooled);
      throw err;
    }
  }
  return pooled;
}

function checkinEngine(p: PooledEngine): void {
  idleEngines.push(p);
  while (idleEngines.length > MAX_CONCURRENT) closeEngine(idleEngines.shift()!);
}

let ttsActive = 0;
const ttsQueue: Array<() => void> = [];

async function acquireTts(): Promise<void> {
  if (ttsActive < MAX_CONCURRENT) { ttsActive++; return; }
  await new Promise<void>((resolve) => ttsQueue.push(resolve));     // slot is handed over, count stays
}

function releaseTts(): void {
  const next = ttsQueue.shift();
  if (next) next(); else ttsActive--;
}

// ─── Low-level synthesis ──────────────────────────────────────────────────────

async function synthesize(text: string, voiceId: string, filePath: string, rawSsml = false): Promise<void> {
  const pooled = await checkoutEngine(voiceId);
  let ok = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        // The Edge API takes SSML, so & < > in the text must be escaped
        const safe = rawSsml ? text : text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const { audioStream } = pooled.engine.toStream(safe);
        const chunks: Buffer[] = [];
        audioStream.on("data", (c: Buffer) => chunks.push(c));
        audioStream.on("end", async () => {
          try {
            const buf = Buffer.concat(chunks);
            if (buf.length === 0) { reject(new Error("Empty audio buffer")); return; }
            await writeFile(filePath, buf);
            resolve();
          } catch (e) { reject(e); }
        });
        audioStream.on("error", reject);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TTS timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
      }),
    ]);
    ok = true;
  } finally {
    if (timer) clearTimeout(timer);
    if (ok) checkinEngine(pooled); else closeEngine(pooled);       // a failed connection is never reused
  }
}

// ─── Bing / Edge synthesis (caller must hold the semaphore) ──────────────────

// If the Bing service rejects expressive (SSML) requests, stop sending them for a while and read plain text instead
let ssmlFailures = 0;
let ssmlPausedUntil = 0;
const ssmlAllowed = (): boolean => Date.now() >= ssmlPausedUntil && (process.env["EXPRESSION"] ?? "on").toLowerCase() !== "off";

async function edgeToFile(raw: string, voice: VoiceOption, level: ExpressionLevel = "off"): Promise<string> {
  const plain = sanitizeText(softenShouting(raw));
  let body: string | null = ssmlAllowed() ? expressiveBody(sanitizeText(raw), level) : null;
  let lastErr: Error = new Error("Unknown TTS error");

  for (let attempt = 1; attempt <= 3; attempt++) {
    const filePath = join(tmpdir(), `wct-tts-${randomUUID()}.mp3`);
    try {
      console.log(`[tts] voice=${voice.id} attempt=${attempt} len=${plain.length}${body ? " expressive" : ""}`);
      await synthesize(body ?? plain, voice.id, filePath, body !== null);
      if (body !== null) ssmlFailures = 0;
      return filePath; // ✅
    } catch (err) {
      lastErr = err as Error;
      await unlink(filePath).catch(() => {});
      // (the failed connection was already dropped; the next attempt gets a fresh one)
      console.warn(`[tts] attempt ${attempt}/3 failed (${voice.id}): ${lastErr.message}`);
      if (body !== null) {
        body = null;                                   // retry this one as plain text
        if (++ssmlFailures >= 3) {
          ssmlFailures = 0;
          ssmlPausedUntil = Date.now() + 10 * 60_000;
          console.warn("[tts] expressive requests keep failing — reading plain text for 10 minutes");
        }
      }
      if (attempt < 3) await sleep(700);
    }
  }
  throw lastErr;
}

/** Speak the text parts, drop in sound clips for the reactions, and stitch it all into one mp3. */
async function edgeWithSfx(segments: Segment[], plainText: string, voice: VoiceOption, level: ExpressionLevel = "off"): Promise<string> {
  const parts: AudioPart[] = [];
  const temps: string[]    = [];
  try {
    for (const seg of segments) {
      if (seg.type === "text") {
        if (!/[\p{L}\p{N}]/u.test(seg.text)) continue;
        const f = await edgeToFile(seg.text, voice, level);
        temps.push(f); parts.push({ file: f });
        continue;
      }
      const sound = await getSfxFile(seg.name);
      if (sound) { parts.push({ file: sound, sfx: true }); continue; }

      const spoken = FALLBACK_SPEECH[seg.name];            // no clip → say it instead of spelling letters
      if (!spoken) continue;
      const f = await edgeToFile(spoken, voice);
      temps.push(f); parts.push({ file: f });
    }

    if (parts.length === 0) return await silenceFile();   // e.g. a lone *scratch* with no clip available

    if (parts.length === 1 && !parts[0]!.sfx) {            // nothing to stitch
      const only = parts[0]!.file;
      temps.splice(temps.indexOf(only), 1);                // keep it — it's the result
      return only;
    }

    try {
      return await concatAudio(parts);
    } catch (err) {
      console.warn(`[tts] couldn't mix sound effects (${(err as Error).message}) — reading the text instead`);
      return await edgeToFile(plainText, voice, level);
    }
  } finally {
    await Promise.all(temps.map((f) => cleanupFile(f)));
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Convert text to an MP3 temp file.
 *
 * Uses a small pool of WebSocket connections (see "Engine pool" above) so several servers can
 * synthesize at once. `opts.expression` adds emotion for Bing voices (CAPS, !, ?, …).
 */
export async function textToMp3File(
  text: string,
  voice: VoiceOption = DEFAULT_VOICE,
  opts: { expression?: ExpressionLevel } = {},
): Promise<string> {
  const level: ExpressionLevel = opts.expression ?? "off";
  const clean = sanitizeText(text);
  if (!clean) throw new Error("Text is empty after sanitisation");

  // Nothing to say (e.g. "……" or stray symbols): a voice would return empty audio and count as a failure
  if (!/[\p{L}\p{N}]/u.test(clean)) return await silenceFile(0.3);

  await acquireTts();
  try {
    // ── ElevenLabs voices ────────────────────────────────────────────────────
    if (voice.service === "elevenlabs") {
      let elevenErr: Error = new Error("Unknown ElevenLabs error");
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          console.log(`[tts] elevenlabs voice=${voice.id} attempt=${attempt} len=${clean.length}`);
          const audio    = await elevenSynthesize(clean, voice.id);
          const filePath = join(tmpdir(), `wct-tts-${randomUUID()}.mp3`);
          await writeFile(filePath, audio);
          return filePath; // ✅
        } catch (err) {
          elevenErr = err as Error;
          console.warn(`[tts] elevenlabs attempt ${attempt}/3 failed (${voice.id}): ${elevenErr.message}`);
          if (err instanceof ElevenError && err.fatal) break;   // bad key / quota / not allowed — retrying won't help
          if (attempt < 3) await sleep(2_000);
        }
      }
      throw elevenErr;
    }

    // ── Bing / Edge voices (with reactions: screams, screeches, scratches…) ──
    const segments: Segment[] = SFX_ENABLED ? splitWithSfx(clean) : [{ type: "text", text: clean }];
    if (segments.length === 1 && segments[0]!.type === "text") {
      return await edgeToFile(clean, voice, level);
    }
    return await edgeWithSfx(segments, clean, voice, level);
  } finally {
    releaseTts();
  }
}

export async function cleanupFile(filePath: string): Promise<void> {
  try { await unlink(filePath); } catch { /* ignore */ }
}

export function splitIntoChunks(text: string, maxChars = 400): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["'\u201C\u201D]?|[^.!?]+$/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current.length + sentence.length > maxChars) {
      if (current.trim()) chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter((c) => c.length > 0);
}

/** No-op — kept for import compatibility. */
export function warmUpVoice(_voice: VoiceOption): void {
  // Intentionally empty
}

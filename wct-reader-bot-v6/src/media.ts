import { spawn } from "child_process";
import { unlink } from "fs/promises";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";

// Small ffmpeg helpers: stitch speech + sound effects together, and change playback speed.

async function resolveFfmpeg(): Promise<string> {
  if (process.env["FFMPEG_PATH"]) return process.env["FFMPEG_PATH"];
  try {
    const mod = (await import("ffmpeg-static")) as unknown as { default?: unknown };
    const p = mod.default ?? mod;
    if (typeof p === "string" && p) return p;
  } catch { /* fall through to system ffmpeg */ }
  return "ffmpeg";
}
const ffmpegBin: Promise<string> = resolveFfmpeg();

// Several servers may need ffmpeg at once; on a small host that would starve the audio streams.
const MAX_FFMPEG = Math.max(1, Number(process.env["FFMPEG_CONCURRENCY"]) || 2);
let ffActive = 0;
const ffWaiters: Array<() => void> = [];

async function ffAcquire(): Promise<void> {
  if (ffActive < MAX_FFMPEG) { ffActive++; return; }
  await new Promise<void>((resolve) => ffWaiters.push(resolve));     // slot is handed over, count stays
}
function ffRelease(): void {
  const next = ffWaiters.shift();
  if (next) next(); else ffActive--;
}

async function runFfmpeg(args: string[], timeoutMs = 30_000): Promise<void> {
  const bin = await ffmpegBin;
  await ffAcquire();
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(bin, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
      const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("ffmpeg timed out")); }, timeoutMs);
      proc.on("error", (err) => { clearTimeout(timer); reject(err); });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().split("\n").pop() ?? ""}`));
      });
    });
  } finally {
    ffRelease();
  }
}

function tmpMp3(prefix: string): string {
  return join(tmpdir(), `${prefix}-${randomUUID()}.mp3`);
}

export interface AudioPart {
  file: string;
  sfx?: boolean;       // sound effect: trimmed, faded and levelled
}

const SFX_MAX_SECONDS = 4;

/** Join parts (speech and sound effects, any format) into ONE mp3. */
export async function concatAudio(parts: AudioPart[]): Promise<string> {
  const out  = tmpMp3("wct-mix");
  const args: string[] = [];
  for (const p of parts) args.push("-i", p.file);

  const filters = parts.map((p, i) => {
    const trim = p.sfx
      ? `atrim=0:${SFX_MAX_SECONDS},asetpts=PTS-STARTPTS,afade=t=out:st=${SFX_MAX_SECONDS - 0.5}:d=0.5,volume=0.8,`
      : "";
    return `[${i}:a]${trim}aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono[a${i}]`;
  });
  const labels = parts.map((_, i) => `[a${i}]`).join("");
  args.push(
    "-filter_complex", `${filters.join(";")};${labels}concat=n=${parts.length}:v=0:a=1[out]`,
    "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "96k", out,
  );
  await runFfmpeg(args);
  return out;
}

/** atempo only accepts 0.5–2.0 per stage, so chain stages for bigger changes. */
function tempoFilter(speed: number): string {
  const stages: number[] = [];
  let s = speed;
  while (s > 2.0)  { stages.push(2.0); s /= 2.0; }
  while (s < 0.5)  { stages.push(0.5); s /= 0.5; }
  stages.push(Math.round(s * 1000) / 1000);
  return stages.map((x) => `atempo=${x}`).join(",");
}

/** Make a faster/slower copy of an audio file (pitch is preserved). */
export async function changeTempo(file: string, speed: number): Promise<string> {
  const out = tmpMp3("wct-speed");
  await runFfmpeg(["-i", file, "-filter:a", tempoFilter(speed), "-c:a", "libmp3lame", "-b:a", "96k", out]);
  return out;
}

/** A short silent clip (used when a chunk is only a sound effect that has no audio available). */
export async function silenceFile(seconds = 0.4): Promise<string> {
  const out = tmpMp3("wct-silence");
  await runFfmpeg(["-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", String(seconds), "-c:a", "libmp3lame", "-b:a", "48k", out]);
  return out;
}

export interface ToneSpec { freq: number; dur: number }

/** Synthesize a short bell-like melody (each note rings out and fades) — no audio files needed. */
export async function synthTones(tones: ToneSpec[]): Promise<string> {
  const out  = tmpMp3("wct-chime");
  const args: string[] = [];
  for (const t of tones) {
    const expr = `0.45*exp(-7*t)*sin(2*PI*${t.freq}*t)+0.15*exp(-8*t)*sin(2*PI*${t.freq * 2}*t)`;
    args.push("-f", "lavfi", "-i", `aevalsrc=${expr}:d=${t.dur}:s=24000`);
  }
  const labels = tones.map((_, i) => `[${i}:a]`).join("");
  args.push(
    "-filter_complex", `${labels}concat=n=${tones.length}:v=0:a=1[out]`,
    "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "96k", out,
  );
  await runFfmpeg(args);
  return out;
}

// ─── Pre-encoding for playback ────────────────────────────────────────────────

let opusFailures = 0;

/** False once pre-encoding has failed repeatedly (e.g. an ffmpeg build without libopus) or PREENCODE_OPUS=off. */
export function opusEnabled(): boolean {
  return opusFailures < 3 && (process.env["PREENCODE_OPUS"] ?? "on").toLowerCase() !== "off";
}

/**
 * Convert a clip to Ogg/Opus (48 kHz stereo, the format Discord wants) — optionally at a different speed.
 * Doing this ahead of time means playback just forwards ready-made packets: no live ffmpeg decode and no
 * JavaScript Opus encoding while the audio is playing, which is what starves other servers on a small host.
 */
export async function toOpusOgg(file: string, speed = 1): Promise<string> {
  const out = join(tmpdir(), `wct-play-${randomUUID()}.ogg`);
  const tempo = Math.abs(speed - 1) > 0.01 ? ["-filter:a", tempoFilter(speed)] : [];
  try {
    await runFfmpeg([
      "-i", file, ...tempo, "-vn",
      "-c:a", "libopus", "-b:a", "64k", "-ar", "48000", "-ac", "2",
      "-frame_duration", "20", "-application", "audio", "-f", "ogg", out,
    ]);
    opusFailures = 0;
    return out;
  } catch (err) {
    opusFailures++;
    await unlink(out).catch(() => {});
    throw err;
  }
}

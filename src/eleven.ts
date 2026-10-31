import type { VoiceOption } from "./voices.js";

// Minimal ElevenLabs client: text-to-speech + voice search (account voices and the Voice Library).
// Needs ELEVENLABS_API_KEY. Optional: ELEVENLABS_MODEL (default: the cheaper Flash model) and
// ELEVENLABS_BASE_URL (e.g. https://api.eu.residency.elevenlabs.io for EU data residency).

const BASE  = (process.env["ELEVENLABS_BASE_URL"]?.trim() || "https://api.elevenlabs.io").replace(/\/$/, "");
const KEY   = process.env["ELEVENLABS_API_KEY"]?.trim();
const MODEL = process.env["ELEVENLABS_MODEL"]?.trim() || "eleven_flash_v2_5";

export function elevenEnabled(): boolean {
  return Boolean(KEY);
}

/** `fatal` = retrying won't help (bad key, quota used up, voice not allowed on your plan…). */
export class ElevenError extends Error {
  readonly status: number;
  readonly fatal:  boolean;
  constructor(message: string, status: number, fatal: boolean) {
    super(message);
    this.name   = "ElevenError";
    this.status = status;
    this.fatal  = fatal;
  }
}

async function toError(res: Response): Promise<ElevenError> {
  let code = "";
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { detail?: { status?: string; message?: string } | string };
    if (typeof body.detail === "string") message = body.detail;
    else if (body.detail) {
      code    = body.detail.status ?? "";
      message = body.detail.message || code || message;
    }
  } catch { /* body wasn't JSON */ }

  if (code === "quota_exceeded")            message = "your ElevenLabs character quota is used up";
  else if (code === "invalid_api_key" || res.status === 401) message = message || "invalid ElevenLabs API key";
  else if (res.status === 402 || code === "paid_plan_required") message = "that voice needs a paid ElevenLabs plan";
  else if (res.status === 404)              message = "that voice isn't available on your ElevenLabs account";

  const fatal = [400, 401, 402, 403, 404, 422].includes(res.status);
  return new ElevenError(message, res.status, fatal);
}

async function eleven(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  if (!KEY) throw new ElevenError("ElevenLabs isn't set up (missing ELEVENLABS_API_KEY).", 0, true);
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "xi-api-key": KEY, Accept: "application/json", ...((init.headers as Record<string, string> | undefined) ?? {}) },
    signal:  AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw await toError(res);
  return res;
}

// ─── Text to speech ───────────────────────────────────────────────────────────

export async function elevenSynthesize(text: string, voiceId: string): Promise<Buffer> {
  const res = await eleven(`/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
    body:    JSON.stringify({ text, model_id: MODEL }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new ElevenError("ElevenLabs returned empty audio", res.status, false);
  return buf;
}

/** Download a hosted voice sample (free — doesn't use credits). */
export async function fetchPreview(url: string): Promise<Buffer> {
  if (!url.startsWith("https://")) throw new Error("Unsafe preview URL");
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Preview download failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > 8 * 1024 * 1024) throw new Error("Preview file was empty or too large");
  return buf;
}

// ─── Voice listing / search ───────────────────────────────────────────────────

function cap(s?: string | null): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : "Unknown";
}

interface LibraryVoice {
  public_owner_id?: string;
  voice_id: string;
  name?: string;
  accent?: string | null;
  gender?: string | null;
  descriptive?: string | null;
  use_case?: string | null;
  description?: string | null;
  preview_url?: string | null;
}

interface AccountVoice {
  voice_id: string;
  name?: string;
  category?: string;
  description?: string | null;
  preview_url?: string | null;
  labels?: Record<string, string> | null;
}

function fromLibrary(v: LibraryVoice, reader: boolean): VoiceOption {
  const style = [v.descriptive, v.use_case].filter(Boolean).join(", ") || (v.description ?? "").slice(0, 80) || "Library voice";
  return {
    service: "elevenlabs", id: v.voice_id, label: (v.name ?? v.voice_id).slice(0, 100),
    accent: cap(v.accent), gender: cap(v.gender), style,
    ...(v.preview_url ? { previewUrl: v.preview_url } : {}),
    ...(v.public_owner_id ? { ownerId: v.public_owner_id } : {}),
    reader,
  };
}

function fromAccount(v: AccountVoice): VoiceOption {
  const l = v.labels ?? {};
  const style = [l["descriptive"], l["use_case"]].filter(Boolean).join(", ") || v.description?.slice(0, 80) || v.category || "Your voice";
  return {
    service: "elevenlabs", id: v.voice_id, label: (v.name ?? v.voice_id).slice(0, 100),
    accent: cap(l["accent"]), gender: cap(l["gender"]), style,
    ...(v.preview_url ? { previewUrl: v.preview_url } : {}),
  };
}

let accountCache: { at: number; voices: VoiceOption[] } | null = null;

/** Voices already on your account (ElevenLabs' standard voices like Sarah, plus any you've added). */
export async function listAccountVoices(search = ""): Promise<VoiceOption[]> {
  const q = search.trim();
  if (!q && accountCache && Date.now() - accountCache.at < 10 * 60_000) return accountCache.voices;
  const params = new URLSearchParams({ page_size: "100" });
  if (q) params.set("search", q);
  const res  = await eleven(`/v2/voices?${params}`);
  const data = (await res.json()) as { voices?: AccountVoice[] };
  const voices = (data.voices ?? []).map(fromAccount);
  if (!q) accountCache = { at: Date.now(), voices };
  return voices;
}

/** Community Voice Library. `readerOnly` = only voices enabled for the ElevenReader app. */
export async function searchLibraryVoices(search: string, readerOnly: boolean): Promise<VoiceOption[]> {
  const q = search.trim();
  const params = new URLSearchParams({ page_size: "15", language: "en" });
  if (q) params.set("search", q); else params.set("featured", "true");
  if (readerOnly) params.set("reader_app_enabled", "true");
  const res  = await eleven(`/v1/shared-voices?${params}`);
  const data = (await res.json()) as { voices?: LibraryVoice[] };
  return (data.voices ?? []).map((v) => fromLibrary(v, readerOnly));
}

/** Library voices must be added to your account before they can speak. */
export async function addLibraryVoice(voice: VoiceOption): Promise<{ id: string; warning?: string }> {
  if (!voice.ownerId) return { id: voice.id };
  try {
    const res = await eleven(`/v1/voices/add/${encodeURIComponent(voice.ownerId)}/${encodeURIComponent(voice.id)}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ new_name: voice.label.slice(0, 50) }),
    });
    const data = (await res.json().catch(() => ({}))) as { voice_id?: string };
    accountCache = null;
    return { id: data.voice_id || voice.id };
  } catch (err) {
    const message = (err as Error).message;
    if (/already/i.test(message)) return { id: voice.id };
    return { id: voice.id, warning: `Couldn't add it to your ElevenLabs account (${message}). It may not work.` };
  }
}

export async function getUsage(): Promise<{ used: number; limit: number } | null> {
  try {
    const res  = await eleven("/v1/user/subscription", {}, 10_000);
    const data = (await res.json()) as { character_count?: number; character_limit?: number };
    if (typeof data.character_count !== "number" || typeof data.character_limit !== "number") return null;
    return { used: data.character_count, limit: data.character_limit };
  } catch { return null; }
}

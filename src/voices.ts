export type VoiceService = "edge" | "elevenlabs";

export interface VoiceOption {
  id:       string;          // Edge neural voice name, or ElevenLabs voice_id
  label:    string;          // shown in menus
  accent:   string;
  gender:   string;
  style:    string;          // short description
  service:  VoiceService;    // which engine speaks it
  previewUrl?: string;       // ElevenLabs hosted sample (free to play)
  ownerId?:    string;       // ElevenLabs Voice Library owner (voice must be added to the account)
  reader?:     boolean;      // enabled for the ElevenReader app
  freeOk?:     boolean;      // ElevenLabs: usable on the free plan? (undefined = unknown)
  tiers?:      string[];     // ElevenLabs: plans the voice is available on (when the API says)
  category?:   string;       // ElevenLabs: premade / professional / famous / high_quality …
}

export function serviceName(v: VoiceOption): string {
  return v.service === "elevenlabs" ? "ElevenLabs" : "Bing (Edge)";
}

const TIER_ORDER = ["free", "starter", "creator", "pro", "scale", "business", "enterprise"];

export function tierRank(tier: string): number {
  return TIER_ORDER.indexOf(tier.toLowerCase());
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Lowest plan in a list of tiers (e.g. ["creator","enterprise"] → "creator"). */
export function minTier(tiers: string[]): string | null {
  let best: string | null = null;
  let bestRank = Infinity;
  for (const t of tiers) {
    const r = tierRank(t);
    if (r !== -1 && r < bestRank) { best = t.toLowerCase(); bestRank = r; }
  }
  return best ?? tiers[0]?.toLowerCase() ?? null;
}

/** Short plan requirement shown next to every voice. */
export function planLabel(v: VoiceOption): string {
  if (v.service === "edge") return "🆓 Free";
  if (v.freeOk === true)    return "🆓 Free plan OK";
  if (v.freeOk === false) {
    const t = v.tiers && v.tiers.length > 0 ? minTier(v.tiers) : null;
    return t && t !== "free" ? `💳 ${titleCase(t)}+ plan` : "💳 Paid plan";
  }
  return "✨ Plan varies";
}

/** Name plus engine, for embeds and messages. */
export function voiceDisplay(v: VoiceOption): string {
  return v.service === "elevenlabs" ? `${v.label} · ElevenLabs` : v.label;
}

export const VOICES: VoiceOption[] = [
  { service: "edge", id: "en-US-JennyNeural",       label: "Jenny",       accent: "American",   gender: "Female", style: "Friendly, natural (default)" },
  { service: "edge", id: "en-US-AriaNeural",        label: "Aria",        accent: "American",   gender: "Female", style: "Expressive, warm" },
  { service: "edge", id: "en-US-MichelleNeural",    label: "Michelle",    accent: "American",   gender: "Female", style: "Clear, pleasant" },
  { service: "edge", id: "en-US-AnaNeural",         label: "Ana",         accent: "American",   gender: "Female", style: "Youthful, bright" },
  { service: "edge", id: "en-US-GuyNeural",         label: "Guy",         accent: "American",   gender: "Male",   style: "Calm, steady" },
  { service: "edge", id: "en-US-DavisNeural",       label: "Davis",       accent: "American",   gender: "Male",   style: "Deep, smooth" },
  { service: "edge", id: "en-US-ChristopherNeural", label: "Christopher", accent: "American",   gender: "Male",   style: "Warm, reliable" },
  { service: "edge", id: "en-US-EricNeural",        label: "Eric",        accent: "American",   gender: "Male",   style: "Casual, friendly" },
  { service: "edge", id: "en-GB-SoniaNeural",       label: "Sonia",       accent: "British",    gender: "Female", style: "Polished, clear" },
  { service: "edge", id: "en-GB-LibbyNeural",       label: "Libby",       accent: "British",    gender: "Female", style: "Bright, youthful" },
  { service: "edge", id: "en-GB-RyanNeural",        label: "Ryan",        accent: "British",    gender: "Male",   style: "Confident, narrator" },
  { service: "edge", id: "en-GB-ThomasNeural",      label: "Thomas",      accent: "British",    gender: "Male",   style: "Smooth, relaxed" },
  { service: "edge", id: "en-AU-NatashaNeural",     label: "Natasha",     accent: "Australian", gender: "Female", style: "Friendly, upbeat" },
  { service: "edge", id: "en-AU-WilliamNeural",     label: "William",     accent: "Australian", gender: "Male",   style: "Easygoing, clear" },
  { service: "edge", id: "en-IE-EmilyNeural",       label: "Emily",       accent: "Irish",      gender: "Female", style: "Soft, gentle" },
  { service: "edge", id: "en-IE-ConnorNeural",      label: "Connor",      accent: "Irish",      gender: "Male",   style: "Warm, conversational" },
];

export const DEFAULT_VOICE: VoiceOption = VOICES[0]!;

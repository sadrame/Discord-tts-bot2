export interface VoiceOption {
  id:     string;   // Microsoft Edge neural voice name
  label:  string;   // shown in the dropdown
  accent: "American" | "British" | "Australian" | "Irish";
  gender: "Female" | "Male";
  style:  string;   // short description shown in the dropdown
}

export const VOICES: VoiceOption[] = [
  { id: "en-US-JennyNeural",       label: "Jenny",       accent: "American",   gender: "Female", style: "Friendly, natural (default)" },
  { id: "en-US-AriaNeural",        label: "Aria",        accent: "American",   gender: "Female", style: "Expressive, warm" },
  { id: "en-US-MichelleNeural",    label: "Michelle",    accent: "American",   gender: "Female", style: "Clear, pleasant" },
  { id: "en-US-AnaNeural",         label: "Ana",         accent: "American",   gender: "Female", style: "Youthful, bright" },
  { id: "en-US-GuyNeural",         label: "Guy",         accent: "American",   gender: "Male",   style: "Calm, steady" },
  { id: "en-US-DavisNeural",       label: "Davis",       accent: "American",   gender: "Male",   style: "Deep, smooth" },
  { id: "en-US-ChristopherNeural", label: "Christopher", accent: "American",   gender: "Male",   style: "Warm, reliable" },
  { id: "en-US-EricNeural",        label: "Eric",        accent: "American",   gender: "Male",   style: "Casual, friendly" },
  { id: "en-GB-SoniaNeural",       label: "Sonia",       accent: "British",    gender: "Female", style: "Polished, clear" },
  { id: "en-GB-LibbyNeural",       label: "Libby",       accent: "British",    gender: "Female", style: "Bright, youthful" },
  { id: "en-GB-RyanNeural",        label: "Ryan",        accent: "British",    gender: "Male",   style: "Confident, narrator" },
  { id: "en-GB-ThomasNeural",      label: "Thomas",      accent: "British",    gender: "Male",   style: "Smooth, relaxed" },
  { id: "en-AU-NatashaNeural",     label: "Natasha",     accent: "Australian", gender: "Female", style: "Friendly, upbeat" },
  { id: "en-AU-WilliamNeural",     label: "William",     accent: "Australian", gender: "Male",   style: "Easygoing, clear" },
  { id: "en-IE-EmilyNeural",       label: "Emily",       accent: "Irish",      gender: "Female", style: "Soft, gentle" },
  { id: "en-IE-ConnorNeural",      label: "Connor",      accent: "Irish",      gender: "Male",   style: "Warm, conversational" },
];

export const DEFAULT_VOICE: VoiceOption = VOICES[0]!;

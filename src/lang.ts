// Japanese text read by an English voice is skipped or garbled. These helpers split a sentence into
// Japanese and non-Japanese runs so each can be spoken by a voice that actually knows the language
// (the Japanese is READ in Japanese — never translated).

const JA_CH  = "\\u3040-\\u30ff\\u31f0-\\u31ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff66-\\uff9f";   // kana + kanji + half-width kana
const JA_MID = "\\s\\u3000-\\u303f\\uff01-\\uff0f\\uff1a-\\uff20\\u30fb\\u30fc\\uff5e\\u2026\\u2025\\d";          // punctuation, spaces, digits inside a Japanese run
const JA_RUN = new RegExp(`[「『（【〈《]*[${JA_CH}]+(?:[${JA_MID}]*[${JA_CH}]+)*[」』）】〉》。、！？…]*`, "gu");
const HAS_JA = new RegExp(`[${JA_CH}]`, "u");

export function containsJapanese(text: string): boolean {
  return HAS_JA.test(text);
}

export interface LangSegment { text: string; ja: boolean }

export function splitLanguages(text: string): LangSegment[] {
  if (!containsJapanese(text)) return [{ text, ja: false }];
  const out: LangSegment[] = [];
  let cursor = 0;
  for (const m of text.matchAll(JA_RUN)) {
    const at = m.index ?? 0;
    if (at > cursor) out.push({ text: text.slice(cursor, at), ja: false });
    out.push({ text: m[0], ja: true });
    cursor = at + m[0].length;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), ja: false });
  return out.filter((s) => s.text.trim().length > 0);
}

/** Japanese neural voice that matches the gender of the current voice. */
export function japaneseVoiceId(gender: string): string {
  return gender.toLowerCase() === "male" ? "ja-JP-KeitaNeural" : "ja-JP-NanamiNeural";
}

// ─── Turkish ─────────────────────────────────────────────────────────────────
// Turkish written in Latin letters is read with English pronunciation by an English voice. These
// helpers spot Turkish text so it can be spoken by a Turkish voice (read, never translated).

const TR_STOPWORDS = new Set([
  "ve", "bir", "bu", "şu", "için", "ama", "ile", "de", "da", "ki", "ne", "gibi", "çok", "daha",
  "ben", "sen", "biz", "siz", "onlar", "değil", "var", "yok", "mi", "mı", "mu", "mü", "olarak",
  "kadar", "sonra", "önce", "ise", "her", "hiç", "evet", "hayır", "dedi", "diye", "ancak",
  "çünkü", "fakat", "yani", "şey", "bana", "sana", "ona", "bunu", "şunu", "kendi", "başka", "artık",
]);
const TR_STRONG = /[ıİğĞşŞ]/g;        // letters that are (almost) only Turkish
const TR_WEAK   = /[çÇöÖüÜ]/g;        // shared with German, French…

/** True if the text is (mostly) Turkish. Japanese text is never Turkish. */
export function isTurkish(text: string): boolean {
  const t = text.trim();
  if (t.length < 3 || containsJapanese(t)) return false;
  const words = t.toLocaleLowerCase("tr-TR").match(/[a-zçğıöşüâîû]+/g) ?? [];
  if (words.length === 0) return false;
  const stop   = words.filter((w) => TR_STOPWORDS.has(w)).length;
  const strong = (t.match(TR_STRONG) ?? []).length;
  const weak   = (t.match(TR_WEAK) ?? []).length;
  if (words.length < 6) return strong >= 1 || stop >= 2;
  const ratio = stop / words.length;
  return ratio >= 0.12 || (strong >= 2 && ratio >= 0.05) || strong + weak * 0.5 >= words.length * 0.12;
}

/** Sites whose text is Turkish: every chunk from them is read in Turkish. Env TURKISH_HOSTS (comma list). */
const TURKISH_HOSTS = (process.env["TURKISH_HOSTS"] ?? "rezeroturkce.com")
  .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);

export function isTurkishSite(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return TURKISH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch { return false; }
}

/** Turkish neural voice that matches the gender of the current voice. */
export function turkishVoiceId(gender: string): string {
  return gender.toLowerCase() === "male" ? "tr-TR-AhmetNeural" : "tr-TR-EmelNeural";
}

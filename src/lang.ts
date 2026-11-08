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

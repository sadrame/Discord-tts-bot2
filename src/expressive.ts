// Gives Bing (Edge) voices some emotion. The voice can't "feel" text, so we translate cues into
// prosody (volume / pitch / speed) that the Read Aloud service understands:
//   WORDS IN CAPS       → louder, a bit higher        (a whole CAPS sentence → much louder)
//   Sentences with !    → louder and a touch faster   (!! → more)
//   Questions ?         → raised pitch, rising at the end
//   Trailing … / ...    → slower, trailing off
//   Noooooo / Waaah     → stretched: slower and louder
// Only <prosody> is used — it's the one styling element the speech library documents.

export type ExpressionLevel = "off" | "normal" | "strong";
export const EXPRESSION_LEVELS: ExpressionLevel[] = ["off", "normal", "strong"];

interface Style { volume?: number; pitch?: number; rate?: number }

// ALL-CAPS words that are just names/abbreviations, not shouting
const ACRONYMS = new Set([
  "TL", "TN", "LN", "WN", "OP", "AI", "UK", "US", "USA", "NPC", "OK", "TV", "DJ", "ID", "HP", "MP", "PC", "UN", "EU",
  "CEO", "GPS", "HQ", "RPG", "MC", "VR", "PS", "FAQ", "PDF", "CIA", "FBI", "NASA",
]);

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const add = (a: Style, b: Style): Style => ({
  volume: (a.volume ?? 0) + (b.volume ?? 0),
  pitch:  (a.pitch  ?? 0) + (b.pitch  ?? 0),
  rate:   (a.rate   ?? 0) + (b.rate   ?? 0),
});
const isEmpty   = (s: Style): boolean => !s.volume && !s.pitch && !s.rate;
const sameStyle = (a: Style, b: Style): boolean => (a.volume ?? 0) === (b.volume ?? 0) && (a.pitch ?? 0) === (b.pitch ?? 0) && (a.rate ?? 0) === (b.rate ?? 0);

const pct = (n: number, lo: number, hi: number): string => {
  const v = Math.round(Math.min(hi, Math.max(lo, n)));
  return `${v >= 0 ? "+" : ""}${v}%`;
};

function wrap(inner: string, s: Style): string {
  const attrs: string[] = [];
  if (s.volume) attrs.push(`volume="${pct(s.volume, -50, 60)}"`);
  if (s.pitch)  attrs.push(`pitch="${pct(s.pitch, -25, 25)}"`);
  if (s.rate)   attrs.push(`rate="${pct(s.rate, -40, 20)}"`);
  return attrs.length ? `<prosody ${attrs.join(" ")}>${inner}</prosody>` : inner;
}

function sentenceToSsml(sentence: string, m: number): { xml: string; styled: boolean } {
  const text = sentence.trim();
  if (!text) return { xml: "", styled: false };

  const punct    = text.match(/([!?.…]+)["'”’)\]]*$/)?.[1] ?? "";
  const bangs    = (punct.match(/!/g) ?? []).length;
  const question = punct.includes("?");
  const trailing = /(\.{3,}|…)["'”’)\]]*$/.test(text);

  const letters   = text.replace(/[^A-Za-z]/g, "");
  const upper     = letters.replace(/[^A-Z]/g, "").length;
  const wordCount = (text.match(/[A-Za-z][A-Za-z'’]*/g) ?? []).length;
  const allCaps   = letters.length >= 4 && wordCount >= 2 && upper / letters.length >= 0.9;

  let outer: Style = {};
  if (bangs > 0)  outer = add(outer, { volume: 14 * m, pitch: 3 * m, rate: 4 * m });
  if (bangs > 1)  outer = add(outer, { volume: 10 * m });
  if (question)   outer = add(outer, { pitch: 4 * m });
  if (trailing)   outer = add(outer, { rate: -10 * m });
  if (allCaps)    outer = add(outer, { volume: 35 * m, pitch: 5 * m, rate: -3 });

  // Split into words (odd positions) and everything between them (even positions)
  const parts = text.split(/([A-Za-z][A-Za-z'’]*)/);
  let lastWord = -1;
  parts.forEach((_, i) => { if (i % 2 === 1) lastWord = i; });

  const runs: { text: string; style: Style }[] = [];
  const push = (t: string, style: Style) => {
    const last = runs[runs.length - 1];
    if (last && sameStyle(last.style, style)) last.text += t; else runs.push({ text: t, style });
  };

  parts.forEach((part, i) => {
    if (i % 2 === 0) {                                   // spaces, punctuation, digits stay with the word before
      if (!part) return;
      if (runs.length) runs[runs.length - 1]!.text += part; else push(part, {});
      return;
    }
    const caps    = !allCaps && part.length >= 2 && part === part.toUpperCase() && !ACRONYMS.has(part) && !/^[IVXLCDM]{2,5}$/.test(part);
    const stretch = /([A-Za-z])\1{2,}/.test(part);
    let word  = part.replace(/([A-Za-z])\1{3,}/g, "$1$1$1");          // "Noooooo" → "Nooo"
    let style: Style = {};
    if (caps || allCaps) word = word.toLowerCase();                    // so it isn't spelled out letter by letter
    if (caps)            style = add(style, { volume: 30 * m, pitch: 5 * m, rate: -3 });
    if (stretch)         style = add(style, { rate: -22 * m, volume: 8 * m });
    if (question && i === lastWord) style = add(style, { pitch: 6 * m });   // voice rises on the last word
    push(word, style);
  });

  const styled = !isEmpty(outer) || runs.some((r) => !isEmpty(r.style));
  let xml = runs.map((r) => wrap(esc(r.text), r.style)).join("");
  if (!isEmpty(outer)) xml = wrap(xml, outer);
  return { xml, styled };
}

/**
 * Text → SSML body (to be placed inside the speech library's own <prosody>), already XML-escaped.
 * Returns null when there's nothing expressive in the text — plain text is used then.
 */
export function expressiveBody(text: string, level: ExpressionLevel): string | null {
  if (level === "off") return null;
  const m = level === "strong" ? 1.6 : 1;
  let styledAny = false;
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?…]+["'”’)\]]*)\s+/)) {
    const { xml, styled } = sentenceToSsml(sentence, m);
    if (styled) styledAny = true;
    if (xml) out.push(xml);
  }
  return styledAny ? out.join(" ") : null;
}

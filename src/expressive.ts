// Gives Bing (Edge) voices some emotion using the speech library's DOCUMENTED options (volume / pitch / rate).
//   WORDS IN CAPS       → louder, a bit higher        (a whole CAPS sentence → much louder)
//   Sentences with !    → louder and a touch faster   (!! → more)
//   Questions ?         → raised pitch
//   Trailing … / ...    → slower, trailing off
//   Noooooo / Waaah     → stretched: slower and louder
// A chunk is cut into short "runs" of sentences with the same style; each run is one request.
// (Hand-written nested SSML was rejected by the service, so it isn't used any more.)

export type ExpressionLevel = "off" | "normal" | "strong";
export const EXPRESSION_LEVELS: ExpressionLevel[] = ["off", "normal", "strong"];

export interface Prosody { volume?: string; pitch?: string; rate?: string }
export interface Run { text: string; prosody: Prosody | null }

interface Style { volume: number; pitch: number; rate: number }

// ALL-CAPS words that are just names/abbreviations, not shouting
const ACRONYMS = new Set([
  "TL", "TN", "LN", "WN", "OP", "AI", "UK", "US", "USA", "NPC", "OK", "TV", "DJ", "ID", "HP", "MP", "PC", "UN", "EU",
  "CEO", "GPS", "HQ", "RPG", "MC", "VR", "PS", "FAQ", "PDF", "CIA", "FBI", "NASA",
]);

const pct = (n: number, lo: number, hi: number): string => {
  const v = Math.round(Math.min(hi, Math.max(lo, n)));
  return `${v >= 0 ? "+" : ""}${v}%`;
};

function sentenceStyle(sentence: string, m: number): Style {
  const text = sentence.trim();
  const s: Style = { volume: 0, pitch: 0, rate: 0 };
  if (!text) return s;

  const punct    = text.match(/([!?.…]+)["'”’)\]]*$/)?.[1] ?? "";
  const bangs    = (punct.match(/!/g) ?? []).length;
  const question = punct.includes("?");
  const trailing = /(\.{3,}|…)["'”’)\]]*$/.test(text);

  const words     = text.match(/[A-Za-z][A-Za-z'’]*/g) ?? [];
  const letters   = text.replace(/[^A-Za-z]/g, "");
  const upper     = letters.replace(/[^A-Z]/g, "").length;
  const allCaps   = letters.length >= 4 && words.length >= 2 && upper / letters.length >= 0.9;
  const capsWords = words.filter((w) => w.length >= 2 && w === w.toUpperCase() && !ACRONYMS.has(w) && !/^[IVXLCDM]{2,5}$/.test(w)).length;
  const stretched = words.some((w) => /([A-Za-z])\1{2,}/.test(w));

  if (bangs > 0)  { s.volume += 14 * m; s.pitch += 3 * m; s.rate += 4 * m; }
  if (bangs > 1)  { s.volume += 10 * m; }
  if (question)   { s.pitch  += 4 * m; }
  if (trailing)   { s.rate   -= 10 * m; }
  if (allCaps)    { s.volume += 35 * m; s.pitch += 5 * m; s.rate -= 3; }
  else if (capsWords > 0) { const part = capsWords / Math.max(1, words.length); s.volume += (part >= 0.25 ? 24 : 14) * m; s.pitch += (part >= 0.25 ? 4 : 2) * m; }
  if (stretched)  { s.rate   -= 12 * m; s.volume += 5 * m; }
  return s;
}

function toProsody(s: Style): Prosody | null {
  const out: Prosody = {};
  if (Math.round(s.volume)) out.volume = pct(s.volume, -40, 50);
  if (Math.round(s.pitch))  out.pitch  = pct(s.pitch, -20, 15);
  if (Math.round(s.rate))   out.rate   = pct(s.rate, -30, 10);
  return Object.keys(out).length > 0 ? out : null;
}

const keyOf = (p: Prosody | null): string => (p ? `${p.volume ?? ""}|${p.pitch ?? ""}|${p.rate ?? ""}` : "");
const MAX_RUNS = 4;

/**
 * Cut text into runs of sentences that share a style. Returns null when nothing in the text is
 * expressive (plain text is used then, in a single request).
 */
export function expressiveRuns(text: string, level: ExpressionLevel): Run[] | null {
  if (level === "off") return null;
  const m = level === "strong" ? 1.6 : 1;

  const runs: Run[] = [];
  for (const sentence of text.split(/(?<=[.!?…]+["'”’)\]]*)\s+/)) {
    const t = sentence.trim();
    if (!t) continue;
    const prosody = toProsody(sentenceStyle(t, m));
    const last = runs[runs.length - 1];
    if (last && keyOf(last.prosody) === keyOf(prosody)) last.text += " " + t;
    else runs.push({ text: t, prosody });
  }

  if (runs.every((r) => r.prosody === null)) return null;
  if (runs.length > MAX_RUNS) {                                    // don't spend many requests on one chunk
    const rest = runs.splice(MAX_RUNS - 1);
    runs.push({ text: rest.map((r) => r.text).join(" "), prosody: null });
  }
  return runs;
}

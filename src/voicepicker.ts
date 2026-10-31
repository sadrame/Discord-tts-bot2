import { readFile } from "fs/promises";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { VOICES, serviceName } from "./voices.js";
import type { VoiceOption } from "./voices.js";
import {
  elevenEnabled,
  listAccountVoices,
  searchLibraryVoices,
  addLibraryVoice,
  fetchPreview,
  elevenSynthesize,
  getUsage,
} from "./eleven.js";
import { textToMp3File, cleanupFile } from "./tts.js";
import { getGuildVoice, setGuildVoice, hydrateGuildVoice } from "./voice.js";

// Voice picker UI: service filters (Bing / ElevenLabs / Reader), search, Test, Apply.
// All component customIds start with "vp_" and are routed here by index.ts.

export type VoiceFilter = "all" | "edge" | "eleven" | "reader";

const FILTERS: { id: VoiceFilter; label: string; emoji: string }[] = [
  { id: "all",    label: "All",        emoji: "🎙️" },
  { id: "edge",   label: "Bing",       emoji: "🔷" },
  { id: "eleven", label: "ElevenLabs", emoji: "✨" },
  { id: "reader", label: "Reader",     emoji: "📖" },
];

export function parseFilter(s: string | null | undefined): VoiceFilter {
  return s === "edge" || s === "eleven" || s === "reader" ? s : "all";
}

const FLAG: Record<string, string> = {
  American: "🇺🇸", British: "🇬🇧", Australian: "🇦🇺", Irish: "🇮🇪",
  Indian: "🇮🇳", Canadian: "🇨🇦", "South african": "🇿🇦",
};

const SAMPLE_TEXT = "The lantern flickered as she opened the old book and began to read aloud.";
const MAX_OPTIONS = 25;   // Discord's select-menu limit

type Row = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>;
export interface ViewPayload {
  content:    string;
  embeds:     EmbedBuilder[];
  components: Row[];
}

// ─── Caches ───────────────────────────────────────────────────────────────────

const voiceCache = new Map<string, VoiceOption>();

function voiceKey(v: VoiceOption): string {
  return `${v.service === "elevenlabs" ? "el" : "edge"}:${v.id}`;
}

function remember(voices: VoiceOption[]): void {
  for (const v of voices) {
    voiceCache.set(voiceKey(v), v);
    if (voiceCache.size > 600) voiceCache.delete(voiceCache.keys().next().value!);
  }
}

function lookup(key: string): VoiceOption | undefined {
  const cached = voiceCache.get(key);
  if (cached) return cached;
  if (key.startsWith("edge:")) return VOICES.find((v) => v.id === key.slice(5));
  return undefined;
}

type LastView = { kind: "home"; filter: VoiceFilter } | { kind: "search"; filter: VoiceFilter; query: string };
const lastViews = new Map<string, LastView>();

function setLast(guildId: string, userId: string, view: LastView): void {
  lastViews.set(`${guildId}:${userId}`, view);
  if (lastViews.size > 300) lastViews.delete(lastViews.keys().next().value!);
}

// ─── Building blocks ──────────────────────────────────────────────────────────

function serviceTag(v: VoiceOption): string {
  if (v.service === "edge") return "🔷 Bing";
  return v.reader ? "📖 Reader" : "✨ ElevenLabs";
}

function describe(v: VoiceOption): string {
  const flag = FLAG[v.accent] ?? "🌐";
  const bits = [serviceTag(v), `${flag} ${v.accent} ${v.gender}`];
  if (v.style) bits.push(v.style);
  return bits.join(" · ").slice(0, 100);
}

function filterRow(current: VoiceFilter, query?: string): ActionRowBuilder<ButtonBuilder> {
  const q = query === undefined ? undefined : query.replace(/\s+/g, " ").trim().slice(0, 60);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    FILTERS.map((f) =>
      new ButtonBuilder()
        .setCustomId(q === undefined ? `vp_f:${f.id}` : `vp_s:${f.id}:${q}`)
        .setEmoji(f.emoji)
        .setLabel(f.label)
        .setStyle(f.id === current ? ButtonStyle.Primary : ButtonStyle.Secondary)
    )
  );
}

function selectRow(voices: VoiceOption[]): ActionRowBuilder<StringSelectMenuBuilder> | null {
  const shown = voices.slice(0, MAX_OPTIONS);
  if (shown.length === 0) return null;
  remember(shown);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("vp_pick")
      .setPlaceholder("Choose a voice to preview…")
      .addOptions(
        shown.map((v) => ({
          label:       v.label.slice(0, 100),
          description: describe(v),
          value:       voiceKey(v),
        }))
      )
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function matchEdge(query: string): VoiceOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return VOICES;
  return VOICES.filter((v) => {
    const hay = `${v.label} ${v.accent} ${v.gender} ${v.style} ${v.id}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

function dedupe(voices: VoiceOption[]): VoiceOption[] {
  const seen = new Set<string>();
  return voices.filter((v) => {
    const k = voiceKey(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const NO_KEY_NOTE = "⚠️ ElevenLabs isn't set up on this bot yet (the host needs to add an `ELEVENLABS_API_KEY`).";

/** Collect voices for a filter — a search when `query` is given, otherwise a browse list. */
async function collect(filter: VoiceFilter, query: string): Promise<{ voices: VoiceOption[]; notes: string[] }> {
  const notes: string[] = [];
  const out: VoiceOption[] = [];

  if (filter === "all" || filter === "edge") {
    const edge = query ? matchEdge(query) : VOICES;
    out.push(...(filter === "all" ? edge.slice(0, 8) : edge));
  }

  if (filter !== "edge") {
    if (!elevenEnabled()) {
      if (filter !== "all") notes.push(NO_KEY_NOTE);
    } else {
      try {
        const readerOnly = filter === "reader";
        const [account, library] = await Promise.all([
          readerOnly ? Promise.resolve<VoiceOption[]>([]) : listAccountVoices(query),
          searchLibraryVoices(query, readerOnly),
        ]);
        out.push(...account, ...library);
      } catch (err) {
        notes.push(`⚠️ ElevenLabs lookup failed: ${errText(err)}`);
      }
    }
  }
  return { voices: dedupe(out).slice(0, MAX_OPTIONS), notes };
}

// ─── Views ────────────────────────────────────────────────────────────────────

async function homeView(guildId: string, filter: VoiceFilter): Promise<ViewPayload> {
  await hydrateGuildVoice(guildId);
  const current = getGuildVoice(guildId);
  const { voices, notes } = await collect(filter, "");

  const lines = [`🎙️ Current voice: **${current.label}** (${serviceName(current)})`];
  if (filter === "eleven" && elevenEnabled()) {
    const usage = await getUsage();
    if (usage) lines.push(`✨ ElevenLabs usage: **${usage.used.toLocaleString()} / ${usage.limit.toLocaleString()}** characters this period`);
  }
  lines.push(...notes);
  lines.push(voices.length > 0
    ? "Pick a voice to preview it — you can **Test** it before you **Apply** it."
    : "No voices to show here.");
  lines.push("Search for more with `/voicesearch <name or style>`.");

  const rows: Row[] = [filterRow(filter)];
  const select = selectRow(voices);
  if (select) rows.push(select);
  return { content: lines.join("\n"), embeds: [], components: rows };
}

async function searchView(guildId: string, filter: VoiceFilter, query: string): Promise<ViewPayload> {
  await hydrateGuildVoice(guildId);
  const { voices, notes } = await collect(filter, query);
  const filterName = FILTERS.find((f) => f.id === filter)?.label ?? "All";

  const lines = [
    voices.length > 0
      ? `🔍 **${voices.length}** voice${voices.length === 1 ? "" : "s"} for “${query}” (${filterName})`
      : `🔍 No voices found for “${query}” (${filterName}). Try another word, or switch the filter below.`,
    ...notes,
  ];
  if (voices.length > 0) lines.push("Pick one to preview it, then **Test** and **Apply**.");

  const rows: Row[] = [filterRow(filter, query)];
  const select = selectRow(voices);
  if (select) rows.push(select);
  return { content: lines.join("\n"), embeds: [], components: rows };
}

function detailView(guildId: string, voice: VoiceOption): ViewPayload {
  const current   = getGuildVoice(guildId);
  const isCurrent = current.id === voice.id && current.service === voice.service;
  const flag      = FLAG[voice.accent] ?? "🌐";

  const embed = new EmbedBuilder()
    .setColor(voice.service === "elevenlabs" ? 0x9B59B6 : 0x2F80ED)
    .setTitle(`${serviceTag(voice)} — ${voice.label}`)
    .addFields(
      { name: "Service", value: serviceName(voice),                        inline: true },
      { name: "Accent",  value: `${flag} ${voice.accent}`,                  inline: true },
      { name: "Gender",  value: voice.gender,                               inline: true },
      { name: "Style",   value: voice.style || "—" },
    )
    .setFooter({ text: isCurrent ? "This is your current voice." : "Tap Test to hear a sample, then Apply." });

  if (voice.service === "elevenlabs") {
    embed.addFields({ name: "Cost", value: "Reading with this voice uses your ElevenLabs credits. Test samples are free." });
  }

  const key = voiceKey(voice);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`vp_test:${key}`).setEmoji("🔊").setLabel("Test").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`vp_apply:${key}`).setEmoji("✅").setLabel(isCurrent ? "Applied" : "Apply").setStyle(ButtonStyle.Success).setDisabled(isCurrent),
    new ButtonBuilder().setCustomId("vp_back").setEmoji("⬅️").setLabel("Back").setStyle(ButtonStyle.Secondary),
  );
  return { content: "🎙️ Voice preview", embeds: [embed], components: [row] };
}

// ─── Public entry points ──────────────────────────────────────────────────────

export async function showVoiceHome(guildId: string, userId: string, filter: VoiceFilter = "all"): Promise<ViewPayload> {
  setLast(guildId, userId, { kind: "home", filter });
  return homeView(guildId, filter);
}

export async function showVoiceSearch(guildId: string, userId: string, query: string, filter: VoiceFilter = "all"): Promise<ViewPayload> {
  const q = query.replace(/\s+/g, " ").trim().slice(0, 60);
  if (!q) return showVoiceHome(guildId, userId, filter);
  setLast(guildId, userId, { kind: "search", filter, query: q });
  return searchView(guildId, filter, q);
}

// ─── Test samples ─────────────────────────────────────────────────────────────

async function sampleFor(voice: VoiceOption): Promise<{ buffer: Buffer; name: string }> {
  const safeName = voice.label.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 30) || "voice";
  if (voice.service === "elevenlabs") {
    const buffer = voice.previewUrl
      ? await fetchPreview(voice.previewUrl)                 // hosted sample — free
      : await elevenSynthesize(SAMPLE_TEXT, voice.id);      // a few credits
    return { buffer, name: `${safeName}.mp3` };
  }
  const file = await textToMp3File(SAMPLE_TEXT, voice);
  try { return { buffer: await readFile(file), name: `${safeName}.mp3` }; }
  finally { await cleanupFile(file); }
}

// ─── Interaction router (customIds starting with "vp_") ───────────────────────

export async function handleVoiceInteraction(i: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
  const guildId = i.guildId;
  if (!guildId) return;
  const [action, ...rest] = i.customId.split(":");

  try {
    switch (action) {
      case "vp_f": {            // filter button on the home list
        await i.deferUpdate();
        const filter = parseFilter(rest[0]);
        await i.editReply(await showVoiceHome(guildId, i.user.id, filter));
        return;
      }

      case "vp_s": {            // filter button on search results
        await i.deferUpdate();
        const filter = parseFilter(rest[0]);
        await i.editReply(await showVoiceSearch(guildId, i.user.id, rest.slice(1).join(":"), filter));
        return;
      }

      case "vp_pick": {         // a voice was chosen from the list → preview card
        if (!i.isStringSelectMenu()) return;
        const voice = lookup(i.values[0] ?? "");
        if (!voice) {
          await i.reply({ content: "❌ That list expired — run `/voice` or `/voicesearch` again.", flags: MessageFlags.Ephemeral });
          return;
        }
        await i.deferUpdate();
        await i.editReply(detailView(guildId, voice));
        return;
      }

      case "vp_back": {
        await i.deferUpdate();
        const last = lastViews.get(`${guildId}:${i.user.id}`);
        if (last?.kind === "search") await i.editReply(await searchView(guildId, last.filter, last.query));
        else await i.editReply(await homeView(guildId, last?.filter ?? "all"));
        return;
      }

      case "vp_test": {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const voice = lookup(rest.join(":"));
        if (!voice) { await i.editReply("❌ That voice expired — run `/voice` again."); return; }
        try {
          const { buffer, name } = await sampleFor(voice);
          await i.editReply({
            content: `🔊 Sample of **${voice.label}** (${serviceName(voice)}). Like it? Tap **Apply** on the preview card.`,
            files:   [new AttachmentBuilder(buffer, { name })],
          });
        } catch (err) {
          await i.editReply(`❌ Couldn't make a sample: ${errText(err)}`);
        }
        return;
      }

      case "vp_apply": {
        await i.deferUpdate();
        let voice = lookup(rest.join(":"));
        if (!voice) { await i.editReply({ content: "❌ That voice expired — run `/voice` again.", embeds: [], components: [] }); return; }

        let warning = "";
        if (voice.service === "elevenlabs") {
          if (!elevenEnabled()) {
            await i.editReply({ content: NO_KEY_NOTE, embeds: [], components: [] });
            return;
          }
          const added = await addLibraryVoice(voice);      // no-op for voices already on the account
          voice   = { ...voice, id: added.id };
          warning = added.warning ? `\n⚠️ ${added.warning}` : "";
        }

        setGuildVoice(guildId, voice);
        const flag = FLAG[voice.accent] ?? "🌐";
        await i.editReply({
          content:    `✅ Voice set to **${voice.label}** (${serviceName(voice)}) ${flag} ${voice.accent} ${voice.gender}${warning}\nIf a chapter is playing, the new voice starts with the next sentence.`,
          embeds:     [],
          components: [],
        });
        return;
      }
    }
  } catch (err) {
    console.error(`[voicepicker:${action}]`, err);
    const msg = `❌ Something went wrong: ${errText(err)}`;
    if (i.deferred || i.replied) await i.followUp({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    else await i.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

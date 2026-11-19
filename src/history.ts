import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from "discord.js";
import type { ButtonInteraction } from "discord.js";
import { kvListPush, kvListRange, kvPersistent } from "./kv.js";

// What each person has read. Stored per USER (not per server), with the server's name saved in every
// entry — so it survives the bot (or the person) being kicked or banned from a server, and can be
// opened from any server or from a DM.

export interface HistoryEntry {
  u:  string;     // link
  t:  string;     // title
  g:  string;     // server id
  n:  string;     // server name (as it was when read)
  at: number;     // when (ms)
}

const MAX_ENTRIES = 300;
const PER_PAGE    = 10;
const keyFor = (userId: string): string => `wct:hist:${userId}`;

export async function recordHistory(userId: string, e: HistoryEntry): Promise<void> {
  const entry: HistoryEntry = { u: e.u.slice(0, 400), t: e.t.slice(0, 100), g: e.g, n: e.n.slice(0, 60), at: e.at };
  await kvListPush(keyFor(userId), JSON.stringify(entry), MAX_ENTRIES).catch(() => {});
}

/** Newest first. */
export async function getHistory(userId: string): Promise<HistoryEntry[]> {
  const out: HistoryEntry[] = [];
  for (const raw of await kvListRange(keyFor(userId), MAX_ENTRIES)) {
    try {
      const e = JSON.parse(raw) as HistoryEntry;
      if (e && typeof e.u === "string" && typeof e.at === "number") out.push(e);
    } catch { /* skip a damaged entry */ }
  }
  return out;
}

export type HistoryScope = "guild" | "all";

/** Applies the scope and collapses repeats of the same link within 30 minutes (resuming isn't a new read). */
export function filterEntries(entries: HistoryEntry[], scope: HistoryScope, guildId: string | null): HistoryEntry[] {
  const scoped = scope === "guild" && guildId ? entries.filter((e) => e.g === guildId) : entries;
  const out: HistoryEntry[] = [];
  for (const e of scoped) {
    if (!out.some((p) => p.u === e.u && p.g === e.g && Math.abs(p.at - e.at) < 30 * 60_000)) out.push(e);
  }
  return out;
}

const linkText = (t: string): string => {
  const c = t.replace(/[\[\]]/g, (ch) => (ch === "[" ? "(" : ")")).replace(/\s+/g, " ").trim() || "Untitled";
  return c.length > 60 ? `${c.slice(0, 57)}…` : c;
};
const linkUrl = (u: string): string => u.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");

export interface HistoryView { userId: string; scope: HistoryScope; guildId: string | null }

export function buildHistoryPayload(entries: HistoryEntry[], page: number, view: HistoryView): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const where = view.scope === "all" ? "all servers" : "this server";
  const embed = new EmbedBuilder().setColor(0x2b2d31).setTitle("📚 Your reading history");

  if (entries.length === 0) {
    embed.setDescription(`Nothing here yet for **${where}**. Links you read with \`/read\` will show up here.`);
    if (!kvPersistent()) embed.setFooter({ text: "⚠️ History is only kept until the bot restarts (permanent storage isn't set up)." });
    return { embeds: [embed], components: [] };
  }

  const pages = Math.max(1, Math.ceil(entries.length / PER_PAGE));
  const p     = Math.min(Math.max(1, page), pages);
  const start = (p - 1) * PER_PAGE;
  const lines = entries.slice(start, start + PER_PAGE).map((e, i) => {
    const server = view.scope === "all" ? ` · **${e.n.replace(/\*/g, "")}**` : "";
    return `${start + i + 1}. [${linkText(e.t)}](${linkUrl(e.u)})${server} · <t:${Math.floor(e.at / 1000)}:R>`;
  });
  embed.setDescription(lines.join("\n"));
  embed.setFooter({
    text: `Page ${p}/${pages} · ${entries.length} link${entries.length === 1 ? "" : "s"} · ${where}` +
          (kvPersistent() ? "" : " · ⚠️ not saved permanently (storage not set up)"),
  });

  const id = (a: string, to: number) => `${a}:${view.userId}:${view.scope}:${view.guildId ?? "0"}:${to}`;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(id("h_prev", p - 1)).setEmoji("◀️").setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(p <= 1),
    new ButtonBuilder().setCustomId(id("h_next", p + 1)).setEmoji("▶️").setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(p >= pages),
    new ButtonBuilder().setCustomId(id("h_close", p)).setEmoji("✖️").setLabel("Close").setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

/** Paging buttons — only the person the history belongs to can use them. */
export async function handleHistoryInteraction(i: ButtonInteraction): Promise<void> {
  const [action, userId, scope, guildId, pageStr] = i.customId.split(":");
  if (i.user.id !== userId) {
    await i.reply({ content: "❌ That's someone else's history — run `/history` to see yours.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (action === "h_close") { await i.update({ content: "Closed.", embeds: [], components: [] }).catch(() => {}); return; }

  const page  = parseInt(pageStr ?? "1", 10) || 1;
  const view: HistoryView = { userId: userId!, scope: scope === "guild" ? "guild" : "all", guildId: guildId && guildId !== "0" ? guildId : null };
  const entries = filterEntries(await getHistory(userId!), view.scope, view.guildId);
  await i.update(buildHistoryPayload(entries, page, view)).catch(() => {});
}

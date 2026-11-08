import { createHash } from "crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} from "discord.js";
import type {
  ButtonInteraction,
  Guild,
  GuildMember,
  Message,
  StringSelectMenuInteraction,
  TextBasedChannel,
  VoiceBasedChannel,
} from "discord.js";
import { startReading, stopSession, getSession, getPrefs, getGuildVoice, setSessionFinishedHook } from "./voice.js";
import { getBookmark } from "./bookmarks.js";
import { withTimeout } from "./util.js";
import type { ChapterSection } from "./scraper.js";

// A per-server queue of links. The first link plays right away; later ones wait and start by themselves
// (the bot stays in the voice channel between them). Skip moves on, Previous goes back.

export interface QueueItem {
  url:         string;
  title:       string;
  paragraphs:  string[];
  sections:    ChapterSection[];
  requestedBy: { id: string; tag: string };
  seconds:     number;                    // estimated reading time
}

interface GuildQueue {
  guild:        Guild;
  voiceChannel: VoiceBasedChannel;
  textChannel:  TextBasedChannel;
  ownerId:      string;                   // whoever started this queue
  current:      QueueItem | null;
  items:        QueueItem[];              // up next
  history:      QueueItem[];              // already played (for Previous)
}

const queues = new Map<string, GuildQueue>();
export const MAX_QUEUE = 50;
const MAX_HISTORY = 25;
const PER_PAGE = 10;
const WORDS_PER_SEC = 2.5;

// ─── Small helpers ────────────────────────────────────────────────────────────

export function estimateSeconds(paragraphs: string[], speed: number): number {
  const words = paragraphs.reduce((n, p) => n + p.trim().split(/\s+/).length, 0);
  return Math.max(1, Math.round(words / WORDS_PER_SEC / Math.max(0.5, speed)));
}

export function fmtClock(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const linkText = (title: string): string => {
  const t = title.replace(/[\[\]]/g, (c) => (c === "[" ? "(" : ")")).replace(/\s+/g, " ").trim();
  return t.length > 70 ? `${t.slice(0, 67)}…` : t;
};
const linkUrl  = (url: string): string => url.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
export const mdLink = (item: { title: string; url: string }): string => `[${linkText(item.title)}](${linkUrl(item.url)})`;
const tagOf    = (item: QueueItem): string => createHash("sha1").update(`${item.url}|${item.requestedBy.id}`).digest("hex").slice(0, 10);

async function say(q: GuildQueue, content: string): Promise<void> {
  try { await (q.textChannel as unknown as { send: (o: unknown) => Promise<unknown> }).send({ content, allowedMentions: { parse: [] } }); }
  catch (err) { console.error("[queue] couldn't send message:", (err as Error).message); }
}

// All changes to one server's queue happen one at a time
const locks = new Map<string, Promise<unknown>>();
function exclusive<T>(guildId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(guildId) ?? Promise.resolve();
  const run  = prev.catch(() => {}).then(fn);
  locks.set(guildId, run.catch(() => {}));
  return run;
}

// ─── Playing ──────────────────────────────────────────────────────────────────

type Why = "start" | "next" | "previous" | "jump";

async function startItem(q: GuildQueue, item: QueueItem, resume: boolean, why: Why): Promise<void> {
  q.current = item;

  let resumeFrom = 0;
  if (resume) {
    try {
      const b = await withTimeout(getBookmark(item.requestedBy.id, item.url), 6_000, "bookmark lookup");
      if (b && b.chunkIndex > 0) {
        resumeFrom = b.chunkIndex;
        const pct = Math.round((b.chunkIndex / Math.max(1, b.totalChunks)) * 100);
        await say(q, `📌 Resuming **${mdLink(item)}** from where you left off (${pct}% done). Use \`/restart\` to start from the beginning.`);
      }
    } catch (err) { console.warn(`[queue] bookmark lookup skipped: ${(err as Error).message}`); }
  }

  const voice = getGuildVoice(q.guild.id);
  if (why === "start") {
    await say(q,
      `📖 Starting **${mdLink(item)}** (${item.paragraphs.length} paragraphs)\n` +
      `🎙️ Voice: **${voice.label}** — ${voice.accent} ${voice.gender} | Joining **${q.voiceChannel.name}**`);
  } else {
    await say(q, `▶️ Now playing: **${mdLink(item)}** · requested by <@${item.requestedBy.id}>`);
  }
  if (item.sections.length > 1) {
    await say(q, `📑 Detected **${item.sections.length} sections** — use \`/chapter <n>\` or the ⬅️ ➡️ buttons to navigate.`);
  }

  console.log(`[queue] guild=${q.guild.id} starting "${item.title}" (${why}) resumeFrom=${resumeFrom}`);
  await startReading(
    q.guild, q.voiceChannel, q.textChannel, item.title, item.paragraphs, item.url, item.sections,
    resumeFrom, item.requestedBy.id, { reuseConnection: why !== "start" },
  );
}

/** Move to the next link. Returns false when there's nothing left to play. */
async function advanceLocked(q: GuildQueue): Promise<boolean> {
  if (q.current) {
    q.history.push(q.current);
    if (q.history.length > MAX_HISTORY) q.history.shift();
    q.current = null;
  }
  while (q.items.length > 0) {
    const next = q.items.shift()!;
    try { await startItem(q, next, true, "next"); return true; }
    catch (err) { await say(q, `❌ Couldn't start **${linkText(next.title)}**: ${(err as Error).message}`); }
  }
  return false;
}

// When a chapter ends by itself, start the next one (staying in the channel)
setSessionFinishedHook(async (session) => {
  const gid = session.guildId;
  const q = queues.get(gid);
  if (!q || q.items.length === 0) { queues.delete(gid); return false; }
  return exclusive(gid, async () => {
    const live = queues.get(gid);
    if (!live || live.items.length === 0) { queues.delete(gid); return false; }
    return advanceLocked(live);
  });
});

export type EnqueueResult =
  | { status: "started" }
  | { status: "queued"; position: number }
  | { status: "full" }
  | { status: "error"; message: string };

/** Plays the link now if nothing is playing, otherwise adds it to the end of the queue. */
export function enqueueOrPlay(args: { guild: Guild; voiceChannel: VoiceBasedChannel; textChannel: TextBasedChannel; item: QueueItem }): Promise<EnqueueResult> {
  const { guild, voiceChannel, textChannel, item } = args;
  return exclusive(guild.id, async (): Promise<EnqueueResult> => {
    let q = queues.get(guild.id);
    const playing = !!getSession(guild.id);

    if (!q || !playing) {                                   // nothing playing → a fresh queue (drops stale leftovers)
      q = { guild, voiceChannel, textChannel, ownerId: item.requestedBy.id, current: null, items: [], history: [] };
      queues.set(guild.id, q);
      try { await startItem(q, item, true, "start"); return { status: "started" }; }
      catch (err) { queues.delete(guild.id); return { status: "error", message: (err as Error).message }; }
    }

    if (q.items.length >= MAX_QUEUE) return { status: "full" };
    q.items.push(item);
    return { status: "queued", position: q.items.length };
  });
}

export function skipLink(guildId: string): Promise<string> {
  return exclusive(guildId, async () => {
    const q = queues.get(guildId);
    const s = getSession(guildId);
    if (!q || !s) return "❌ Nothing is currently playing.";
    const title = linkText(q.current?.title ?? s.title);
    const more = await advanceLocked(q);
    if (more) return `⏭️ Skipped **${title}**.`;
    await stopSession(guildId);
    queues.delete(guildId);
    return `⏭️ Skipped **${title}** — the queue is empty, so I left the channel.`;
  });
}

export function previousLink(guildId: string): Promise<string> {
  return exclusive(guildId, async () => {
    const q = queues.get(guildId);
    if (!q || !getSession(guildId)) return "❌ Nothing is currently playing.";
    const prev = q.history.pop();
    if (!prev) return "❌ There's no previous link.";
    if (q.current) q.items.unshift(q.current);              // the one we leave plays again afterwards
    try { await startItem(q, prev, false, "previous"); }
    catch (err) { return `❌ Couldn't go back: ${(err as Error).message}`; }
    return `⏮️ Back to **${mdLink(prev)}**.`;
  });
}

export function removeItem(guildId: string, position: number, actorId: string, actorCanControl: boolean): Promise<string> {
  return exclusive(guildId, async () => {
    const q = queues.get(guildId);
    const item = q?.items[position - 1];
    if (!q || !item) return `❌ There's no #${position} in the queue.`;
    if (!actorCanControl && item.requestedBy.id !== actorId) return denyMessage(guildId);
    q.items.splice(position - 1, 1);
    return `🗑️ Removed **${mdLink(item)}** from the queue.`;
  });
}

export function clearQueue(guildId: string): string {
  const q = queues.get(guildId);
  if (!q || q.items.length === 0) return "❌ The queue is already empty.";
  const n = q.items.length;
  q.items = [];
  return `🧹 Cleared **${n}** link${n === 1 ? "" : "s"} from the queue.`;
}

/** /stop: forget the queue as well. */
export function clearAll(guildId: string): void { queues.delete(guildId); }

function jumpByTag(guildId: string, hash: string, mode: "now" | "next"): Promise<string> {
  return exclusive(guildId, async () => {
    const q = queues.get(guildId);
    const idx = q ? q.items.findIndex((it) => tagOf(it) === hash) : -1;
    if (!q || idx === -1) return "❌ That item is no longer in the queue.";
    const [item] = q.items.splice(idx, 1);
    if (mode === "next") { q.items.unshift(item!); return `⬆️ **${mdLink(item!)}** will play next.`; }
    if (q.current) { q.history.push(q.current); if (q.history.length > MAX_HISTORY) q.history.shift(); }
    try { await startItem(q, item!, true, "jump"); }
    catch (err) { return `❌ Couldn't start it: ${(err as Error).message}`; }
    return `▶️ Playing **${mdLink(item!)}** now.`;
  });
}

// ─── Who may control playback ─────────────────────────────────────────────────

/**
 * Default ("restricted"): the person who started the queue, the person who queued the link that's playing,
 * and anyone with Manage Server can skip / pause / seek / stop. Everyone can add links and view the queue.
 * If the owner has left the voice channel, anyone in the channel can steer. `/controls open` lets everyone.
 */
export function canControl(guildId: string, member: GuildMember | null): boolean {
  if (getPrefs(guildId).controls === "open") return true;
  const q = queues.get(guildId);
  if (!q || !getSession(guildId) || !member) return true;     // nothing playing (or a DM) — nothing to protect
  if (typeof member.permissions !== "string" && member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  if (member.id === q.ownerId || member.id === q.current?.requestedBy.id) return true;
  const owner = q.guild.members.cache.get(q.ownerId);
  const here  = member.voice?.channelId;
  return !!here && here === q.voiceChannel.id && owner?.voice?.channelId !== q.voiceChannel.id;
}

export function denyMessage(guildId: string): string {
  const q = queues.get(guildId);
  const who = q ? `<@${q.ownerId}>${q.current && q.current.requestedBy.id !== q.ownerId ? ` or <@${q.current.requestedBy.id}>` : ""}` : "the person who started it";
  return `🔒 Only ${who} (or someone with Manage Server) can do that right now. Anyone can add links with \`/read\`.`;
}

export function queueOwnerId(guildId: string): string | null { return queues.get(guildId)?.ownerId ?? null; }

// ─── The queue screen (Jockie-style) ──────────────────────────────────────────

type Row = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>;
export interface QueuePayload { embeds: EmbedBuilder[]; components: Row[] }

/** The numbered list for one page: `1. [03:33] Title` with the title as a link. */
export function formatQueueText(items: QueueItem[], page: number): string {
  const start = (page - 1) * PER_PAGE;
  return items
    .slice(start, start + PER_PAGE)
    .map((it, i) => `${start + i + 1}. \`[${fmtClock(it.seconds)}]\` ${mdLink(it)}`)
    .join("\n");
}

export function pageCount(guildId: string): number {
  return Math.max(1, Math.ceil((queues.get(guildId)?.items.length ?? 0) / PER_PAGE));
}

export function buildQueuePayload(guildId: string, page = 1): QueuePayload {
  const q = queues.get(guildId);
  const items = q?.items ?? [];
  const pages = Math.max(1, Math.ceil(items.length / PER_PAGE));
  const p = Math.min(Math.max(1, page), pages);
  const embed = new EmbedBuilder().setColor(0x2b2d31);

  if (items.length === 0) {
    embed.setDescription(q?.current
      ? `The queue is empty — nothing is up next.\n\nNow playing: ${mdLink(q.current)}`
      : "The queue is empty.");
    return { embeds: [embed], components: [] };
  }

  embed.setDescription(`Page **${p}/${pages}**\n\n${formatQueueText(items, p)}\n\nnext page | previous page | go to page <page> | cancel`);

  const start = (p - 1) * PER_PAGE;
  const select = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("q_sel")
      .setPlaceholder("Make a selection")
      .addOptions(items.slice(start, start + PER_PAGE).map((it, i) => ({
        label:       `${start + i + 1}. ${linkText(it.title)}`.slice(0, 100),
        description: `[${fmtClock(it.seconds)}] requested by ${it.requestedBy.tag}`.slice(0, 100),
        value:       tagOf(it),
      }))),
  );
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`q_prev:${p}`).setEmoji("◀️").setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(p <= 1),
    new ButtonBuilder().setCustomId(`q_next:${p}`).setEmoji("▶️").setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(p >= pages),
    new ButtonBuilder().setCustomId("q_cancel").setEmoji("✖️").setLabel("Cancel").setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [select, buttons] };
}

const pageByMessage = new Map<string, number>();

/** Lets the person who opened the queue also type "next page", "previous page", "go to page 3" or "cancel". */
export function attachQueueTyping(msg: Message, channel: TextBasedChannel, userId: string, guildId: string, startPage = 1): void {
  pageByMessage.set(msg.id, startPage);
  const collector = (channel as unknown as {
    createMessageCollector: (o: unknown) => { on: (e: string, cb: (m: Message) => void | Promise<void>) => void; stop: (r?: string) => void };
  }).createMessageCollector({ filter: (m: Message) => m.author.id === userId, time: 60_000 });

  collector.on("collect", async (m: Message) => {
    const t = m.content.trim().toLowerCase();
    const total = pageCount(guildId);
    const cur = pageByMessage.get(msg.id) ?? 1;
    let next: number | null = null;
    if (/^(next|next page|n)$/.test(t)) next = Math.min(total, cur + 1);
    else if (/^(prev|previous|previous page|p)$/.test(t)) next = Math.max(1, cur - 1);
    else {
      const g = t.match(/^(?:go to page|goto|page)\s+(\d+)$/);
      if (g) next = Math.min(total, Math.max(1, parseInt(g[1]!, 10)));
      else if (t === "cancel") { collector.stop("cancel"); await msg.delete().catch(() => {}); await m.delete().catch(() => {}); return; }
    }
    if (next === null) return;
    pageByMessage.set(msg.id, next);
    await msg.edit(buildQueuePayload(guildId, next)).catch(() => {});
    await m.delete().catch(() => {});
  });
  collector.on("end", () => { msg.edit({ components: [] }).catch(() => {}); pageByMessage.delete(msg.id); });
}

/** Buttons and the "Make a selection" menu on the queue screen. */
export async function handleQueueInteraction(i: ButtonInteraction | StringSelectMenuInteraction, member: GuildMember | null): Promise<void> {
  const guildId = i.guildId;
  if (!guildId) return;
  const [action, arg] = i.customId.split(":");

  switch (action) {
    case "q_prev":
    case "q_next": {
      const cur  = parseInt(arg ?? "1", 10) || 1;
      const want = action === "q_next" ? cur + 1 : cur - 1;
      const page = Math.min(pageCount(guildId), Math.max(1, want));
      pageByMessage.set(i.message.id, page);
      await i.update(buildQueuePayload(guildId, page));
      return;
    }

    case "q_cancel": {
      await i.deferUpdate().catch(() => {});
      await i.message.delete().catch(() => i.editReply({ content: "Closed.", embeds: [], components: [] }).catch(() => {}));
      return;
    }

    case "q_sel": {                                          // an entry was picked → what to do with it?
      if (!i.isStringSelectMenu()) return;
      const hash = i.values[0] ?? "";
      const q = queues.get(guildId);
      const item = q?.items.find((it) => tagOf(it) === hash);
      if (!q || !item) { await i.reply({ content: "❌ That item is no longer in the queue.", flags: MessageFlags.Ephemeral }); return; }
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`q_play:${hash}`).setEmoji("▶️").setLabel("Play now").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`q_playnext:${hash}`).setEmoji("⬆️").setLabel("Play next").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`q_rm:${hash}`).setEmoji("🗑️").setLabel("Remove").setStyle(ButtonStyle.Danger),
      );
      await i.reply({
        content: `**${q.items.indexOf(item) + 1}.** ${mdLink(item)} · \`[${fmtClock(item.seconds)}]\` · requested by <@${item.requestedBy.id}>`,
        components: [row], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
      });
      return;
    }

    case "q_play":
    case "q_playnext":
    case "q_rm": {
      const hash = arg ?? "";
      const q = queues.get(guildId);
      const item = q?.items.find((it) => tagOf(it) === hash);
      const allowed = canControl(guildId, member);
      if (action === "q_rm") {
        if (!item) { await i.update({ content: "❌ That item is no longer in the queue.", components: [] }); return; }
        if (!allowed && item.requestedBy.id !== i.user.id) { await i.update({ content: denyMessage(guildId), components: [] }); return; }
        q!.items.splice(q!.items.indexOf(item), 1);
        await i.update({ content: `🗑️ Removed **${mdLink(item)}** from the queue.`, components: [] });
        return;
      }
      if (!allowed) { await i.update({ content: denyMessage(guildId), components: [] }); return; }
      await i.deferUpdate().catch(() => {});
      const result = await jumpByTag(guildId, hash, action === "q_play" ? "now" : "next");
      await i.editReply({ content: result, components: [] }).catch(() => {});
      return;
    }
  }
}

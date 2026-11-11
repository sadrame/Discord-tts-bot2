import { createServer } from "http";
import { createHash } from "crypto";
import { kvGet, kvSet } from "./kv.js";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  MessageFlags,
  Message,
  GuildMember,
  TextChannel,
  ChatInputCommandInteraction,
  ButtonInteraction,
  Interaction,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ComponentType,
  ChannelType,
  VoiceBasedChannel,
  Guild,
  User,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { scrapeChapter } from "./scraper.js";
import {
  startReading,
  stopSession,
  pauseSession,
  resumeSession,
  skipParagraph,
  seekSessionBySeconds,
  seekRelativeSeconds,
  restartSession,
  skipToChapter,
  forceProgressUpdate,
  getSession,
  getSessionByUserId,
  getProgressInfo,
  getProgressSeconds,
  getChapterInfo,
  getGuildVoice,
  hydrateGuildVoice,
  getPrefs,
  setPrefs,
  stepSpeed,
  fmtSpeed,
  seekByDelta,
  SPEED_MIN,
  SPEED_MAX,
  joinStandby,
  leaveStandby,
  getParagraphs,
  getCurrentParagraphIndex,
  seekToParagraph,
  setSearchState,
  getSearchState,
  saveAllBookmarks,
} from "./voice.js";
import type { GuildPrefs } from "./voice.js";
import { MARKER_MODES } from "./markers.js";
import {
  enqueueOrPlay, skipLink, previousLink, removeItem, clearQueue, clearAll, buildQueuePayload, attachQueueTyping,
  handleQueueInteraction, canControl, denyMessage, queueOwnerId, estimateSeconds, fmtClock, mdLink, pageCount,
} from "./queue.js";
import type { QueueItem } from "./queue.js";
import { withTimeout } from "./util.js";
import { EXPRESSION_LEVELS } from "./expressive.js";
import type { ExpressionLevel } from "./expressive.js";
import type { MarkerMode } from "./markers.js";
import { getBookmark } from "./bookmarks.js";
import { VOICES } from "./voices.js";
import { showVoiceHome, showVoiceSearch, parseFilter, handleVoiceInteraction } from "./voicepicker.js";
import { slashCommands } from "./commands.js";
import { searchParagraphs, pickStartPosition, snippetFor } from "./search.js";

const PREFIX = "!";

// ─── Global crash guards ──────────────────────────────────────────────────────
process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
process.on("uncaughtException",  (err)    => console.error("[uncaughtException]", err));

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`[${sig}] saving bookmarks before shutdown…`);
    saveAllBookmarks()
      .catch((err) => console.error("[shutdown] bookmark save failed:", err))
      .finally(() => process.exit(0));
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildProgressBar(pct: number, width = 20): string {
  const filled = Math.round((pct / 100) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

function inviteUrl(): string {
  const clientId = client.user?.id ?? "CLIENT_ID";
  // permissions: Create Instant Invite + Send Messages + Manage Messages + Embed Links +
  //              Read Message History + Connect + Speak
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=3237889&scope=bot+applications.commands`;
}

function helpLines(): string {
  return [
    "📖 **WCT Reader Bot**",
    "",
    "`/read <url> [channel]` — fetch a chapter and read it aloud",
    "`/join` — join your voice channel and wait",
    "`/stop` — stop reading and leave voice (saves your position)",
    "`/pause` — pause playback",
    "`/resume` — resume playback",
    "`/queue [page]` — show the queue · `/read <url>` while something plays adds it to the queue",
    "`/skip` — skip the current link and play the next · `/previous` — go back a link",
    "`/skipparagraph` — skip to the next paragraph · `/remove <n>` · `/clear` — manage the queue",
    "`/controls <restricted|open>` — who can skip/pause/seek (default: queue owner, the link's requester, Manage Server)",
    "`/find <text>` — search the chapter (typo-tolerant) and jump to it; use ⬅️ ➡️ to cycle matches",
    "`/speed [value]` — show/set reading speed (0.5×–3×); use the 🐢 🐇 buttons or ⚙️ Custom… on the player for your own step sizes",
    "`/rewind [amount]` · `/forward [amount]` — jump back/ahead, e.g. `30`, `1m`, `1m30s` (default: your skip step)",
    "`/skipstep <seconds>` — change the default ⏪/⏩ step",
    "`/markers [style] [notes]` — how scene breaks (△▼△▼) and ※ dividers are announced: chime, voice, both or off; and whether to skip translator's notes",
    "`/expression <off|normal|strong>` — Bing voices: CAPS get louder, ! and ? change the delivery, … trails off",
    "`/chapter <n>` — jump to chapter/section N",
    "`/chapters` — list all detected chapters in the current reading",
    "`/restart` — restart the chapter from the beginning",
    "`/seek <seconds>` — jump to a timestamp (e.g. `/seek 120` = 2:00)",
    "`/progress` — show current progress info",
    "`/voice` — pick a voice: filter by Bing, ElevenLabs or Reader, test it, then apply",
    "`/voicesearch <name or style>` — search voices (e.g. `sarah`, `british narrator`)",
    "`/invite` — get a link to add this bot to your server",
    "`/help` — show this message",
    "",
    "Progress embed buttons: ⏮️ Restart · ⏪ back · ⏸️ Pause · ⏩ forward · ⏹️ Stop",
    "Speed buttons: 🐢 Slower · 🐇 Faster · ⚙️ Custom… (speed, speed step, skip step)",
    "Chapter buttons: ⬅️ Prev Ch. · ➡️ Next Ch. (appear when chapters are detected)",
    "",
    "All commands also work with the `!` prefix.",
    "Supports WitchCultTranslations, AO3 and public Google Docs links.",
    "Your position is saved when you `!stop` — re-reading the same URL resumes automatically.",
  ].join("\n");
}

function helpPayload(): { embeds: EmbedBuilder[] } {
  const text = helpLines();
  return { embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(text.length > 4000 ? text.slice(0, 3990) + "…" : text)] };
}

async function safeSend(channel: TextChannel | null | undefined, content: string): Promise<void> {
  if (!channel) return;
  try { await channel.send(content); } catch (err) { console.error("[safeSend]", err); }
}

// ─── VC picker ────────────────────────────────────────────────────────────────

async function pickVoiceChannel(
  guild: Guild,
  textChannel: TextChannel,
  userId: string,
  replyFn: (payload: { content: string; components: ActionRowBuilder<StringSelectMenuBuilder>[] }) => Promise<Message | void>
): Promise<VoiceBasedChannel | null> {
  const vcs = guild.channels.cache.filter(
    (c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice
  );
  if (vcs.size === 0) {
    await replyFn({ content: "❌ No voice channels found in this server.", components: [] });
    return null;
  }

  const options = vcs.map((ch) => ({
    label:       ch.name.slice(0, 25),
    value:       ch.id,
    description: `${(ch as VoiceBasedChannel).members?.size ?? 0} members`,
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId("vc_pick")
    .setPlaceholder("Choose a voice channel…")
    .addOptions(options.slice(0, 25));

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  const sentMsg = await replyFn({ content: "🎙️ Which voice channel should I join?", components: [row] });

  try {
    const collected = await textChannel.awaitMessageComponent({
      componentType: ComponentType.StringSelect,
      // only the person who asked can answer the picker
      filter: (i) => i.customId === "vc_pick" && i.user.id === userId,
      time: 30_000,
    });
    await collected.deferUpdate();
    return guild.channels.cache.get(collected.values[0]!) as VoiceBasedChannel ?? null;
  } catch {
    if (sentMsg && "edit" in sentMsg) {
      await (sentMsg as Message).edit({ content: "⏱️ Timed out — no channel selected.", components: [] }).catch(() => {});
    }
    return null;
  }
}

// ─── Admin read log ───────────────────────────────────────────────────────────

async function logRead(user: User, guild: Guild, sourceChannel: TextChannel, url: string, voiceLabel: string): Promise<void> {
  const channelId = process.env["DISCORD_LOG_CHANNEL_ID"];
  if (!channelId) return;
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch || !("send" in ch)) return;
    const ts = `<t:${Math.floor(Date.now() / 1000)}:F>`;

    // Build a joinable server link: vanity URL first (no perms needed),
    // then createInvite with unique:false so Discord deduplicates (needs Create Instant Invite only)
    let serverLink = guild.name;
    try {
      if (guild.vanityURLCode) {
        serverLink = `[${guild.name}](https://discord.gg/${guild.vanityURLCode})`;
      } else {
        const inv = await sourceChannel.createInvite({ maxAge: 0, maxUses: 0, unique: false, reason: "Bot log invite" });
        serverLink = `[${guild.name}](${inv.url})`;
      }
    } catch { /* non-fatal — bot may lack Create Instant Invite permission in this channel */ }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("📋 Read request")
      .setThumbnail(user.displayAvatarURL())
      .addFields(
        { name: "👤 User:",   value: `${user.tag} (${user.id})`, inline: true },
        { name: "🏠 Server:", value: serverLink,                 inline: true },
        { name: "🎙️ Voice:",  value: voiceLabel,                 inline: true },
        { name: "🔗 URL:",    value: url.slice(0, 1000) },
        { name: "🕐 Time:",   value: ts },
      );
    await (ch as TextChannel).send({ embeds: [embed] });
  } catch { /* non-fatal — log channel may be unreachable */ }
}

// ─── Shared command logic ─────────────────────────────────────────────────────

async function handleRead(
  guildId: string,
  guild: Guild,
  textChannel: TextChannel,
  memberVC: VoiceBasedChannel | null | undefined,
  explicitVC: VoiceBasedChannel | null | undefined,
  rawUrl: string,
  requestedBy: User,
  replyFn: (payload: { content: string; components?: ActionRowBuilder<StringSelectMenuBuilder>[] }) => Promise<Message | void>
): Promise<void> {
  const t0  = Date.now();
  const log = (stage: string) => console.log(`[read] guild=${guildId} user=${requestedBy.id} ${stage} (+${Date.now() - t0}ms)`);
  const url = rawUrl.trim().replace(/^<|>$/g, "");                     // links pasted as <https://…> work too
  if (!/^https?:\/\/\S+$/i.test(url)) { await replyFn({ content: "❌ Please provide a valid URL." }); return; }
  log("start");

  // Saved voice/settings — never allowed to hold up a read
  try { await withTimeout(hydrateGuildVoice(guildId), 6_000, "Loading settings"); }
  catch (err) { console.warn(`[read] settings skipped: ${(err as Error).message}`); }
  log("settings ready");

  let voiceChannel: VoiceBasedChannel | null;
  if (explicitVC) {
    voiceChannel = explicitVC;
  } else if (memberVC) {
    voiceChannel = memberVC;
  } else {
    voiceChannel = await pickVoiceChannel(guild, textChannel, requestedBy.id,
      (p) => replyFn({ content: p.content, components: p.components })
    );
  }
  if (!voiceChannel) return;

  await replyFn({ content: "🔍 Fetching chapter..." });

  const isFile = /\.(pdf|txt)(#.*)?$/i.test(url);
  let chapter;
  try { chapter = await withTimeout(scrapeChapter(url), isFile ? 180_000 : 45_000, "Fetching that link"); }
  catch (err) { await replyFn({ content: `❌ Could not read that page: ${(err as Error).message}` }); return; }
  log(`scraped ${chapter.paragraphs.length} paragraphs`);

  // Log the request to the admin channel (fire-and-forget)
  logRead(requestedBy, guild, textChannel, url, getGuildVoice(guildId).label).catch(() => {});

  const item: QueueItem = {
    url,
    title:       chapter.title,
    paragraphs:  chapter.paragraphs,
    sections:    chapter.sections,
    requestedBy: { id: requestedBy.id, tag: requestedBy.username },
    seconds:     estimateSeconds(chapter.paragraphs, getPrefs(guildId).speed),
  };

  const result = await enqueueOrPlay({ guild, voiceChannel, textChannel, item });
  log(`queue → ${result.status}`);

  if (result.status === "queued") {
    await replyFn({ content: `➕ Added to the queue (#${result.position}): ${mdLink(item)} · \`[${fmtClock(item.seconds)}]\`` });
  } else if (result.status === "full") {
    await replyFn({ content: "❌ The queue is full (50 links). Wait for some to play or use `/remove`." });
  } else if (result.status === "error") {
    await replyFn({ content: `❌ Voice error: ${result.message}` });
  } else {
    await replyFn({ content: `✅ Got it — ${mdLink(item)}` });
  }
}

async function handleJoin(guild: Guild, memberVC: VoiceBasedChannel | null | undefined): Promise<string> {
  if (!memberVC) return "❌ You must be in a voice channel for me to join you!";
  try {
    await joinStandby(guild, memberVC);
    return `✅ Joined **${memberVC.name}**. Start something with \`/read <url>\` — I'll leave after 10 minutes if idle.`;
  } catch (err) {
    return `❌ Voice error: ${(err as Error).message}`;
  }
}

async function handleStop(guildId: string): Promise<string> {
  if (getSession(guildId)) {
    await stopSession(guildId);
    clearAll(guildId);
    return "⏹️ Stopped and left the voice channel. Your position has been saved — read the same URL to resume.";
  }
  if (leaveStandby(guildId)) return "👋 Left the voice channel.";
  return "❌ Nothing is currently playing.";
}

function handlePause(guildId: string): string {
  return pauseSession(guildId) ? "⏸️ Paused. Use `/resume` or `!resume` to continue." : "❌ Nothing is playing or already paused.";
}

function handleResume(guildId: string): string {
  return resumeSession(guildId) ? "▶️ Resuming..." : "❌ Nothing is paused.";
}

function handleSkipParagraph(guildId: string): string {
  return skipParagraph(guildId) ? "⏭️ Skipping to the next paragraph..." : "❌ Nothing is currently playing.";
}

function handleSkip(guildId: string): Promise<string> {
  return skipLink(guildId);
}

async function handleControls(guildId: string, member: GuildMember | null, mode: string | null): Promise<string> {
  await hydrateGuildVoice(guildId);
  const current = getPrefs(guildId).controls;
  if (mode !== "open" && mode !== "restricted") {
    return `🔐 Controls are **${current}**. ` + (current === "restricted"
      ? "Only the queue owner, whoever queued the current link, and people with Manage Server can skip/pause/seek. `/controls open` lets everyone."
      : "Anyone can skip/pause/seek. `/controls restricted` limits it again.");
  }
  const isManager = !!member && typeof member.permissions !== "string" && member.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!isManager && member?.id !== queueOwnerId(guildId)) return "🔒 Only someone with Manage Server (or the queue owner) can change this.";
  setPrefs(guildId, { controls: mode });
  return mode === "open"
    ? "🔓 Controls are now **open** — anyone can skip, pause and seek."
    : "🔐 Controls are now **restricted** — the queue owner, the requester of the current link and Manage Server members.";
}

function handleProgress(guildId: string): string {
  const info = getProgressInfo(guildId);
  if (!info) return "❌ Nothing is currently playing.";
  const pct = Math.round((info.index / info.total) * 100);
  return (
    `📖 **${info.title}**\n` +
    `${buildProgressBar(pct)} ${pct}%\n` +
    `📍 **Position:** Paragraph ${info.index} of ${info.total}` +
    (info.paused ? " *(paused)*" : "")
  );
}

// ─── /find — typo-tolerant search with prev/next match buttons ────────────────

interface FindReply {
  content:    string;
  components: ActionRowBuilder<ButtonBuilder>[];
}

function buildFindRow(total: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("find_prev").setEmoji("⬅️").setLabel("Prev").setStyle(ButtonStyle.Secondary).setDisabled(total <= 1),
    new ButtonBuilder().setCustomId("find_go").setEmoji("▶️").setLabel("Go to this").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("find_next").setEmoji("➡️").setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(total <= 1),
  );
}

function describeMatch(guildId: string, withButtons: boolean, jumped = false): FindReply {
  const state      = getSearchState(guildId);
  const paragraphs = getParagraphs(guildId);
  if (!state || !paragraphs) return { content: "❌ That search has expired — run `/find` again.", components: [] };

  const paraIdx = state.matches[state.pos]!;
  const text    = paragraphs[paraIdx] ?? "";
  const lines = [
    `🔍 ${state.fuzzy ? "Closest match" : "Match"} **${state.pos + 1}/${state.matches.length}** for “${state.query}” — paragraph **${paraIdx + 1}** of ${paragraphs.length}`,
    `*“${snippetFor(text, state.query)}”*`,
  ];
  if (state.fuzzy) lines.push("_No exact matches — showing similar spellings._");
  if (jumped) lines.push("✅ Jumped here — playback continues from this paragraph.");
  else if (withButtons) lines.push("Tap **Go to this** to jump there, or browse with ⬅️ ➡️.");
  return {
    content:    lines.join("\n"),
    components: withButtons ? [buildFindRow(state.matches.length)] : [],
  };
}

function handleFind(guildId: string, query: string, withButtons: boolean): FindReply {
  const fail = (content: string): FindReply => ({ content, components: [] });

  const paragraphs = getParagraphs(guildId);
  if (!paragraphs) return fail("❌ Nothing is currently playing — start a chapter with `/read` first.");

  const q = query.trim();
  if (!q) return fail("❌ Usage: `!find <text>`");
  if (q.length > 100) return fail("❌ Search text is too long (max 100 characters).");

  const result = searchParagraphs(paragraphs, q);
  if (result.matches.length === 0) {
    setSearchState(guildId, null);
    return fail(`❌ No paragraphs matching “${q}”.`);
  }

  const current = getCurrentParagraphIndex(guildId) ?? 0;
  const pos     = pickStartPosition(result.matches, current);
  setSearchState(guildId, { query: q, matches: result.matches, pos, fuzzy: result.fuzzy });

  // With buttons: show the match and wait for "Go to this".
  // Without buttons (DMs): there's nothing to tap, so jump straight away.
  if (!withButtons) {
    seekToParagraph(guildId, result.matches[pos]!);
    return describeMatch(guildId, false, true);
  }
  return describeMatch(guildId, true);
}

function stepFind(guildId: string, delta: number): FindReply | null {
  const state = getSearchState(guildId);
  if (!state || state.matches.length === 0) return null;
  const n = state.matches.length;
  state.pos = (state.pos + delta + n) % n;
  return describeMatch(guildId, true);
}

function goFind(guildId: string): FindReply | null {
  const state = getSearchState(guildId);
  if (!state || state.matches.length === 0) return null;
  if (!seekToParagraph(guildId, state.matches[state.pos]!)) return null;
  return describeMatch(guildId, true, true);
}

// ─── Speed, rewind and fast-forward ───────────────────────────────────────────

/** "30" → 30, "1m" → 60, "1m30s" → 90, "1:30" → 90. */
function parseDuration(input: string | null | undefined): number | null {
  if (!input) return null;
  const t = input.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(parseFloat(t));
  const colon = t.match(/^(\d+):(\d{1,2})$/);
  if (colon) return parseInt(colon[1]!, 10) * 60 + parseInt(colon[2]!, 10);
  const m = t.match(/^(?:(\d+)\s*m(?:in(?:ute)?s?)?)?\s*(?:(\d+)\s*s(?:ec(?:ond)?s?)?)?$/);
  if (m && (m[1] || m[2])) return parseInt(m[1] ?? "0", 10) * 60 + parseInt(m[2] ?? "0", 10);
  return null;
}

function fmtDur(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

function handleMove(guildId: string, direction: 1 | -1, amount: string | null | undefined): string {
  if (!getSession(guildId)) return "❌ Nothing is currently playing.";
  let sec = getPrefs(guildId).seekStep;
  if (amount && amount.trim()) {
    const parsed = parseDuration(amount);
    if (parsed === null || parsed < 1 || parsed > 3600) {
      return "❌ Try a time like `30`, `1m` or `1m30s` (1 second to 60 minutes).";
    }
    sec = parsed;
  }
  const result = seekByDelta(guildId, direction * sec);
  if (!result) return "❌ Nothing is currently playing.";
  return `${direction < 0 ? "⏪ Rewound" : "⏩ Skipped ahead"} **${fmtDur(sec)}** — now at **${fmt(result.position)}** of ~${fmt(result.total)}`;
}

async function handleSpeed(guildId: string, value: number | null, step: number | null): Promise<string> {
  await hydrateGuildVoice(guildId);
  if (value === null && step === null) {
    const p = getPrefs(guildId);
    return (
      `⚡ Speed: **${fmtSpeed(p.speed)}** (range ${fmtSpeed(SPEED_MIN)}–${fmtSpeed(SPEED_MAX)})\n` +
      `Speed buttons change it by ${fmtSpeed(p.speedStep)} · skip step ${p.seekStep}s\n` +
      "Set it with `/speed value:1.25`, or use 🐢 🐇 ⚙️ on the player."
    );
  }
  const patch: Partial<GuildPrefs> = {};
  if (value !== null) patch.speed = value;
  if (step  !== null) patch.speedStep = step;
  const p = setPrefs(guildId, patch);
  await forceProgressUpdate(guildId).catch(() => {});
  return `⚡ Speed set to **${fmtSpeed(p.speed)}** · button step ${fmtSpeed(p.speedStep)}.${getSession(guildId) ? " It applies from the next sentence." : ""}`;
}

async function handleSkipStep(guildId: string, seconds: number): Promise<string> {
  await hydrateGuildVoice(guildId);
  const p = setPrefs(guildId, { seekStep: seconds });
  await forceProgressUpdate(guildId).catch(() => {});
  return `⏩ Skip step set to **${p.seekStep}s** — used by the ⏪/⏩ buttons and by \`/rewind\` and \`/forward\` when you don't give an amount.`;
}

async function handleMarkers(guildId: string, style: string | null, notes: string | null): Promise<string> {
  await hydrateGuildVoice(guildId);
  const patch: Partial<GuildPrefs> = {};
  if (style && MARKER_MODES.includes(style as MarkerMode)) patch.markers = style as MarkerMode;
  if (notes === "read" || notes === "skip") patch.notes = notes;

  const changed = Object.keys(patch).length > 0;
  const p = changed ? setPrefs(guildId, patch) : getPrefs(guildId);
  const lines = [
    `🔔 Dividers (△▼△▼, ※ ※ ※): **${p.markers}** · translator's notes: **${p.notes === "skip" ? "skipped" : "read"}**`,
  ];
  if (!changed) {
    lines.push(
      "Styles: `chime` = a short sound (a different one for scene breaks, notes and chapter end) · `voice` = says “Scene break”, “Translator's note”… · `both` · `off`",
      "Change with `/markers style:chime notes:skip`.",
    );
  } else {
    lines.push(patch.notes ? "Skipping notes applies the next time a chapter starts; the style applies right away." : "Applies right away.");
  }
  return lines.join("\n");
}

async function handleExpression(guildId: string, level: string | null): Promise<string> {
  await hydrateGuildVoice(guildId);
  if (level && EXPRESSION_LEVELS.includes(level as ExpressionLevel)) {
    const p = setPrefs(guildId, { expression: level as ExpressionLevel });
    return `🎭 Expression: **${p.expression}** — applies to sentences generated from now on (a few seconds ahead). Bing voices only; ElevenLabs voices already react to CAPS and punctuation themselves.`;
  }
  return `🎭 Expression is **${getPrefs(guildId).expression}**. Set it with \`/expression level:off|normal|strong\`.`;
}

/** Text-prefix versions of the playback commands. Returns null if it isn't one of them. */
async function handlePrefixPlayback(guildId: string, command: string, args: string[]): Promise<string | null> {
  switch (command) {
    case "speed": {
      if (!args[0]) return handleSpeed(guildId, null, null);
      const v  = parseFloat(args[0].replace(/x$/i, ""));
      const st = args[1] ? parseFloat(args[1]) : null;
      if (!Number.isFinite(v) || v < SPEED_MIN || v > SPEED_MAX) {
        return `❌ Usage: \`!speed <${SPEED_MIN}–${SPEED_MAX}> [step]\` (e.g. \`!speed 1.25\`)`;
      }
      return handleSpeed(guildId, v, st !== null && Number.isFinite(st) ? st : null);
    }
    case "rewind": case "rw":
      return handleMove(guildId, -1, args.join(""));
    case "forward": case "ff": case "fastforward":
      return handleMove(guildId, 1, args.join(""));
    case "expression":
      return handleExpression(guildId, args[0]?.toLowerCase() ?? null);
    case "markers": {
      const style = args.find((a) => MARKER_MODES.includes(a.toLowerCase() as MarkerMode))?.toLowerCase() ?? null;
      const notes = args.find((a) => a.toLowerCase() === "skip" || a.toLowerCase() === "read")?.toLowerCase() ?? null;
      return handleMarkers(guildId, style, notes);
    }
    case "skipstep": {
      const n = parseInt(args[0] ?? "", 10);
      return Number.isFinite(n) && n >= 3 && n <= 300 ? handleSkipStep(guildId, n) : "❌ Usage: `!skipstep <3–300>` (seconds)";
    }
    default:
      return null;
  }
}

function handleChapter(guildId: string, num: number): string {
  const result = skipToChapter(guildId, num);
  if (!result.ok) return `❌ ${result.title || "No chapters detected in this content."}`;
  return `📑 Jumping to chapter **${num}**: *${result.title}* (${result.total} total)...`;
}

function handleChapters(guildId: string): string {
  const info = getChapterInfo(guildId);
  if (!info) return "❌ Nothing is currently playing.";
  if (info.total <= 1) return "ℹ️ No separate chapters/sections were detected in this content.";
  const list = info.titles
    .map((t, i) => `${i + 1 === info.current ? "▶️" : "　"} **${i + 1}.** ${t}`)
    .join("\n");
  return `📑 **Chapters** (currently on ${info.current}/${info.total}):\n${list}`;
}

function handleRestart(guildId: string): string {
  const session = getSession(guildId);
  if (!session) return "❌ Nothing is currently playing.";
  const title = session.title;
  restartSession(guildId);
  return `⏮️ Restarting **${title}** from the beginning...`;
}

function handleSeek(guildId: string, seconds: number): string {
  const info = getProgressSeconds(guildId);
  if (!info) return "❌ Nothing is currently playing.";
  if (seconds > info.totalSec) return `❌ Chapter is only **${fmt(info.totalSec)}** long.`;
  seekSessionBySeconds(guildId, seconds);
  return `⏩ Jumping to **${fmt(seconds)}** of *${info.title}* (~${fmt(info.totalSec)} total)...`;
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── Discord client ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel], // required to receive DM events
  rest: { rejectOnRateLimit: ["/gateway/bot"] },   // report a rate limit/block instead of silently waiting hours
});

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ WCT Reader Bot ready! Logged in as ${c.user.tag}`);
  console.log(`🎙️ Voices loaded: ${VOICES.map(v => v.label).join(", ")}`);
  c.user.setActivity("📖 /help or !help");
  try {
    // Only talk to Discord's command API when the commands actually changed (every restart used to re-send them)
    const hash  = createHash("sha1").update(c.user.id + JSON.stringify(slashCommands)).digest("hex");
    const saved = await kvGet("wct:cmdhash").catch(() => null);
    if (saved === hash) {
      console.log("✅ Slash commands unchanged — skipping registration.");
    } else {
      const rest = new REST().setToken(process.env["DISCORD_BOT_TOKEN"]!);
      await rest.put(Routes.applicationCommands(c.user.id), { body: slashCommands });
      await kvSet("wct:cmdhash", hash).catch(() => {});
      console.log("✅ Slash commands registered globally.");
    }
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
});

// ─── Interaction handler (slash commands + buttons + select menus) ────────────

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (!interaction.guild) return;
  const guildId = interaction.guild.id;

  // ── Custom speed / step popup ───────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === "ctrl_modal") {
    const num = (id: string): number | undefined => {
      const raw = interaction.fields.getTextInputValue(id).trim();
      const n   = parseFloat(raw);
      return raw === "" || !Number.isFinite(n) ? undefined : n;
    };
    const patch: Partial<GuildPrefs> = {};
    const sp = num("m_speed"), st = num("m_speedstep"), sk = num("m_seekstep");
    if (sp !== undefined) patch.speed     = sp;
    if (st !== undefined) patch.speedStep = st;
    if (sk !== undefined) patch.seekStep  = sk;
    const p = setPrefs(guildId, patch);
    await interaction.reply({
      content: `✅ Speed **${fmtSpeed(p.speed)}** · speed step **${fmtSpeed(p.speedStep)}** · skip step **${p.seekStep}s**`,
      flags:   MessageFlags.Ephemeral,
    }).catch(() => {});
    await forceProgressUpdate(guildId).catch(() => {});
    return;
  }

  // ── Queue screen (paging, "Make a selection", Play now / Play next / Remove) ──
  if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith("q_")) {
    await handleQueueInteraction(interaction, interaction.member as GuildMember | null);
    return;
  }

  // ── Voice picker (buttons + select menus whose ids start with "vp_") ───────────
  if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith("vp_")) {
    await handleVoiceInteraction(interaction);
    return;
  }

  // ── Buttons ─────────────────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const btn = interaction as ButtonInteraction;
    const { customId } = btn;

    // /find prev / next match
    if (customId === "find_go" && !canControl(guildId, interaction.member as GuildMember | null)) {
      await btn.reply({ content: denyMessage(guildId), flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    if (customId === "find_prev" || customId === "find_next" || customId === "find_go") {
      const reply = customId === "find_go"
        ? goFind(guildId)
        : stepFind(guildId, customId === "find_next" ? 1 : -1);
      if (!reply) {
        await btn.reply({ content: "❌ That search has expired — run `/find` again.", flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      await btn.update({ content: reply.content, components: reply.components }).catch(() => {});
      return;
    }

    // Seek/restart/pause/stop/chapter control buttons on the progress bar
    // ⚙️ Custom… opens a popup (must be answered with the popup, so no deferUpdate first)
    if (customId === "ctrl_speed_custom") {
      if (!canControl(guildId, interaction.member as GuildMember | null)) {
        await btn.reply({ content: denyMessage(guildId), flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      const p = getPrefs(guildId);
      const field = (id: string, label: string, value: number) =>
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short)
            .setValue(String(value)).setRequired(false).setMaxLength(6)
        );
      const modal = new ModalBuilder()
        .setCustomId("ctrl_modal")
        .setTitle("Playback settings")
        .addComponents(
          field("m_speed",     "Speed (0.5 – 3.0)",              p.speed),
          field("m_speedstep", "Speed button step (0.05 – 1)",   p.speedStep),
          field("m_seekstep",  "Skip step in seconds (3 – 300)", p.seekStep),
        );
      await btn.showModal(modal).catch(() => {});
      return;
    }

    const CTRL_IDS = ["ctrl_restart","ctrl_back","ctrl_forward","ctrl_pause","ctrl_stop","ctrl_prev_chapter","ctrl_next_chapter","ctrl_speed_down","ctrl_speed_up","ctrl_speed_label"];
    if (CTRL_IDS.includes(customId)) {
      if (!canControl(guildId, interaction.member as GuildMember | null)) {
        await btn.reply({ content: denyMessage(guildId), flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      await btn.deferUpdate().catch(() => {});
      switch (customId) {
        case "ctrl_restart":      restartSession(guildId); break;
        case "ctrl_back":         seekRelativeSeconds(guildId, -getPrefs(guildId).seekStep); break;
        case "ctrl_forward":      seekRelativeSeconds(guildId, +getPrefs(guildId).seekStep); break;
        case "ctrl_speed_down":   stepSpeed(guildId, -1); break;
        case "ctrl_speed_up":     stepSpeed(guildId, +1); break;
        case "ctrl_pause": {
          const s = getSession(guildId);
          if (s?.paused) resumeSession(guildId); else pauseSession(guildId);
          break;
        }
        case "ctrl_stop":         await stopSession(guildId); break;
        case "ctrl_prev_chapter": {
          const ci = getChapterInfo(guildId);
          if (ci) skipToChapter(guildId, Math.max(1, ci.current - 1));
          break;
        }
        case "ctrl_next_chapter": {
          const ci = getChapterInfo(guildId);
          if (ci) skipToChapter(guildId, Math.min(ci.total, ci.current + 1));
          break;
        }
      }
      // Immediately refresh embed so button states update at once
      await forceProgressUpdate(guildId).catch(() => {});
      return;
    }
  }

  // ── Slash commands ──────────────────────────────────────────────────────────
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction as ChatInputCommandInteraction;

  try { await cmd.deferReply(); } catch { return; }

  const member    = interaction.member as GuildMember | null;
  const memberVC  = member?.voice?.channel ?? null;
  const textChannel = interaction.channel as TextChannel;
  const editReply = (content: string) => cmd.editReply(content).catch(() => {});

  try {
    const CONTROL_CMDS = new Set(["stop", "pause", "resume", "skip", "skipparagraph", "previous", "restart", "seek", "rewind", "forward", "chapter", "clear"]);
    const changesSpeed = cmd.commandName === "speed" && (cmd.options.getNumber("value") !== null || cmd.options.getNumber("step") !== null);
    if ((CONTROL_CMDS.has(cmd.commandName) || changesSpeed) && !canControl(guildId, member)) {
      await editReply(denyMessage(guildId));
      return;
    }

    switch (cmd.commandName) {
      case "read": {
        const url        = cmd.options.getString("url", true);
        const explicitVC = (cmd.options.getChannel("channel") as VoiceBasedChannel | null) ?? null;
        await handleRead(guildId, interaction.guild, textChannel, memberVC, explicitVC, url, interaction.user,
          (p) => p.components?.length
            ? cmd.editReply({ content: p.content, components: p.components }).catch(() => {})
            : cmd.editReply(p.content).catch(() => {})
        );
        break;
      }
      case "join":
        await editReply(await handleJoin(interaction.guild, memberVC));
        break;
      case "find": {
        const kw    = cmd.options.getString("keyword", true);
        const reply = handleFind(guildId, kw, true);
        await cmd.editReply({ content: reply.content, components: reply.components }).catch(() => {});
        break;
      }
      case "stop":     await editReply(await handleStop(guildId)); break;
      case "pause":    await editReply(handlePause(guildId));      break;
      case "resume":   await editReply(handleResume(guildId));     break;
      case "skip":     await editReply(await handleSkip(guildId));       break;
      case "chapter": {
        const num = cmd.options.getInteger("number", true);
        await editReply(handleChapter(guildId, num));
        break;
      }
      case "chapters": await editReply(handleChapters(guildId)); break;
      case "speed":
        await editReply(await handleSpeed(guildId, cmd.options.getNumber("value"), cmd.options.getNumber("step")));
        break;
      case "rewind":   await editReply(handleMove(guildId, -1, cmd.options.getString("amount"))); break;
      case "forward":  await editReply(handleMove(guildId, +1, cmd.options.getString("amount"))); break;
      case "skipstep": await editReply(await handleSkipStep(guildId, cmd.options.getInteger("seconds", true))); break;
      case "skipparagraph": await editReply(handleSkipParagraph(guildId)); break;
      case "previous": await editReply(await previousLink(guildId)); break;
      case "queue": {
        const page = cmd.options.getInteger("page") ?? 1;
        const msg  = await cmd.editReply(buildQueuePayload(guildId, page));
        attachQueueTyping(msg, textChannel, interaction.user.id, guildId, Math.min(page, pageCount(guildId)));
        break;
      }
      case "remove":
        await editReply(await removeItem(guildId, cmd.options.getInteger("position", true), interaction.user.id, canControl(guildId, member)));
        break;
      case "clear":    await editReply(clearQueue(guildId)); break;
      case "controls": await editReply(await handleControls(guildId, member, cmd.options.getString("mode"))); break;
      case "expression":
        await editReply(await handleExpression(guildId, cmd.options.getString("level")));
        break;
      case "markers":
        await editReply(await handleMarkers(guildId, cmd.options.getString("style"), cmd.options.getString("notes")));
        break;
      case "restart":  await editReply(handleRestart(guildId));    break;
      case "seek": {
        const secs = cmd.options.getInteger("seconds", true);
        await editReply(handleSeek(guildId, secs));
        break;
      }
      case "progress": await editReply(handleProgress(guildId));   break;
      case "help":     await cmd.editReply(helpPayload()).catch(() => {});                break;
      case "invite":   await editReply(`🔗 **Add me to your server:**\n${inviteUrl()}`); break;

      case "voice":
        await cmd.editReply(await showVoiceHome(guildId, interaction.user.id)).catch(() => {});
        break;
      case "voicesearch": {
        const query   = cmd.options.getString("query", true);
        const service = parseFilter(cmd.options.getString("service"));
        await cmd.editReply(await showVoiceSearch(guildId, interaction.user.id, query, service)).catch(() => {});
        break;
      }

      default: await editReply("❓ Unknown command."); break;
    }
  } catch (err) {
    console.error(`[slash:${cmd.commandName}]`, err);
    await editReply(`❌ Error: ${(err as Error).message}`).catch(() => {});
  }
});

// ─── Prefix command handler ───────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args    = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();
  if (!command) return;

  const inDM        = !message.guild;
  const textChannel = message.channel as TextChannel;
  let reply = "";

  // ── DM / group-chat handling ──────────────────────────────────────────────
  if (inDM) {
    if (command === "help") {
      try { await message.reply(helpPayload()); } catch { /* ignore */ }
      return;
    }

    if (command === "read" || command === "join") {
      try { await message.reply("❌ Voice reading requires a server with voice channels. Use `/read` or `!read` in a server text channel, then you can control playback from here."); } catch { /* ignore */ }
      return;
    }

    // Control commands — find the user's active session across all guilds
    const session = getSessionByUserId(message.author.id);
    if (!session) {
      try { await message.reply("❌ You don't have an active reading session. Start one in a server first."); } catch { /* ignore */ }
      return;
    }
    const guildId = session.guildId;

    try {
      switch (command) {
        case "stop":     reply = await handleStop(guildId); break;
        case "pause":    reply = handlePause(guildId);      break;
        case "resume":   reply = handleResume(guildId);     break;
        case "skip":     reply = await handleSkip(guildId);       break;
        case "restart":  reply = handleRestart(guildId);    break;
        case "find":     reply = handleFind(guildId, args.join(" "), false).content; break;
        case "chapter": {
          const num = parseInt(args[0] ?? "", 10);
          reply = isNaN(num) || num < 1 ? "❌ Usage: `!chapter <number>`" : handleChapter(guildId, num);
          break;
        }
        case "chapters": reply = handleChapters(guildId); break;
        case "speed": case "rewind": case "rw": case "forward": case "ff": case "fastforward": case "skipstep": case "markers": case "expression":
          reply = (await handlePrefixPlayback(guildId, command, args)) ?? "";
          break;
        case "seek": {
          const secs = parseInt(args[0] ?? "", 10);
          reply = isNaN(secs) || secs < 0 ? "❌ Usage: `!seek <seconds>`" : handleSeek(guildId, secs);
          break;
        }
        case "progress": reply = handleProgress(guildId); break;
        case "invite":   reply = `🔗 **Add me to your server:**\n${inviteUrl()}`; break;
        default: reply = `❓ Unknown command. Try \`!help\`.`;
      }
    } catch (err) {
      reply = `❌ Error: ${(err as Error).message}`;
    }
    try { await message.reply(reply); } catch { /* ignore */ }
    return;
  }

  // ── Server (guild) handling ───────────────────────────────────────────────
  const guildId  = message.guild!.id;
  const member   = message.member as GuildMember | null;
  const memberVC = member?.voice?.channel ?? null;

  const PREFIX_CONTROL = new Set(["stop", "pause", "resume", "skip", "sp", "skipparagraph", "previous", "prev", "restart", "seek", "rewind", "rw", "forward", "ff", "fastforward", "chapter", "clear"]);
  if (PREFIX_CONTROL.has(command) && !canControl(guildId, member)) {
    try { await message.reply(denyMessage(guildId)); } catch { /* ignore */ }
    return;
  }

  try {
    switch (command) {
      case "read": {
        let placeholder: Message | undefined;
        try { placeholder = await message.reply("🔍 Working..."); } catch { placeholder = undefined; }
        await handleRead(guildId, message.guild!, textChannel, memberVC, null, args.find((a) => /^<?https?:/i.test(a)) ?? args[0] ?? "", message.author,
          async (p) => {
            try {
              if (placeholder) return await placeholder.edit({ content: p.content, components: p.components ?? [] });
            } catch { /* fallback */ }
          }
        );
        return;
      }
      case "join": {
        reply = await handleJoin(message.guild!, memberVC);
        break;
      }
      case "find": {
        const r = handleFind(guildId, args.join(" "), true);
        try { await message.reply({ content: r.content, components: r.components }); } catch (err) { console.error("[prefix find]", err); }
        return;
      }
      case "voice": {
        try { await message.reply(await showVoiceHome(guildId, message.author.id)); }
        catch (err) { console.error("[prefix voice]", err); }
        return;
      }
      case "voicesearch": {
        const query = args.join(" ");
        if (!query.trim()) { reply = "❌ Usage: `!voicesearch <name or style>` (e.g. `!voicesearch sarah`)"; break; }
        try { await message.reply(await showVoiceSearch(guildId, message.author.id, query)); }
        catch (err) { console.error("[prefix voicesearch]", err); }
        return;
      }

      case "skipparagraph": case "sp": reply = handleSkipParagraph(guildId); break;
      case "previous": case "prev":    reply = await previousLink(guildId); break;
      case "queue": case "q": {
        const page = parseInt(args[0] ?? "1", 10) || 1;
        try {
          const msg = await message.reply(buildQueuePayload(guildId, page));
          attachQueueTyping(msg, textChannel, message.author.id, guildId, Math.min(page, pageCount(guildId)));
        } catch (err) { console.error("[prefix queue]", err); }
        return;
      }
      case "remove": case "rm": {
        const n = parseInt(args[0] ?? "", 10);
        reply = Number.isFinite(n) && n >= 1 ? await removeItem(guildId, n, message.author.id, canControl(guildId, member)) : "❌ Usage: `!remove <position>`";
        break;
      }
      case "clear":    reply = clearQueue(guildId); break;
      case "controls": reply = await handleControls(guildId, member, args[0]?.toLowerCase() ?? null); break;
      case "stop":     reply = await handleStop(guildId); break;
      case "pause":    reply = handlePause(guildId);      break;
      case "resume":   reply = handleResume(guildId);     break;
      case "skip":     reply = await handleSkip(guildId);       break;
      case "chapter": {
        const num = parseInt(args[0] ?? "", 10);
        reply = isNaN(num) || num < 1 ? "❌ Usage: `!chapter <number>`" : handleChapter(guildId, num);
        break;
      }
      case "chapters": reply = handleChapters(guildId); break;
      case "speed": case "rewind": case "rw": case "forward": case "ff": case "fastforward": case "skipstep": case "markers": case "expression":
        reply = (await handlePrefixPlayback(guildId, command, args)) ?? "";
        break;
      case "restart":  reply = handleRestart(guildId);    break;
      case "seek": {
        const secs = parseInt(args[0] ?? "", 10);
        reply = isNaN(secs) || secs < 0 ? "❌ Usage: `!seek <seconds>` (e.g. `!seek 120` = 2:00)" : handleSeek(guildId, secs);
        break;
      }
      case "progress": reply = handleProgress(guildId);   break;
      case "invite":   reply = `🔗 **Add me to your server:**\n${inviteUrl()}`; break;
      case "help": {
        try { await message.reply(helpPayload()); } catch (err) { console.error("[prefix help]", err); }
        return;
      }
      default: return;
    }
  } catch (err) {
    console.error(`[prefix:${command}]`, err);
    reply = `❌ Error: ${(err as Error).message}`;
  }

  try { await message.reply(reply); } catch (err) { console.error("[prefix reply]", err); }
});

// ─── Status page: see WHY the bot is down without digging through logs ───────
// Open  https://<your-service>.onrender.com/status  in a browser.

const botState = {
  startedAt:     Date.now(),
  ready:         false,
  tag:           null as string | null,
  loginAttempts: 0,
  lastError:     null as string | null,
  lastEvent:     "starting",
  discordCheck:  "not checked yet",
};
const DISCORD_API = (process.env["DISCORD_API_BASE"] ?? "https://discord.com/api/v10").replace(/\/$/, "");
const debugLines: string[] = [];                      // the last few lines of the gateway connection log (token removed)
client.on(Events.Debug, (msg) => {
  const secret = process.env["DISCORD_BOT_TOKEN"];
  const clean  = secret ? msg.split(secret).join("[token]") : msg;
  debugLines.push(`${new Date().toISOString().slice(11, 19)} ${clean}`.slice(0, 220));
  if (debugLines.length > 25) debugLines.shift();
});
const memoryMB = (): number => Math.round(process.memoryUsage().rss / 1048576);

const PORT = process.env["PORT"] ? parseInt(process.env["PORT"], 10) : 3000;
createServer((req, res) => {
  if (req.url?.startsWith("/status")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      discordConnected: botState.ready,
      botTag:           botState.tag,
      problem:          botState.ready ? null : botState.lastError,
      lastEvent:        botState.lastEvent,
      discordCheck:     botState.discordCheck,
      recentDebug:      debugLines.slice(-12),
      loginAttempts:    botState.loginAttempts,
      uptimeMinutes:    Math.round((Date.now() - botState.startedAt) / 60000),
      memoryMB:         memoryMB(),
      tokenSet:         Boolean(process.env["DISCORD_BOT_TOKEN"]),
    }, null, 2));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });          // always 200 so Render keeps the service alive
  res.end(botState.ready ? `OK — connected as ${botState.tag}` : `Server is up, but Discord is NOT connected: ${botState.lastError ?? "connecting…"}\nDiscord check: ${botState.discordCheck}\n(see /status for details)`);
}).listen(PORT, () => console.log(`✅ Health server listening on port ${PORT}`));

/** Ask Discord's API directly (with a timeout) and say in plain words what it answered. */
async function preflight(token: string): Promise<string> {
  try {
    const res  = await fetch(`${DISCORD_API}/gateway/bot`, {
      headers: { Authorization: `Bot ${token}`, "User-Agent": "DiscordBot (https://github.com/sadrame/Discord-tts-bot2, 1.0)" },
      signal:  AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    if (res.status === 200) {
      const l = (JSON.parse(body) as { session_start_limit?: { total: number; remaining: number; reset_after: number } }).session_start_limit;
      return l
        ? `OK — Discord accepts the token. Logins left in this window: ${l.remaining}/${l.total} (resets in ${Math.round(l.reset_after / 60000)} min)`
        : "OK — Discord accepts the token.";
    }
    if (res.status === 401) return "TOKEN REJECTED (HTTP 401) — the token is wrong or was reset.";
    if (res.status === 429 || /cloudflare|1015|you are being blocked/i.test(body))
      return `BLOCKED (HTTP ${res.status}) — Discord/Cloudflare is rate-limiting or blocking this server's IP. Retry-After: ${res.headers.get("retry-after") ?? "?"}s. ${body.replace(/\s+/g, " ").slice(0, 140)}`;
    return `Unexpected answer (HTTP ${res.status}): ${body.replace(/\s+/g, " ").slice(0, 160)}`;
  } catch (err) {
    return `Can't reach Discord from this server: ${(err as Error).message}`;
  }
}

function diagnose(message: string): string {
  if (/timed out/i.test(message))
    return "Discord didn't finish the login in time. Look at discordCheck and recentDebug on /status — they show where it stalls.";
  if (/TokenInvalid|invalid token|An invalid token/i.test(message))
    return "Discord rejected DISCORD_BOT_TOKEN (it's wrong, or Discord reset it). Developer Portal → your app → Bot → Reset Token, then paste the new token into Render → Environment → DISCORD_BOT_TOKEN and redeploy.";
  if (/disallowed intents|DisallowedIntents/i.test(message))
    return "A required intent is off. Developer Portal → your app → Bot → turn ON \"Message Content Intent\", save, then redeploy.";
  if (/429|1015|cloudflare|rate.?limit|banned|blocked/i.test(message))
    return "Discord/Cloudflare is temporarily blocking this server's IP (too many requests, usually from repeated restarts). Don't redeploy repeatedly — wait 30–60 minutes; the bot keeps retrying by itself.";
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|network/i.test(message))
    return `Network problem reaching Discord (${message}). The bot keeps retrying by itself.`;
  return message;
}

client.on(Events.ClientReady, (c) => { botState.ready = true; botState.tag = c.user.tag; botState.lastError = null; botState.lastEvent = "connected"; });
client.on(Events.ShardDisconnect, (ev) => { botState.ready = false; botState.lastEvent = `gateway disconnected (code ${ev.code})`; console.warn(`[gateway] ${botState.lastEvent}`); });
client.on(Events.ShardReconnecting, () => { botState.lastEvent = "gateway reconnecting"; console.warn("[gateway] reconnecting…"); });
client.on(Events.ShardResume, () => { botState.ready = true; botState.lastEvent = "gateway resumed"; console.log("[gateway] resumed"); });
client.on(Events.ShardError, (err) => { botState.lastEvent = `gateway error: ${err.message}`; console.error("[gateway] error:", err.message); });
client.on(Events.Invalidated, () => { botState.ready = false; botState.lastError = "Discord invalidated the session"; console.error("[gateway] session invalidated"); });
client.on(Events.Error, (err) => console.error("[client] error:", err.message));
client.rest.on("rateLimited", (info) => console.warn(`[rate-limit] ${info.method} ${info.route} — retry in ${Math.round(info.retryAfter / 1000)}s`));

// ─── Start (never exits: a crash loop makes Discord block or reset the bot) ───

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function connectDiscord(): Promise<void> {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    botState.lastError = "DISCORD_BOT_TOKEN is not set. Render → Environment → add it, then redeploy.";
    console.error(`[login] ${botState.lastError}`);
    return;
  }
  let delay = 20_000;
  for (;;) {
    botState.loginAttempts++;
    botState.lastEvent = `asking Discord if the token is OK (attempt ${botState.loginAttempts})`;
    botState.discordCheck = await preflight(token);
    console.log(`[login] pre-check: ${botState.discordCheck}`);
    if (botState.discordCheck.startsWith("TOKEN REJECTED")) {
      botState.lastError = diagnose("invalid token");
      console.error(`[login] ${botState.lastError}`);
      return;                                                      // a new token is needed — retrying only adds to Discord's limit
    }

    botState.lastEvent = `logging in (attempt ${botState.loginAttempts})`;
    console.log(`[login] attempt ${botState.loginAttempts} (token length ${token.length})`);
    try {
      await withTimeout(client.login(token), 120_000, "Discord login");     // never hang forever
      return;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      botState.lastError = diagnose(message);
      console.error(`[login] failed: ${botState.lastError}`);
      if (/TokenInvalid|invalid token|disallowed intents|DisallowedIntents/i.test(message)) {
        console.error("[login] Retrying won't help — fix the setting above and redeploy. The status page stays up.");
        return;
      }
      try { void client.destroy(); } catch { /* not connected yet */ }
      let wait = delay;
      const reset = (err as { timeToReset?: number }).timeToReset;           // Discord told us when to come back
      if (typeof reset === "number") wait = Math.min(Math.max(reset + 5_000, delay), 30 * 60_000);
      console.log(`[login] trying again in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      delay = Math.min(delay * 2, 10 * 60_000);
    }
  }
}
connectDiscord().catch((err) => console.error("[login] unexpected:", err));

// Free Render services go to sleep after ~15 min without web traffic: ping ourselves so the bot stays online
const selfUrl = process.env["KEEPALIVE_URL"] ?? process.env["RENDER_EXTERNAL_URL"];
if (selfUrl) {
  setInterval(() => { fetch(selfUrl, { signal: AbortSignal.timeout(10_000) }).catch(() => {}); }, 4 * 60_000);
  console.log(`[keepalive] pinging ${selfUrl} every 4 minutes`);
}
setInterval(() => { if (memoryMB() > 420) console.warn(`[memory] ${memoryMB()} MB in use — the free plan limit is 512 MB`); }, 60_000);

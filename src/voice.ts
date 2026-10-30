import {
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  AudioPlayer,
  AudioPlayerStatus,
  VoiceConnection,
} from "@discordjs/voice";
import {
  VoiceBasedChannel,
  TextBasedChannel,
  Guild,
  Message as DjsMessage,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { textToMp3File, cleanupFile, splitIntoChunks, warmUpVoice } from "./tts.js";
import type { VoiceOption } from "./voices.js";
import { DEFAULT_VOICE } from "./voices.js";
import { saveBookmark, clearBookmark } from "./bookmarks.js";
import type { ChapterSection } from "./scraper.js";

// How long to wait for Discord's voice handshake. Render's free tier can be slow,
// so the default is generous. Override with the VOICE_READY_TIMEOUT_MS env var.
const VOICE_READY_TIMEOUT_MS = Number(process.env["VOICE_READY_TIMEOUT_MS"]) || 60_000;
// /join leaves again after this long if nobody starts a reading
const STANDBY_TIMEOUT_MS = 10 * 60_000;

// ─── Session ──────────────────────────────────────────────────────────────────

export interface SearchState {
  query:   string;
  matches: number[];   // paragraph indices
  pos:     number;     // index into matches
  fuzzy:   boolean;
}

export interface ReadSession {
  guildId:          string;
  userId:           string;         // who started the session (for DM control)
  title:            string;
  url:              string;
  paragraphs:       string[];
  paragraphStarts:  number[];       // first chunk index of every paragraph
  allChunks:        string[];
  chunkIndex:       number;         // next chunk to GENERATE
  playingIdx:       number;         // chunk currently playing (what the user hears)
  seekEpoch:        number;         // bumped on every seek so stale audio is discarded
  paused:           boolean;
  stopped:          boolean;
  voiceVersion:     number;
  consecutiveSkips: number;
  player:           AudioPlayer;
  textChannel:      TextBasedChannel;
  progressMsg:      DjsMessage | null;
  lastProgressEdit: number;

  // Wall-clock timing (rebased on every seek so the bar follows the position)
  readingStartedAt: number;
  pausedDuration:   number;
  pauseStartedAt:   number | null;

  // Chapter navigation
  chapterBoundaries: number[];    // chunk indices where each chapter starts
  chapterTitles:     string[];

  // Last /find results (for the prev/next match buttons)
  search: SearchState | null;

  progressTimer: ReturnType<typeof setInterval> | null;
}

interface ChunkResult {
  file:         string;
  chunkIdx:     number;
  voiceVersion: number;
  epoch:        number;
}

const sessions    = new Map<string, ReadSession>();
const guildVoices = new Map<string, VoiceOption>();
// Reverse lookup: userId → guildId, so DM commands can find the active session
const userToGuild = new Map<string, string>();
// Guilds where the bot is sitting in a voice channel (via /join) without reading
const standby     = new Map<string, ReturnType<typeof setTimeout>>();

/** Find a session by the user who started it (used for DM control commands). */
export function getSessionByUserId(userId: string): ReadSession | undefined {
  const guildId = userToGuild.get(userId);
  return guildId ? sessions.get(guildId) : undefined;
}

// ─── Voice preference ─────────────────────────────────────────────────────────

export function getGuildVoice(guildId: string): VoiceOption {
  return guildVoices.get(guildId) ?? DEFAULT_VOICE;
}

export function setGuildVoice(guildId: string, voice: VoiceOption): void {
  guildVoices.set(guildId, voice);
  const session = sessions.get(guildId);
  if (session) {
    session.voiceVersion++;
    session.consecutiveSkips = 0;
    session.player.stop();
  }
  warmUpVoice(voice);
  console.log(`[voice] guild ${guildId} → ${voice.id}`);
}

// ─── Connection helpers ───────────────────────────────────────────────────────

function destroyConnection(guildId: string): void {
  const conn = getVoiceConnection(guildId);
  if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
}

async function connectToChannel(guild: Guild, voiceChannel: VoiceBasedChannel): Promise<VoiceConnection> {
  const connection = joinVoiceChannel({
    channelId:      voiceChannel.id,
    guildId:        guild.id,
    adapterCreator: guild.voiceAdapterCreator,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);
  } catch {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    throw new Error(`Could not connect to the voice channel within ${Math.round(VOICE_READY_TIMEOUT_MS / 1000)} seconds.`);
  }

  // Standard recovery pattern: if Discord moves/reconnects us, give it a few seconds
  // before giving up. Only a real disconnect ends the session.
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        await stopSession(guild.id).catch(() => {});
      }
    }
  });

  return connection;
}

// ─── Standby (/join) ──────────────────────────────────────────────────────────

function clearStandby(guildId: string): boolean {
  const timer = standby.get(guildId);
  if (!timer) return false;
  clearTimeout(timer);
  standby.delete(guildId);
  return true;
}

/** Join a voice channel and wait there (leaves after 10 minutes if unused). */
export async function joinStandby(guild: Guild, voiceChannel: VoiceBasedChannel): Promise<void> {
  await stopSession(guild.id);
  await connectToChannel(guild, voiceChannel);
  const timer = setTimeout(() => {
    standby.delete(guild.id);
    destroyConnection(guild.id);
  }, STANDBY_TIMEOUT_MS);
  standby.set(guild.id, timer);
}

/** Leave a /join standby. Returns false if the bot wasn't in standby. */
export function leaveStandby(guildId: string): boolean {
  if (!clearStandby(guildId)) return false;
  destroyConnection(guildId);
  return true;
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

export function getSession(guildId: string): ReadSession | undefined {
  return sessions.get(guildId);
}

export async function stopSession(guildId: string): Promise<void> {
  clearStandby(guildId);
  const session = sessions.get(guildId);
  if (session) {
    if (session.progressTimer) {
      clearInterval(session.progressTimer);
      session.progressTimer = null;
    }
    session.stopped = true;
    session.player.stop(true);
    userToGuild.delete(session.userId);
    // Save where the listener actually is (not where audio generation has got to).
    // Natural end of the chapter (chunkIndex === length) never saves a bookmark.
    if (session.playingIdx > 0 && session.chunkIndex < session.allChunks.length) {
      await saveBookmark(
        guildId,
        session.url,
        session.playingIdx,
        session.allChunks.length,
        session.title,
      ).catch(() => {});
    }
  }
  sessions.delete(guildId);
  destroyConnection(guildId);
}

export async function startReading(
  guild:           Guild,
  voiceChannel:    VoiceBasedChannel,
  textChannel:     TextBasedChannel,
  title:           string,
  paragraphs:      string[],
  url:             string,
  sections:        ChapterSection[] = [],
  resumeFromChunk  = 0,
  userId           = "",
): Promise<void> {
  if (paragraphs.length === 0) throw new Error("There is nothing to read.");
  await stopSession(guild.id);

  // Build chunks and map paragraph → first chunk index (for chapter boundaries)
  const allChunks: string[] = [];
  const paragraphStarts: number[] = [];
  for (const para of paragraphs) {
    paragraphStarts.push(allChunks.length);
    allChunks.push(...splitIntoChunks(para));
  }
  const startChunk = Math.max(0, Math.min(resumeFromChunk, Math.max(0, allChunks.length - 1)));

  // Convert section paragraph indices to chunk indices
  const chapterBoundaries: number[] = sections.map(
    (s) => paragraphStarts[s.startParagraph] ?? 0
  );
  const chapterTitles: string[] = sections.map((s) => s.title);

  // Deduplicate boundaries (headings and scene-breaks at the same paragraph)
  const seen = new Set<number>();
  const dedupBounds: number[] = [];
  const dedupTitles: string[] = [];
  for (let i = 0; i < chapterBoundaries.length; i++) {
    const b = chapterBoundaries[i]!;
    if (!seen.has(b)) {
      seen.add(b);
      dedupBounds.push(b);
      dedupTitles.push(chapterTitles[i]!);
    }
  }

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });

  const voice = getGuildVoice(guild.id);
  const now   = Date.now();

  const session: ReadSession = {
    guildId:          guild.id,
    userId,
    title,
    url,
    paragraphs,
    paragraphStarts,
    allChunks,
    chunkIndex:       startChunk,
    playingIdx:       startChunk,
    seekEpoch:        0,
    paused:           false,
    stopped:          false,
    voiceVersion:     0,
    consecutiveSkips: 0,
    player,
    textChannel,
    progressMsg:      null,
    lastProgressEdit: 0,
    readingStartedAt: now - currentChunkEstimatedSec(allChunks, startChunk) * 1000,
    pausedDuration:   0,
    pauseStartedAt:   null,
    chapterBoundaries: dedupBounds,
    chapterTitles:    dedupTitles,
    search:           null,
    progressTimer:    null,
  };

  sessions.set(guild.id, session);
  if (userId) userToGuild.set(userId, guild.id);

  // Send initial "loading" embed
  try {
    session.progressMsg = await (textChannel as any).send(
      buildProgressPayload(session, voice, true)
    );
  } catch { /* non-fatal */ }

  // 5-second background timer for accurate wall-clock updates
  session.progressTimer = setInterval(() => {
    const s = sessions.get(guild.id);
    if (!s || s.stopped) return;
    s.lastProgressEdit = 0; // bypass rate-limit on timer tick
    updateProgress(s).catch(() => {});
  }, 5_000);

  let connection: VoiceConnection;
  try {
    connection = await connectToChannel(guild, voiceChannel);
  } catch (err) {
    await stopSession(guild.id);
    throw err;
  }
  // The user may have run /stop (or started something else) while we were connecting
  if (session.stopped || sessions.get(guild.id) !== session) {
    destroyConnection(guild.id);
    return;
  }

  connection.subscribe(player);

  // Show the live embed with buttons immediately — don't wait for first TTS chunk
  session.lastProgressEdit = 0;
  await updateProgress(session).catch(() => {});

  runPipeline(session).catch((err) =>
    console.error("[pipeline] uncaught:", err)
  );
}

// ─── Wall-clock timing ────────────────────────────────────────────────────────

function getElapsedSeconds(session: ReadSession): number {
  const pausedMs =
    session.pausedDuration +
    (session.pauseStartedAt !== null ? Date.now() - session.pauseStartedAt : 0);
  return Math.max(0, (Date.now() - session.readingStartedAt - pausedMs) / 1000);
}

// ─── Time estimation (total duration via word count) ─────────────────────────

const WORDS_PER_SEC = 2.5; // ~150 wpm TTS

function chunkSeconds(chunk: string): number {
  return Math.max(0.3, chunk.trim().split(/\s+/).length / WORDS_PER_SEC);
}

function totalChapterSeconds(chunks: string[]): number {
  return chunks.reduce((s, c) => s + chunkSeconds(c), 0);
}

function chunkIndexAtSecond(chunks: string[], targetSec: number): number {
  let elapsed = 0;
  for (let i = 0; i < chunks.length; i++) {
    elapsed += chunkSeconds(chunks[i]!);
    if (elapsed >= targetSec) return i;
  }
  return Math.max(0, chunks.length - 1);
}

function currentChunkEstimatedSec(chunks: string[], upTo: number): number {
  return chunks.slice(0, upTo).reduce((s, c) => s + chunkSeconds(c), 0);
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── Paragraph / chapter helpers ──────────────────────────────────────────────

/** Paragraph (0-based) that contains the given chunk. */
function paragraphIndexOfChunk(session: ReadSession, chunk: number): number {
  const starts = session.paragraphStarts;
  let lo = 0;
  let hi = starts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= chunk) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

function getCurrentChapterIndex(session: ReadSession): number {
  const { chapterBoundaries, playingIdx } = session;
  if (chapterBoundaries.length === 0) return 0;
  let ch = 0;
  for (let i = 0; i < chapterBoundaries.length; i++) {
    if (playingIdx >= chapterBoundaries[i]!) ch = i;
    else break;
  }
  return ch;
}

// ─── Embed progress display ───────────────────────────────────────────────────

const FLAG: Record<string, string> = {
  American: "🇺🇸", British: "🇬🇧", Australian: "🇦🇺", Irish: "🇮🇪",
};

const EMBED_COLOR_PLAYING = 0x5865F2; // Discord blurple
const EMBED_COLOR_PAUSED  = 0xFFA500; // orange
const EMBED_COLOR_LOADING = 0x36393F; // dark grey
const EMBED_COLOR_DONE    = 0x57F287; // green
const EMBED_COLOR_STOPPED = 0x808080; // grey

const BAR_WIDTH = 24;

function buildEmbed(session: ReadSession, voice: VoiceOption, loading = false): EmbedBuilder {
  const flag = FLAG[voice.accent] ?? "🌐";

  if (loading) {
    return new EmbedBuilder()
      .setColor(EMBED_COLOR_LOADING)
      .setTitle(`📖 ${session.title}`)
      .setDescription(`${"░".repeat(BAR_WIDTH)}\n⏳ Loading chapter...`)
      .addFields({ name: "🎙️ Voice", value: `${flag} ${voice.label}`, inline: true });
  }

  const elapsed  = getElapsedSeconds(session);
  const total    = totalChapterSeconds(session.allChunks);
  const pct      = total > 0 ? Math.min(1, elapsed / total) : 0;
  const filled   = Math.round(pct * BAR_WIDTH);
  const bar      = "▓".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
  const timeStr  = `**${fmt(Math.min(elapsed, total))}** / ~${fmt(total)}`;

  const chIdx    = getCurrentChapterIndex(session);
  const chTitle  = session.chapterTitles[chIdx];
  const hasChapters = session.chapterBoundaries.length > 1;
  const chStr    = hasChapters
    ? `Ch. ${chIdx + 1} / ${session.chapterBoundaries.length}${chTitle ? ` — ${chTitle}` : ""}`
    : null;

  const color    = session.paused ? EMBED_COLOR_PAUSED : EMBED_COLOR_PLAYING;
  const statusLine = session.paused ? "⏸️ Paused" : "▶️ Playing";
  const paraNo   = paragraphIndexOfChunk(session, session.playingIdx) + 1;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`📖 ${session.title}`)
    .setDescription(`${bar}\n${timeStr} · ${statusLine}`)
    .addFields(
      { name: "🎙️ Voice",     value: `${flag} ${voice.label}`,                       inline: true },
      { name: "📍 Paragraph", value: `${paraNo} / ${session.paragraphs.length}`,     inline: true },
    );

  if (chStr) embed.addFields({ name: "📑 Chapter", value: chStr, inline: true });

  return embed;
}

function buildControlRow(paused: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ctrl_restart").setEmoji("⏮️").setLabel("Restart")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ctrl_back").setEmoji("⏪").setLabel("-10s")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ctrl_pause")
      .setEmoji(paused ? "▶️" : "⏸️")
      .setLabel(paused ? "Resume" : "Pause")
      .setStyle(paused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("ctrl_forward").setEmoji("⏩").setLabel("+10s")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ctrl_stop").setEmoji("⏹️").setLabel("Stop")
      .setStyle(ButtonStyle.Danger),
  );
}

function buildChapterRow(session: ReadSession): ActionRowBuilder<ButtonBuilder> | null {
  if (session.chapterBoundaries.length <= 1) return null;
  const chIdx = getCurrentChapterIndex(session);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ctrl_prev_chapter").setEmoji("⬅️").setLabel("Prev Ch.")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(chIdx === 0),
    new ButtonBuilder()
      .setCustomId("ctrl_next_chapter").setEmoji("➡️").setLabel("Next Ch.")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(chIdx >= session.chapterBoundaries.length - 1),
  );
}

type ProgressPayload = {
  embeds:     EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
};

function buildProgressPayload(session: ReadSession, voice: VoiceOption, loading = false): ProgressPayload {
  const embed = buildEmbed(session, voice, loading);

  // Buttons stay until finalizeProgress() replaces the embed at the end of the chapter
  if (loading) return { embeds: [embed], components: [] };

  const components: ActionRowBuilder<ButtonBuilder>[] = [buildControlRow(session.paused)];
  const chRow = buildChapterRow(session);
  if (chRow) components.push(chRow);

  return { embeds: [embed], components };
}

async function updateProgress(session: ReadSession): Promise<void> {
  if (!session.progressMsg) return;
  const now = Date.now();
  if (now - session.lastProgressEdit < 4_500) return;
  session.lastProgressEdit = now;

  const voice = getGuildVoice(session.guildId);
  try {
    await session.progressMsg.edit(buildProgressPayload(session, voice));
  } catch { /* ignore — message may be deleted */ }
}

/** Force an immediate progress bar refresh, bypassing the rate limit.
 *  Call after button interactions so the embed updates instantly. */
export async function forceProgressUpdate(guildId: string): Promise<void> {
  const session = sessions.get(guildId);
  if (!session?.progressMsg) return;
  session.lastProgressEdit = 0;
  await updateProgress(session);
}

async function finalizeProgress(session: ReadSession, stopped = false): Promise<void> {
  if (!session.progressMsg) return;
  const voice   = getGuildVoice(session.guildId);
  const flag    = FLAG[voice.accent] ?? "🌐";
  const elapsed = getElapsedSeconds(session);
  const total   = totalChapterSeconds(session.allChunks);
  const pct     = total > 0 ? Math.min(1, elapsed / total) : 0;
  const filled  = Math.round(pct * BAR_WIDTH);

  if (stopped) {
    const bar = "▓".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR_STOPPED)
      .setTitle(`📖 ${session.title}`)
      .setDescription(`${bar}\n⏹️ Stopped at **${fmt(Math.min(elapsed, total))}** / ~${fmt(total)}`)
      .addFields({ name: "🎙️ Voice", value: `${flag} ${voice.label}`, inline: true });
    try { await session.progressMsg.edit({ embeds: [embed], components: [] }); } catch { /* ignore */ }
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR_DONE)
    .setTitle(`📖 ${session.title}`)
    .setDescription(`${"▓".repeat(BAR_WIDTH)}\n✅ Finished! **${fmt(total)}**`)
    .addFields({ name: "🎙️ Voice", value: `${flag} ${voice.label}`, inline: true });
  try { await session.progressMsg.edit({ embeds: [embed], components: [] }); } catch { /* ignore */ }
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

/** Wait for the player to go idle. Unlike a fixed timeout this survives long pauses. */
async function waitForIdle(session: ReadSession): Promise<void> {
  while (!session.stopped) {
    try {
      await entersState(session.player, AudioPlayerStatus.Idle, 30_000);
      return;
    } catch { /* still playing or paused — keep waiting */ }
  }
}

/** Throw away a pre-generated chunk, rewinding the generator unless a seek already moved it. */
async function discardChunk(session: ReadSession, chunk: ChunkResult): Promise<void> {
  if (chunk.epoch === session.seekEpoch) session.chunkIndex = chunk.chunkIdx;
  await cleanupFile(chunk.file);
}

/** Make sure a pre-generated chunk is still valid (no seek / voice change since it was made). */
async function validateChunk(session: ReadSession, chunk: ChunkResult | null): Promise<ChunkResult | null> {
  if (!chunk) return null;
  if (chunk.epoch !== session.seekEpoch || chunk.voiceVersion !== session.voiceVersion) {
    await discardChunk(session, chunk);
    return generateChunk(session);
  }
  return chunk;
}

async function runPipeline(session: ReadSession): Promise<void> {
  let next = await generateChunk(session);
  await updateProgress(session); // flip from "loading" to live progress

  while (next !== null && !session.stopped) {
    if (session.paused) {
      await discardChunk(session, next);
      while (session.paused && !session.stopped) await sleep(200);
      if (session.stopped) break;
      next = await generateChunk(session);
      continue;
    }

    const current     = next;
    const nextPromise = generateChunk(session); // pre-generate while playing

    session.playingIdx = current.chunkIdx;
    try {
      const resource = createAudioResource(current.file, { inputType: StreamType.Arbitrary });
      session.player.play(resource);
      await entersState(session.player, AudioPlayerStatus.Playing, 10_000);
      await waitForIdle(session);
    } catch { /* player stopped — ok */ } finally {
      await cleanupFile(current.file);
    }

    await updateProgress(session);

    next = await validateChunk(session, await nextPromise);
  }

  // Stop timer before finalizing
  if (session.progressTimer) {
    clearInterval(session.progressTimer);
    session.progressTimer = null;
  }

  await finalizeProgress(session, session.stopped);

  if (!session.stopped) {
    await clearBookmark(session.guildId).catch(() => {});
    await stopSession(session.guildId);
  }
}

// ─── Chunk generation ────────────────────────────────────────────────────────

const FALLBACK_THRESHOLD  = 3; // failures before switching to Jenny
const MAX_CHUNK_ATTEMPTS  = 2; // attempts per chunk with the current voice before giving up on that chunk

async function generateChunk(session: ReadSession): Promise<ChunkResult | null> {
  outer: while (session.chunkIndex < session.allChunks.length) {
    if (session.stopped) return null;

    // Peek — do NOT advance until we have a successful file
    const chunkIdx = session.chunkIndex;
    const epoch    = session.seekEpoch;
    const text     = session.allChunks[chunkIdx]!;
    let localFails = 0;

    while (localFails < MAX_CHUNK_ATTEMPTS) {
      if (session.stopped) return null;

      const capturedVersion = session.voiceVersion;
      const voice           = getGuildVoice(session.guildId);

      try {
        const file = await textToMp3File(text, voice);

        // A seek happened while this chunk was being generated → it's stale, start over
        if (session.stopped || session.seekEpoch !== epoch) {
          await cleanupFile(file);
          if (session.stopped) return null;
          continue outer;
        }

        session.chunkIndex++;          // advance only on success
        session.consecutiveSkips = 0;
        return { file, chunkIdx, voiceVersion: capturedVersion, epoch };
      } catch (err) {
        localFails++;
        session.consecutiveSkips++;
        console.error(`[generateChunk] chunk ${chunkIdx} attempt ${localFails} (${voice.label}): ${(err as Error).message}`);

        // After FALLBACK_THRESHOLD consecutive failures across chunks, switch to Jenny
        if (session.consecutiveSkips >= FALLBACK_THRESHOLD && voice.id !== DEFAULT_VOICE.id) {
          console.warn(`[generateChunk] switching from ${voice.label} to Jenny — retrying chunk ${chunkIdx}`);
          setGuildVoice(session.guildId, DEFAULT_VOICE);
          session.consecutiveSkips = 0;
          localFails = 0; // give Jenny fresh attempts on this chunk
          try {
            await (session.textChannel as any).send(
              `⚠️ Voice **${voice.label}** isn't available right now — switching to **Jenny** to continue reading.`
            );
          } catch { /* ignore */ }
        }
      }
    }

    // Exhausted attempts on this chunk — skip it and move on (unless a seek moved us)
    console.warn(`[generateChunk] skipping chunk ${chunkIdx} after ${MAX_CHUNK_ATTEMPTS} failed attempts`);
    if (session.seekEpoch === epoch) session.chunkIndex++;
    session.consecutiveSkips = 0;
  }
  return null;
}

// ─── Controls ────────────────────────────────────────────────────────────────

export function pauseSession(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session || session.paused) return false;
  session.paused         = true;
  session.pauseStartedAt = Date.now();
  session.player.pause();
  return true;
}

export function resumeSession(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session || !session.paused) return false;
  if (session.pauseStartedAt !== null) {
    session.pausedDuration  += Date.now() - session.pauseStartedAt;
    session.pauseStartedAt   = null;
  }
  session.paused = false;
  session.player.unpause();
  return true;
}

/** Move playback to a chunk (0..length; length = end of chapter) and re-sync the timer. */
function jumpToChunk(session: ReadSession, chunk: number): void {
  const total   = session.allChunks.length;
  const target  = Math.max(0, Math.min(chunk, total));
  const now     = Date.now();

  session.chunkIndex       = target;
  session.playingIdx       = Math.min(target, Math.max(0, total - 1));
  session.seekEpoch++;
  session.voiceVersion++;
  session.consecutiveSkips = 0;

  // Rebase the clock so the bar and timestamps follow the new position
  session.readingStartedAt = now - currentChunkEstimatedSec(session.allChunks, target) * 1000;
  session.pausedDuration   = 0;
  session.pauseStartedAt   = session.paused ? now : null;

  session.player.stop();
}

export function skipParagraph(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session) return false;
  const nextPara = paragraphIndexOfChunk(session, session.playingIdx) + 1;
  const target   = nextPara < session.paragraphStarts.length
    ? session.paragraphStarts[nextPara]!
    : session.allChunks.length;           // last paragraph → finish the chapter
  jumpToChunk(session, target);
  return true;
}

export function seekSession(guildId: string, chunkIndex: number): boolean {
  const session = sessions.get(guildId);
  if (!session) return false;
  jumpToChunk(session, Math.min(chunkIndex, Math.max(0, session.allChunks.length - 1)));
  return true;
}

export function seekSessionBySeconds(guildId: string, targetSec: number): boolean {
  const session = sessions.get(guildId);
  if (!session) return false;
  return seekSession(guildId, chunkIndexAtSecond(session.allChunks, Math.max(0, targetSec)));
}

export function seekRelativeSeconds(guildId: string, deltaSec: number): boolean {
  const session = sessions.get(guildId);
  if (!session) return false;
  return seekSessionBySeconds(guildId, getElapsedSeconds(session) + deltaSec);
}

export function restartSession(guildId: string): boolean {
  return seekSession(guildId, 0);
}

export function skipToChapter(guildId: string, chapterNum: number): { ok: boolean; title: string; total: number } {
  const session = sessions.get(guildId);
  if (!session) return { ok: false, title: "", total: 0 };
  const { chapterBoundaries, chapterTitles } = session;
  if (chapterBoundaries.length === 0) return { ok: false, title: "No chapters detected in this content.", total: 0 };
  const idx = Math.max(0, Math.min(chapterNum - 1, chapterBoundaries.length - 1));
  seekSession(guildId, chapterBoundaries[idx]!);
  return {
    ok:    true,
    title: chapterTitles[idx] ?? `Chapter ${chapterNum}`,
    total: chapterBoundaries.length,
  };
}

// ─── Paragraph navigation & search state (/find) ──────────────────────────────

export function getParagraphs(guildId: string): string[] | null {
  return sessions.get(guildId)?.paragraphs ?? null;
}

/** 0-based paragraph the listener is currently on. */
export function getCurrentParagraphIndex(guildId: string): number | null {
  const session = sessions.get(guildId);
  return session ? paragraphIndexOfChunk(session, session.playingIdx) : null;
}

export function seekToParagraph(guildId: string, paragraphIdx: number): boolean {
  const session = sessions.get(guildId);
  if (!session) return false;
  const start = session.paragraphStarts[paragraphIdx];
  if (start === undefined) return false;
  jumpToChunk(session, start);
  return true;
}

export function setSearchState(guildId: string, state: SearchState | null): void {
  const session = sessions.get(guildId);
  if (session) session.search = state;
}

export function getSearchState(guildId: string): SearchState | null {
  return sessions.get(guildId)?.search ?? null;
}

// ─── Info getters ─────────────────────────────────────────────────────────────

/** Position in PARAGRAPHS (1-based) — what users actually care about. */
export function getProgressInfo(guildId: string): { index: number; total: number; title: string; paused: boolean } | null {
  const session = sessions.get(guildId);
  if (!session) return null;
  return {
    index:  paragraphIndexOfChunk(session, session.playingIdx) + 1,
    total:  session.paragraphs.length,
    title:  session.title,
    paused: session.paused,
  };
}

export function getProgressSeconds(guildId: string): { currentSec: number; totalSec: number; title: string } | null {
  const session = sessions.get(guildId);
  if (!session) return null;
  return {
    currentSec: getElapsedSeconds(session),
    totalSec:   totalChapterSeconds(session.allChunks),
    title:      session.title,
  };
}

export function getChapterInfo(guildId: string): { current: number; total: number; titles: string[] } | null {
  const session = sessions.get(guildId);
  if (!session) return null;
  return {
    current: getCurrentChapterIndex(session) + 1,
    total:   Math.max(1, session.chapterBoundaries.length),
    titles:  session.chapterTitles,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

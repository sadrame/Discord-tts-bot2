# WCT Reader Bot

Discord bot that joins your voice channel and reads web-novel chapters (WCT, AO3) and public Google Docs aloud using Microsoft Edge neural TTS.

## Commands (slash or `!` prefix)
`read <url>` · `join` · `stop` · `pause` · `resume` · `skip` (next paragraph) · `find <text>` · `chapter <n>` · `chapters` · `restart` · `seek <sec>` · `progress` · `speed` · `rewind` · `forward` · `skipstep` · `queue` · `skip` · `previous` · `controls` · `markers` · `expression` · `voice` · `voicesearch` · `invite` · `help`

`find` is typo-tolerant ("wietz" finds "Weitz"). It shows the match with ⬅️ ➡️ to browse and **Go to this** to jump — nothing jumps until you tap it.

## Voices
`/voice` opens a picker with service filters — **Bing** (free Microsoft Edge voices), **ElevenLabs**, **Reader** (voices ElevenLabs has enabled for its ElevenReader app) and **All**. Pick a voice to see a preview card, tap **Test** to hear a sample, then **Apply**. `/voicesearch <name or style>` searches the same services (try `sarah` or `british narrator`). Your server's voice is remembered across restarts when Upstash is set up.

ElevenLabs voices need `ELEVENLABS_API_KEY` and use your ElevenLabs credits (test samples are free). If credits run out mid-chapter the bot falls back to Jenny and tells you. ElevenReader's *Iconic Voices* (Judy Garland etc.) are exclusive to the ElevenReader app and aren't available through any API.

Every voice shows the plan it needs (🆓 Free, 💳 Starter+/Creator+/Paid), and the preview card warns you if your ElevenLabs plan is too low.

## Speed, rewind and fast-forward
The player has 🐢 Slower / 🐇 Faster buttons, and **⚙️ Custom…** opens a popup to set the exact speed, the speed-button step and the skip step. `/speed 1.25` sets it directly (0.5×–3×). `/rewind` and `/forward` move by your skip step, or by an amount: `/forward 30`, `/rewind 1m30s`. `/skipstep 15` changes the default. Speed changes apply from the next sentence and are remembered per server.

## If the bot is offline
Open `https://<your-service>.onrender.com/status` in a browser — it says whether Discord is connected and, if not, exactly why (token rejected/reset, Message Content Intent off, Discord blocking the IP, no token set…). The bot never exits on a failed login (restart loops make Discord block or reset the token); it retries by itself with growing waits, except for a rejected token, which needs a new one in Render → Environment. Slash commands are only re-sent to Discord when they change, and the bot pings its own URL every 4 minutes so Render's free plan doesn't put it to sleep (`KEEPALIVE_URL` to override).

## Queue
`/read <url>` plays right away if nothing is playing, otherwise adds the link to the queue; links then play one after another without the bot leaving the channel. `/queue` shows it Jockie-style (page, `[mm:ss]`, linked titles, a "Make a selection" menu to play now / play next / remove, and you can also type `next page`, `previous page`, `go to page 3` or `cancel`). `/skip` skips the current link, `/previous` goes back, `/remove <n>`, `/clear`, and `/skipparagraph` skips just the paragraph. `/stop` clears everything.

**Controls:** by default the person who started the queue, whoever queued the link that's playing, and people with Manage Server can skip/pause/seek/stop. Everyone can add links and view the queue. If the owner leaves the voice channel, anyone in it can steer. `/controls open` lets everyone control (Manage Server or the owner can switch it).

## Japanese
Japanese text (kana/kanji) inside a chapter is read aloud in Japanese by a Japanese Bing voice matching the current voice's gender — not translated. ElevenLabs voices read Japanese themselves.

## Images
A picture on the page is announced as "Image file." (no sound or marker). Emoji, icons and avatars are ignored.

## Links it can read
Web chapters (WCT, AO3…), public Google Docs, and direct **.pdf / .txt** links such as archive.org downloads. For PDFs the bot rebuilds paragraphs, removes running headers and page numbers, rejoins hyphenated words and turns "Chapter N" lines into chapters you can jump to with `/chapter`. Big books: it reads 250 pages at a time by default; add `#pages=1-80` (or `#page=120`) to the end of the link to choose where to start. Scanned PDFs (pictures of text) can't be read. Bullet and numbered lists on web pages are read item by item. Env: `MAX_PDF_PAGES` (default 250), `MAX_PDF_MB` (default 80).

## Gaps
Blank spacing never makes the bot go quiet. Empty paragraphs — including ones filled with invisible characters (zero-width spaces, braille blanks) — are skipped, runs of the same gap collapse to one (five `……` lines → one short pause, two `△▼△▼` → one scene break), extra spaces/newlines inside a paragraph become one space, and `........` becomes `...`. It's automatic for every source (web pages, Google Docs, PDFs).

## Expressive Bing voices
`/expression off|normal|strong` — WORDS IN CAPS are louder and higher, `!` makes a sentence louder and quicker, `?` raises the pitch, `...` trails off slower, and stretched words like "Noooo" are drawn out. Bing voices only (ElevenLabs voices already do this themselves). If Bing ever rejects a styled request the bot falls back to plain reading automatically. `EXPRESSION=off` disables it for the whole bot.

## Chapter dividers (WCT-style)
Rows like `※　※　※　※` and `△▼△▼△▼△` have no words, so they used to play as silence. They're now announced: scene breaks (`△▼△▼`, `◇◆◇◆`, `***`…) get one chime, and `※` rows mark a translator's note starting (three quick pings), ending (falling two notes) or the end of the chapter (slow falling cadence). `/markers style:chime|voice|both|off` picks how; `/markers notes:skip` leaves translator's notes out entirely. Plain `……` lines stay a quiet pause.

## Reactions for Bing voices
Screams, screeches and scratches (`AAAAAH`, `Skreeee`, `*scratches*`…) play as real sounds instead of being spelled out. Put clips in `sounds/` (see `sounds/README.md`) or set `SFX_ELEVENLABS=1` to have ElevenLabs generate them once. ElevenLabs voices already do this themselves.

## Several servers at once
Speech is generated by a small shared pool (`TTS_CONCURRENCY`, default 3) with about 20 seconds of audio prepared ahead (`PREFETCH_SECONDS`) and pre-encoded to Opus, so one server never makes another wait. `FFMPEG_CONCURRENCY` (default 2) caps simultaneous ffmpeg jobs; `PREENCODE_OPUS=off` switches back to live transcoding.

Positions are saved per person per chapter (autosaved while you listen and on shutdown). Re-run `/read` on the same link to resume; `/restart` starts over.

## Deploy on Render (free)
1. Render → New → Blueprint (uses `render.yaml`) from this repo.
2. Set `DISCORD_BOT_TOKEN` (optionally `DISCORD_LOG_CHANNEL_ID`).
3. Point UptimeRobot at your `https://<service>.onrender.com` URL every 5 minutes — free web services sleep after ~15 min without traffic.
4. Developer Portal → Bot → turn **Message Content Intent** ON.

## Environment variables
| Name | Purpose |
|---|---|
| `DISCORD_BOT_TOKEN` | required |
| `DISCORD_LOG_CHANNEL_ID` | optional read-request log |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | **recommended** — free Upstash Redis so saved reading positions survive Render restarts |
| `ELEVENLABS_API_KEY` | optional — enables ElevenLabs and Reader voices |
| `ELEVENLABS_MODEL` | optional — default `eleven_flash_v2_5` (their cheaper, fast model) |
| `ELEVENLABS_BASE_URL` | optional — e.g. `https://api.eu.residency.elevenlabs.io` for EU data residency |
| `SFX` | `off` turns the Bing reaction sounds off (default on) |
| `SFX_ELEVENLABS` | `1` = generate missing reaction sounds with ElevenLabs (needs `ELEVENLABS_API_KEY`) |
| `SOUNDS_DIR` | folder for your own reaction sounds (default `./sounds`) |
| `TTS_CONCURRENCY` | speech requests at once across all servers (default 3; use 2 on ElevenLabs' free plan) |
| `PREFETCH_SECONDS` | audio generated ahead of playback (default 20) |
| `FFMPEG_CONCURRENCY` | simultaneous ffmpeg jobs (default 2) |
| `VOICE_READY_TIMEOUT_MS` | voice handshake timeout, default 60000 |
| `STORE_FILE` | fallback file for saved positions/voices when Upstash isn't set (lost on every Render restart) |

## Layout
`package.json`, `tsconfig.json`, `render.yaml` at the repo root; all code in `src/`.

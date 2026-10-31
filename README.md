# WCT Reader Bot

Discord bot that joins your voice channel and reads web-novel chapters (WCT, AO3) and public Google Docs aloud using Microsoft Edge neural TTS.

## Commands (slash or `!` prefix)
`read <url>` · `join` · `stop` · `pause` · `resume` · `skip` (next paragraph) · `find <text>` · `chapter <n>` · `chapters` · `restart` · `seek <sec>` · `progress` · `voice` · `voicesearch` · `invite` · `help`

`find` is typo-tolerant ("wietz" finds "Weitz"). It shows the match with ⬅️ ➡️ to browse and **Go to this** to jump — nothing jumps until you tap it.

## Voices
`/voice` opens a picker with service filters — **Bing** (free Microsoft Edge voices), **ElevenLabs**, **Reader** (voices ElevenLabs has enabled for its ElevenReader app) and **All**. Pick a voice to see a preview card, tap **Test** to hear a sample, then **Apply**. `/voicesearch <name or style>` searches the same services (try `sarah` or `british narrator`). Your server's voice is remembered across restarts when Upstash is set up.

ElevenLabs voices need `ELEVENLABS_API_KEY` and use your ElevenLabs credits (test samples are free). If credits run out mid-chapter the bot falls back to Jenny and tells you. ElevenReader's *Iconic Voices* (Judy Garland etc.) are exclusive to the ElevenReader app and aren't available through any API.

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
| `VOICE_READY_TIMEOUT_MS` | voice handshake timeout, default 60000 |
| `STORE_FILE` | fallback file for saved positions/voices when Upstash isn't set (lost on every Render restart) |

## Layout
`package.json`, `tsconfig.json`, `render.yaml` at the repo root; all code in `src/`.

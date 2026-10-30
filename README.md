# WCT Reader Bot

Discord bot that joins your voice channel and reads web-novel chapters (WCT, AO3) and public Google Docs aloud using Microsoft Edge neural TTS.

## Commands (slash or `!` prefix)
`read <url>` · `join` · `stop` · `pause` · `resume` · `skip` (next paragraph) · `find <text>` · `chapter <n>` · `chapters` · `restart` · `seek <sec>` · `progress` · `voice` · `invite` · `help`

`find` is typo-tolerant ("wietz" finds "Weitz"). It shows the match with ⬅️ ➡️ to browse and **Go to this** to jump — nothing jumps until you tap it.

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
| `VOICE_READY_TIMEOUT_MS` | voice handshake timeout, default 60000 |
| `BOOKMARKS_FILE` | fallback file for saved positions when Upstash isn't set (lost on every Render restart) |

## Layout
`package.json`, `tsconfig.json`, `render.yaml` at the repo root; all code in `src/`.

# WCT Reader Bot

Discord bot that joins your voice channel and reads web-novel chapters (WCT, AO3) and public Google Docs aloud using Microsoft Edge neural TTS.

## Commands (slash or `!` prefix)
`read <url>` · `join` · `stop` · `pause` · `resume` · `skip` (next paragraph) · `find <text>` · `chapter <n>` · `chapters` · `restart` · `seek <sec>` · `progress` · `voice` · `invite` · `help`

`find` is typo-tolerant ("wietz" finds "Weitz") and shows ⬅️ ➡️ buttons to cycle through every match.

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
| `VOICE_READY_TIMEOUT_MS` | voice handshake timeout, default 60000 |
| `BOOKMARKS_FILE` | optional path for saved positions (Render's free disk resets on restart) |

## Layout
`package.json`, `tsconfig.json`, `render.yaml` at the repo root; all code in `src/`.

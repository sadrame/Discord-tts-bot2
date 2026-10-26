# WCT Reader Bot

Discord bot that joins your voice channel and reads web-novel chapters (WCT, AO3) and public Google Docs aloud using Microsoft Edge neural TTS.

## Deploy on Render (free)

1. Push this folder to your GitHub repo.
2. Render → New → Blueprint (uses `render.yaml`), or New → Web Service with:
   - Build: `npm install && npm run build`
   - Start: `npm start`
   - Env var `NODE_VERSION` = `22.12.0`
3. Add env var `DISCORD_BOT_TOKEN` (and optionally `DISCORD_LOG_CHANNEL_ID`).
4. Free web services sleep after ~15 min without web traffic. Point UptimeRobot at your
   `https://<service>.onrender.com` URL every 5 minutes to keep the bot online.

## Discord Developer Portal
- Bot → Privileged Gateway Intents → **Message Content Intent** ON
- Invite permissions: Send Messages, Embed Links, Read Message History, Connect, Speak (use `/invite`)

## Google Docs
Doc must be shared as **Anyone with the link → Viewer** (or "Published to the web").
Headings in the doc become navigable chapters. Only the first tab of a multi-tab doc is read.

## Notes
- ffmpeg comes from the `ffmpeg-static` package, so Render needs no extra setup.
- Bookmarks are saved to `data/bookmarks.json`; Render's free disk is wiped on each deploy/restart.
- `voices.ts`, `bookmarks.ts` and `commands.ts` were rebuilt from how the other files use them.
  If you have your originals, drop them into `src/` over these.

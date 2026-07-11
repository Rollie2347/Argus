# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Canonical directory

Use `Argus/` (capital A). An older lowercase `argus/` Python/FastAPI prototype may exist on some local machines/sandboxes (it's referenced in `start.sh`, a leftover from an earlier hackathon layout) — it is **not** in the GitHub repo and should not be treated as current.

## What this is

Argus is a real-time multimodal AI life companion built on the Gemini Live API (vision + voice), built for the Gemini Live Agent Challenge. One WebSocket connection = one persistent Gemini Live session with camera frames, mic audio, and tool-calling flowing bidirectionally.

## Repo layout

```
Argus/
├── backend/           # Node/Express/WebSocket relay to Gemini Live — the core service
│   ├── server.js        # Entry point, port 8080, path /ws
│   ├── agents.js        # Tool declarations + handlers + system prompt (14 tools)
│   ├── memory.js        # Firestore persistence
│   └── weather.js       # Open-Meteo integration
├── frontend/index.html  # Vanilla JS PWA — most complete camera/audio path, use this to validate changes
├── mobile/             # Expo/React Native app — newer surface, not feature-complete (see below)
├── deploy/              # Present in repo; not documented in README
├── terraform/main.tf   # IaC for Cloud Run + Firestore
├── Dockerfile
├── deploy-cloudrun.sh
├── ARCHITECTURE.md      # Diagrammed system overview + data flow
└── README.md
```

## Commands

No lint or test suite is configured anywhere in this repo (no test framework in `backend/package.json` or `mobile/package.json`, no CI beyond the Claude Code review/assistant workflows in `.github/workflows/`). Verify changes by running the backend and exercising the WebSocket flow through `frontend/index.html`, not by looking for a test command that doesn't exist.

**Backend**
```bash
cd backend
npm install
cp .env.example .env   # set GEMINI_API_KEY, GCP_PROJECT_ID at minimum
npm start               # node server.js — http://localhost:8080
npm run dev              # node --watch server.js — auto-restart on change
cloudflared tunnel --url http://localhost:8080   # HTTPS tunnel, required for phone camera/mic testing
```
Local dev also needs a Firestore `backend/service-account.json` (gitignored). Cloud Run uses default credentials instead.

**Mobile (Expo)**
```bash
cd mobile
npm install
npm start        # expo start
npm run android  # expo run:android
npm run ios       # expo run:ios
```

**Deploy**
```bash
./deploy-cloudrun.sh YOUR_GEMINI_API_KEY [LAT LON TIMEZONE]
```
Hardcoded project `agus-488919`; enables Cloud Run/Artifact Registry/Cloud Build/Firestore and deploys with session affinity (required — WebSocket connections must stick to one instance). Terraform alternative in `terraform/main.tf` (`terraform init && terraform apply -var="gemini_api_key=..." -var="project_id=..."`).

## Architecture

- **Backend is a stateful relay, not a REST API.** `server.js` upgrades each `/ws` connection to a WebSocket, opens one Gemini Live session per connection, and pipes camera JPEGs (`image/jpeg`) and mic audio (`audio/pcm;rate=16000`) to Gemini, then streams audio/text/tool-call responses back. Session lifetime = connection lifetime.
- **Tools are in-process functions, not microservices.** `backend/agents.js` defines 14 Gemini function declarations (`identify_scene`, `get_recipe_suggestion`, `cooking_timer`, `compare_products`, `diagnose_problem`, `read_text`, `manage_shopping_list`, `remember_preference`, `recall_memory`, `get_weather`, `log_daily_activity`, `get_daily_summary`, `web_search`, `get_restaurant_website`) plus their handlers and the system prompt (casts Argus as proactive, warm, concise — 1-3 sentence voice replies). When Gemini calls a tool, `server.js` executes the local handler and feeds the result back into the same session.
- **Memory is Firestore, keyed by user.** `backend/memory.js`: `users/{userId}` profile, `users/{userId}/daily/{date}` logs, `users/{userId}/lists/shopping`, `users/{userId}/observations/*`.
- **Weather is unauthenticated.** `backend/weather.js` calls Open-Meteo directly (no API key), caching results in a `Map` keyed by rounded coordinates (`lat.toFixed(2),lon.toFixed(2)`) for 30 minutes per location.
- **`frontend/index.html`** is the reference client: captures JPEG frames every ~2s, streams PCM16 mic audio, plays back PCM24 responses sequentially, and is the fastest way to confirm the Gemini Live pipeline still works end-to-end.
- **`mobile/`** connects via `services/websocket.ts` (`ArgusSocket`), streams mic audio, captures camera frames every ~2s (`startFrameLoop` in `home.tsx`), and plays back incoming PCM audio via a queued `Audio.Sound` (WAV-wrapped, since expo-av can't play raw PCM buffers directly).

## Verified known issues (prioritized)

1. ~~Duplicate `@google-cloud/firestore` in `backend/package.json`~~ — **Fixed 2026-07-11:** removed the dead `^8.3.0` line; `^7.0.0` (already what `package-lock.json` resolved to) is now the only entry.
2. ~~`currentUserId` is a module-level global in `agents.js`~~ — **Fixed 2026-07-11:** removed `currentUserId`/`setUserId()`; `handleToolCall(functionCall, userId)` and `buildSystemInstruction(lat, lon, city, userId)` now take `userId` explicitly, threaded from a per-connection closure variable in `server.js`. This also surfaced and fixed a deeper bug: `buildSystemInstruction` was previously called *before* the client's `user_id` message could ever be received (the message listener wasn't registered yet at that point), so every connection's initial memory context was built from a stale/default id, not just under concurrent load. `server.js` now runs `waitForUserId()` (listens immediately on connect, 3s timeout fallback to `"default"`) before building the system instruction or opening the Gemini session.
3. ~~Weather cache not keyed by location~~ — **Fixed 2026-07-11:** `backend/weather.js` now uses a `Map` keyed by rounded lat/lon instead of one shared cache slot.
4. **Mobile (`mobile/app/(main)/home.tsx`) — frame capture and audio playback fixed 2026-07-11:**
   - ~~Frame capture~~: `home.tsx` now runs a 2s `setInterval` (`startFrameLoop`/`stopFrameLoop`) that calls `cameraRef.current.takePictureAsync({ base64: true, quality: 0.5, ... })` and forwards frames via `socketRef.current.sendImage(...)`. Note: unlike the web client (which downsamples to a 640×480 canvas), mobile frames are only JPEG-compressed (`quality: 0.5`), not resized — expo-camera has no built-in resize, so mobile frames are larger over the wire. Not addressed; flag if bandwidth becomes an issue.
   - ~~Audio playback~~: incoming `"audio"` messages are now queued (`enqueueAudio`/`playNextInQueue`) and played sequentially via `Audio.Sound`, each PCM16/24kHz chunk wrapped in a WAV header (`pcmToWavBase64`) since expo-av can only load audio files/URIs, not raw buffers.
   - Net effect: the Expo app should now have working vision input and voice output, matching the web PWA's capabilities. **Caveat: neither fix has been runtime-verified on a physical device/simulator yet** — code-complete only. Also untested: iOS audio-session interaction between simultaneous mic recording (`allowsRecordingIOS: true`) and playback, which may need `interruptionModeIOS`/`playThroughEarpieceAndroid` tuning if audio doesn't play through cleanly during a live conversation.
5. **Model retirement risk.** `server.js` currently targets a Gemini Live preview model — preview model names get retired without much notice. Check current availability before assuming the configured model still works, and re-verify the model string in `server.js` against the Gemini API docs periodically.
6. ~~`mobile/.env` was previously committed~~ — **corrected 2026-07-11:** checked full non-shallow history (`git log --all --diff-filter=A --name-only`) across every ref; only `mobile/.env.example` was ever added under `mobile/`. The commit titled "Stop tracking mobile/.env" only touches `.gitignore`, not a tracked file. No secret was ever committed here and none is rotation-needed. `mobile/.env` is gitignored alongside `.env`, `service-account.json`, and `node_modules/` as a preventive measure — keep it that way, but there's no cleanup action pending.

## Onboarding order for a fresh session

Read `README.md` → `ARCHITECTURE.md` → `backend/server.js` → `backend/agents.js` → `mobile/app/(main)/home.tsx`. Run the backend and validate the web PWA (`frontend/index.html`) end-to-end before touching the Expo app — it's the most complete surface and the fastest way to confirm the Gemini Live pipeline still works.

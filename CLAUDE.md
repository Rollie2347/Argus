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
├── frontend/privacy.html # Privacy policy, served at GET /privacy — required for App Store Connect
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
./deploy-cloudrun.sh YOUR_GEMINI_API_KEY YOUR_WS_SHARED_SECRET [LAT LON TIMEZONE]
```
Hardcoded project `agus-488919`; enables Cloud Run/Artifact Registry/Cloud Build/Firestore and deploys with session affinity (required — WebSocket connections must stick to one instance). `WS_SHARED_SECRET` gates the WebSocket endpoint (see Security below) and is a required startup var, same as `GEMINI_API_KEY` — the server exits immediately if either is missing. Terraform alternative in `terraform/main.tf` (`terraform init && terraform apply -var="gemini_api_key=..." -var="ws_shared_secret=..." -var="project_id=..."`).

## Architecture

- **Backend is a stateful relay, not a REST API.** `server.js` upgrades each `/ws` connection to a WebSocket, opens one Gemini Live session per connection, and pipes camera JPEGs (`image/jpeg`) and mic audio (`audio/pcm;rate=16000`) to Gemini, then streams audio/text/tool-call responses back. Session lifetime = connection lifetime.
- **Tools are in-process functions, not microservices.** `backend/agents.js` defines 14 Gemini function declarations (`identify_scene`, `get_recipe_suggestion`, `cooking_timer`, `compare_products`, `diagnose_problem`, `read_text`, `manage_shopping_list`, `remember_preference`, `recall_memory`, `get_weather`, `log_daily_activity`, `get_daily_summary`, `web_search`, `get_restaurant_website`) plus their handlers and the system prompt (casts Argus as proactive, warm, concise — 1-3 sentence voice replies). When Gemini calls a tool, `server.js` executes the local handler and feeds the result back into the same session.
- **Memory is Firestore, keyed by user.** `backend/memory.js`: `users/{userId}` profile, `users/{userId}/daily/{date}` logs, `users/{userId}/lists/shopping`, `users/{userId}/observations/*`.
- **Every WebSocket connection must present `WS_SHARED_SECRET` before anything else happens.** Fixed 2026-07-11: the client's first `{type:"user_id"}` message must include a `secret` field matching the server's `WS_SHARED_SECRET` env var (`crypto.timingSafeEqual` comparison in `server.js`); a missing/wrong secret closes the socket (code `4001`) before any geo lookup or Gemini session is opened. This was added because the repo is public and `mobile/services/websocket.ts` had hardcoded the live Cloud Run URL as a fallback default, meaning the endpoint was effectively already public with zero validation. `frontend/index.html` gets the secret injected server-side at request time (never committed); mobile reads it from `EXPO_PUBLIC_WS_SHARED_SECRET`. `server.js` also enforces per-IP HTTP rate limiting on `/api/*`, a per-IP WebSocket connection cap, per-connection message-rate limiting, and message type/size validation — all in-memory (resets per Cloud Run instance, doesn't coordinate across concurrent instances; acceptable at personal-testing scale). **Beyond that gate, individual tool calls and memory reads/writes still trust the self-asserted `userId` alone — except destructive HTTP calls, which require a separate per-user device secret.** `POST /api/user/:userId/claim` mints a one-time 256-bit secret (`crypto.randomBytes`) the first time a given `userId`'s Firestore doc is created; the claim transaction refuses (`409`) if the doc already exists for any reason, so an in-use id can never be re-claimed by a different caller. `DELETE /api/user/:userId` (used by the mobile "Delete my data" control) requires that secret as `Authorization: Bearer <secret>`, verified via `verifyDeviceSecret` in `memory.js` with a timing-safe comparison; it 403s otherwise. Mobile claims the secret once in `saveUser()` (`mobile/services/auth.ts`) and stores it in Keychain via `expo-secure-store`. `GET /privacy` serves `frontend/privacy.html` (required for App Store Connect).
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
7. **Mobile dependency versions were fixed for real SDK 54 alignment on 2026-07-11, but the result is code-complete only — not yet build-verified.** `mobile/package.json` had declared `expo: ~54.0.0` / `app.json` had `sdkVersion: 54.0.0` while every sibling native module and `package-lock.json` were still fully on a consistent SDK 52 tree (`react-native` 0.76.5, `react` 18.3.1, `react-native-reanimated` 3.16.7, old architecture) — an inconsistent half-migrated state that would very likely have broken `eas build`. Fixed by bumping `react` to `19.1.0`, `react-native-reanimated` to `~4.1.1` (+ new `react-native-worklets` dependency), `newArchEnabled: true` in `app.json`, and every Expo-bundled native module (`expo-router`, `expo-camera`, `expo-av`, `expo-status-bar`, `expo-secure-store`, `react-native-gesture-handler`, `react-native-safe-area-context`, `react-native-screens`, `@react-native-async-storage/async-storage`) to the versions pinned in Expo's own `bundledNativeModules.json` for `expo@54.0.0` (cross-checked via the npm registry, not guessed). **No `npm install` has been run since** (`package-lock.json` is stale — use `npm install`, not `npm ci`, next time), and there was no `node_modules`/simulator available to actually build or run it. Before the next `eas build`: `npm install`, then `npx expo-doctor`, then a real device/simulator run — the React 19 + New Architecture jump is the one part of this with real runtime-behavior risk that only a live build can confirm.

## Onboarding order for a fresh session

Read `README.md` → `ARCHITECTURE.md` → `backend/server.js` → `backend/agents.js` → `mobile/app/(main)/home.tsx`. Run the backend and validate the web PWA (`frontend/index.html`) end-to-end before touching the Expo app — it's the most complete surface and the fastest way to confirm the Gemini Live pipeline still works.

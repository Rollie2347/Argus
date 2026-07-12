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
├── terraform/main.tf   # IaC for Cloud Run + Firestore
├── Dockerfile
├── deploy-cloudrun.sh
├── ARCHITECTURE.md      # Diagrammed system overview + data flow
└── README.md
```

## Commands

No lint is configured anywhere in this repo, and mobile still has no test suite (no CI beyond the Claude Code review/assistant workflows in `.github/workflows/`). `backend/` has a minimal smoke suite added 2026-07-12 — see `npm test` below. For everything beyond that, verify changes by running the backend and exercising the WebSocket flow through `frontend/index.html`.

**Backend**
```bash
cd backend
npm install
cp .env.example .env   # set GEMINI_API_KEY, GCP_PROJECT_ID at minimum
npm start               # node server.js — http://localhost:8080
npm run dev              # node --watch server.js — auto-restart on change
npm test                 # node --test "test/**/*.test.js" — smoke tests, see below
cloudflared tunnel --url http://localhost:8080   # HTTPS tunnel, required for phone camera/mic testing
```
Local dev also needs a Firestore `backend/service-account.json` (gitignored). Cloud Run uses default credentials instead.

`npm test` runs `backend/test/server.smoke.test.js`: spawns the server with a throwaway `GEMINI_API_KEY`/`WS_SHARED_SECRET`/no real Firestore creds, then checks `GET /api/health` and the WS auth gate (missing secret / wrong secret / correct secret, asserting the 4001 close behavior). It does **not** exercise a real Gemini Live round trip — that needs a real API key and would cost money on every test run, so it's deliberately out of scope. Run a single file directly with `node --test test/server.smoke.test.js` if needed; on this checkout, `node --test test/` (directory form, no glob) failed to resolve on Windows/Git Bash — use the quoted glob form from the npm script instead.

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
7. ~~Mobile dependency versions needed real SDK 54 alignment~~ — **Fixed 2026-07-11, `npm install` completed and verified 2026-07-12:** `mobile/package.json` had declared `expo: ~54.0.0` / `app.json` had `sdkVersion: 54.0.0` while every sibling native module and `package-lock.json` were still fully on a consistent SDK 52 tree — an inconsistent half-migrated state that would very likely have broken `eas build`. Fixed by bumping every Expo-bundled native module to the versions pinned in `expo@54.0.0`'s `bundledNativeModules.json`. `npm install` has since actually been run (`mobile/node_modules` exists) and `npx expo-doctor` passes 18/18 checks; the install also surfaced two missing `expo-router` peer deps (`expo-constants`, `expo-linking`), now added to `package.json`. **Still not verified on a real device/simulator** — that's the one thing that requires your physical iPhone, see Session status below.
8. ~~Unused `@google/adk` dependency and never-installed `backend/node_modules`~~ — **Fixed 2026-07-12:** `@google/adk` was never imported anywhere (only referenced in a `server.js` comment) but pulled in the entire ADK dependency tree (`@mikro-orm/*`, `hono`, `sqlite3`, `mariadb`, etc.), accounting for 41 of 58 `npm audit` findings including both criticals. Removed it; `backend/node_modules` had also never been installed in this checkout — ran `npm install`, confirmed `node server.js` resolves all imports and fails cleanly only on the expected missing-`GEMINI_API_KEY` check. Backend audit findings now 6 moderate (deep transitive `uuid`/`gaxios` deps of `@google-cloud/firestore`, no fix without a breaking major bump — not worth forcing). Also fixed: root `.gitignore`'s `mobile/.env` line had been appended as UTF-16LE at some point (likely a PowerShell append with default encoding) and never actually matched anything — rewrote the file as plain UTF-8. No behavior change in practice since `mobile/.gitignore` already had its own working `.env` entry covering the same path.
9. ~~WebSocket endpoint had zero auth, rate limiting, or input validation~~ — **Fixed 2026-07-12, see the Architecture section above for the mechanism.** This was the highest-severity finding of the session: the repo is public and the live Cloud Run WS URL was hardcoded in `mobile/services/websocket.ts` as a fallback default, so the unauthenticated endpoint was already effectively public. Verified live with a throwaway local secret: unauthenticated/wrong-secret WS connections get closed (code `4001`) before any Gemini session opens; correctly-authenticated ones proceed normally.
10. ~~`deploy/` (`deploy/deploy.sh`, `deploy/main.tf`) was a stale duplicate that predated the `WS_SHARED_SECRET` work~~ — **Removed 2026-07-12.** It diffed against `deploy-cloudrun.sh`/`terraform/main.tf` as missing the `ws_shared_secret` variable entirely and using an older argument order (`PROJECT_ID API_KEY`, no secret) — deploying through it would have stood up the Cloud Run service with the WS endpoint unauthenticated again. Confirmed unreferenced anywhere else in the repo (no CI, no README, no other doc) before deleting. Use `deploy-cloudrun.sh` or `terraform/main.tf` for all deploys.
11. ~~`mobile/app.json`'s Android `permissions` array requested `READ_SMS` and `RECEIVE_SMS`~~ — **Fixed 2026-07-12:** confirmed zero SMS-related code anywhere in `mobile/` (`mobile/services/gmail.ts` is an empty two-line stub, `// Gmail integration — coming in v1.1`, and nothing else references SMS), so removed both from the `permissions` array. `READ_SMS`/`RECEIVE_SMS` are Google Play restricted permissions requiring a declaration form and justification in Play Console; they were an unnecessary Play Store rejection risk and privacy footprint. `permissions` is now just `["CAMERA", "RECORD_AUDIO"]`, matching what's actually used.
12. **The `WS_SHARED_SECRET` fixed in known issue #9 is served in plaintext to anyone who loads the public site — it does not actually gate access the way the name implies.** `server.js`'s `serveIndexWithSecret` (the handler for `GET /` and `/index.html`) injects the live `WS_SHARED_SECRET` value directly into the HTML sent to *any* visitor, no login or check required. View-source (or `curl` the URL) trivially recovers the secret. This means the auth gate only stops connections that never touch the frontend page at all (blind scripted hits directly against `/ws`, which was the literal threat described in #9) — it does **not** stop anyone who loads the public URL once, extracts the secret, and then scripts unlimited direct WS connections from unlimited IPs (the per-IP cap of 5 connections in `server.js` is easy to route around with multiple IPs/proxies, and there is no global concurrency cap at all). Practically this bounds cost only against *unaware* abuse, not *deliberate* abuse by anyone who visits the page — worth deciding whether that's an acceptable risk at current (personal-testing / hackathon-demo) scale, or whether the frontend needs a different distribution model (e.g. a short-lived per-session token minted by an authenticated endpoint instead of a static secret baked into public HTML). Not fixed — flagged for a decision, not a code change, since the "right" fix depends on how public-facing this is meant to stay.

## Session status — iPhone testing + App Store readiness plan (started 2026-07-11, resumed after a mid-session shutdown)

Working through a 6-phase plan: (1) core mobile functionality, (2) security, (3) performance/reliability, (4) automated smoke checks, (5) iOS-specific readiness, (6) App Store readiness report. Phases 1–5 are done as of 2026-07-12; phase 6 is a standalone report (see below, not stored in this file).

**Phase 1 — Core functionality: confirmed done.** `mobile/app/(main)/home.tsx` genuinely captures camera frames and plays back audio (see known issue #4).

**Phase 2 — Security: done**, see known issues #8–9 above for what changed. Origin-header checks were considered and deliberately **not** added — the realistic threat here (scripted clients hitting the URL directly) doesn't send an `Origin` header at all, so the shared secret already covers it more effectively than an origin allow-list would. **Revisit:** known issue #12 (secret is readable in the public HTML) means this phase's protection is weaker against a deliberate/motivated actor than the original writeup implied — read it before treating WS auth as a hard boundary.

**Phase 3 — Performance/reliability: done.**
- `backend/agents.js`'s `timers` Map was module-level, shared across all connections (same bug class as the already-fixed `currentUserId` global) — fixed by scoping it per-`userId` via `getUserTimers(userId)`.
- `server.js`'s Gemini `onerror` callback notified the client but never closed the socket or cleared `session`, unlike `onclose` — a Gemini-side error not followed by a close event left a zombie connection holding a per-IP connection slot indefinitely. Fixed: `onerror` now closes the client socket too, which routes through the existing `clientWs` `close` handler cleanup.
- `memory.js` read/write volume per tool call: reviewed, no fix needed — each tool call does 0–2 sequential Firestore round trips (~50–150ms each), a minor voice-latency add but not a real bottleneck at personal-testing scale.
- Worst-case Gemini cost: rate limits (5 conns/IP, 30 msg/sec/conn) bound cost *per IP*, but there's no global concurrency cap, and known issue #12 means the secret doesn't actually restrict *who* can open connections — so total worst-case cost is effectively unbounded if the public URL gets traffic. Rough per-connection order of magnitude at `gemini-2.5-flash-native-audio` pricing ($3/1M audio-input tokens, $12/1M audio-output tokens, $3/1M image tokens, ~25 tokens/sec of audio): well under $0.10/minute per open connection: continuous audio in+out plus a frame every ~2s.

**Phase 4 — Automated smoke checks: done.** Added `backend/test/server.smoke.test.js` (Node's built-in `node:test`, no new dependency) — see Commands section above for what it covers and its deliberate scope limits. No lint/typecheck added: mobile's existing `npx tsc --noEmit` already covers typechecking there, and backend genuinely has nothing today; left as optional/low-priority since a lint config is a style decision, not a correctness gap.

**Phase 5 — iOS-specific readiness: done, with one open item.**
- `NSCameraUsageDescription`/`NSMicrophoneUsageDescription` already present in `mobile/app.json`.
- known issue #11 (unused Android `READ_SMS`/`RECEIVE_SMS`) fixed.
- Expo Go vs EAS build: **Expo Go works as-is** for dev iteration — every native dependency (`expo-camera`, `expo-av`, `expo-secure-store`, `react-native-reanimated`/`worklets`, `expo-router`, etc.) is within Expo Go SDK 54's bundled module set, no custom native module requiring a dev client. Caveat: Expo Go uses its *own* bundled permission strings/manifest, so the custom `NSCameraUsageDescription`/Android `permissions` in `app.json` only take effect in a real EAS build — camera/mic *function* identically in Expo Go, but you won't see Argus's actual permission prompt copy until testing an EAS build. `mobile/eas.json` already has a `development` profile (`developmentClient: true`, internal distribution) ready to use.
  - Quick dev-loop, no Apple Developer account needed: `cd mobile && npx expo start`, scan the QR with the Expo Go app.
  - Real dev-client build (needed to see final permission copy, and eventually to submit): `cd mobile && npx eas login && npx eas build --profile development --platform ios`, install on device, then `npx expo start --dev-client`.
  - Production/App Store build: `npx eas build --profile production --platform ios && npx eas submit --platform ios`.

**Phase 6 (App Store readiness report):** report-only, delivered directly to the user at the end of the 2026-07-12 session rather than stored here (it doesn't hold up as durable repo guidance — Apple Developer account status and App Store Connect listing state are facts about the user's Apple account, not the code).

**Your action items (nobody else can do these):**
1. Generate a shared secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Set `WS_SHARED_SECRET=<that value>` in your real `backend/.env` (local dev) and redeploy Cloud Run with it — `./deploy-cloudrun.sh <GEMINI_API_KEY> <WS_SHARED_SECRET>` (argument order changed, secret is now positional arg 2) or the Terraform equivalent with `-var="ws_shared_secret=..."`.
3. Set the **same** value as `EXPO_PUBLIC_WS_SHARED_SECRET` in `mobile/.env`, plus `EXPO_PUBLIC_BACKEND_URL` (now required — the code no longer falls back to a hardcoded URL).
4. Decide how to handle known issue #12 (secret readable in public HTML) — accept the risk at current scale, or ask for a redesign (e.g. per-session token minted server-side instead of a static secret baked into the page).
5. A physical iPhone and an Apple Developer account, needed for the EAS development build step in Phase 5 above.
6. Optional/low-priority: `mobile/.env.example` has what look like real Google OAuth client IDs rather than placeholders — not a secret (OAuth client IDs are meant to be public), just unusual for an example file. Your call whether to genericize it.

## Onboarding order for a fresh session

Read `README.md` → `ARCHITECTURE.md` → `backend/server.js` → `backend/agents.js` → `mobile/app/(main)/home.tsx`. Run the backend and validate the web PWA (`frontend/index.html`) end-to-end before touching the Expo app — it's the most complete surface and the fastest way to confirm the Gemini Live pipeline still works.

# CLAUDE.md

Guidance for Claude Code working in this repository.

Use `Argus/` (capital A). A lowercase `argus/` Python/FastAPI prototype on some machines (referenced by `start.sh`) is not in the repo and not current.

## What this is

Real-time multimodal AI companion on the Gemini Live API (vision + voice). One WebSocket connection = one persistent Gemini Live session, with camera frames, mic audio and tool calls flowing bidirectionally.

## Repo layout

```
Argus/
├── backend/                 # Node/Express/WebSocket relay to Gemini Live — the core service
│   ├── server.js              # Entry point, port 8080, path /ws
│   ├── agents.js              # Tool declarations + handlers + system prompt
│   ├── memory.js              # Firestore persistence
│   ├── weather.js             # Open-Meteo forecast + city geocoding
│   └── scripts/               # Real-session probes (see "Probes")
├── frontend/index.html      # Vanilla JS PWA — reference client, fastest end-to-end check
├── frontend/privacy.html    # Served at GET /privacy — required for App Store Connect
├── frontend/audio-diag.html # Sample-rate diagnostic (#42)
├── frontend/reference-audio.wav  # Known-clean capture — UNGAINED (#43)
├── mobile/                  # Expo/React Native app — the surface that gets real traffic
├── terraform/main.tf        # IaC alternative for Cloud Run + Firestore
├── Dockerfile, deploy-cloudrun.sh, ARCHITECTURE.md, README.md
```

## Commands

No lint anywhere; mobile has no tests; no CI beyond the Claude Code workflows.

**Backend**
```bash
cd backend && npm install
cp .env.example .env   # GEMINI_API_KEY, GCP_PROJECT_ID at minimum (no .env exists on this machine — recreate if needed)
npm start | npm run dev
npm test               # node --test "test/**/*.test.js"  (quoted glob; directory form fails on Windows)
cloudflared tunnel --url http://localhost:8080   # HTTPS, required for phone camera/mic
```
Local dev needs `backend/service-account.json` (gitignored). `npm test` checks `/api/health` and the WS auth gate only — it never makes a real Gemini round trip, so it cannot catch Live-API bugs.

**Mobile**
```bash
cd mobile && npm install   # postinstall runs patch-package (expo-av patch)
npm start | npm run android | npm run ios
npx eas build --profile production --platform ios && npx eas submit --platform ios
```
EAS cloud builds cannot see a local env file: `EXPO_PUBLIC_BACKEND_URL` and `EXPO_PUBLIC_WS_SHARED_SECRET` must be in EAS's env store (`eas env:create/update`), never in `eas.json`. An unset secret silently 4001s every connection. Expo Go works for dev, but custom permission strings only appear in real EAS builds. An App Store Connect API key already lives on EAS servers (`CF495F8WZV`), so `eas submit` does not prompt.

**Deploy** (project `agus-488919`, region `us-central1`, service `argus`, `https://argus-798059802495.us-central1.run.app`)
```bash
./deploy-cloudrun.sh GEMINI_API_KEY WS_SHARED_SECRET [LAT LON TIMEZONE MAX_GLOBAL_CONCURRENT_SESSIONS]
gcloud run deploy argus --source C:\Users\Custom\dev\Argus --clear-base-image   # incremental; keeps env vars
curl -s <url>/ | grep -c WS_SECRET   # smoke-test EVERY deploy: must be 200 and non-zero
```
- Shape: `--memory 2Gi --cpu 2 --min-instances 1 --max-instances 20 --concurrency 25 --timeout 3600`, session affinity required. CPU is the binding constraint, not memory (#36); `timeout 3600` stops WebSockets dying at 5 min. Terraform mirrors this.
- `GEMINI_API_KEY` and `WS_SHARED_SECRET` are required; the server exits without them.
- **Always pass the absolute repo root as `--source`.** From `backend/` a buildpack build succeeds, passes `/api/health`, and ships a container with no `frontend/` (`GET /` 500s; tell = `file:///workspace/server.js` in stack traces), and leaves the service needing `--clear-base-image` (#51). From `mobile/` it fails loudly on `patch-package: not found` (#28).
- Env updates with several vars: use `--update-env-vars "^;^A=x;B=y"` — the comma form mangled values on this machine.
- Rollie commits mid-session; check `git log`/`git status` right before deploying.

## Architecture

- **Stateful relay, not a REST API.** `server.js` opens one Gemini Live session per `/ws` connection and pipes JPEG frames and `audio/pcm;rate=16000` in, audio/transcripts/tool calls out. Media is sent as `sendRealtimeInput({audio})` / `({video})` — the legacy `media` field kills 3.1 sessions with `1007` (#54).
- **Model** from `LIVE_MODEL`; live is `gemini-3.1-flash-live-preview` (revert: `LIVE_MODEL=gemini-2.5-flash-native-audio-preview-12-2025`, ~30s). Env kill-switches, omitted from config when unset: `GOOGLE_SEARCH_GROUNDING=0`, `VAD_SILENCE_MS`, `TURN_COVERAGE`, `THINKING_LEVEL` (3.1) / `THINKING_BUDGET` (2.5 only). The `🔗 Connected` line prints the active model and knobs. Session config includes `contextWindowCompression: {slidingWindow: {}}` (without it audio+video sessions die silently at 2 min, #31), `outputAudioTranscription` (captions, #25), `inputAudioTranscription`, and `tools: [{googleSearch: {}}, ...TOOLS]` (#52).
- **Tools** are in-process in `agents.js`: `identify_scene`, `read_text`, `get_recipe_suggestion`, `cooking_timer`, `compare_products`, `diagnose_problem`, `manage_shopping_list`, `remember_preference`, `forget_memory`, `recall_memory`, `get_weather`, `log_daily_activity`, `get_daily_summary`, `web_search`, `read_webpage`, `find_places_nearby`, `research_topic`, `research_place`, `update_profile`, `mark_profile_reviewed`. `find_places_nearby` and `get_weather` use `resolveUserCoords` (homeLocation within 50 miles, else IP geo).
- **Web fetching has exactly ONE fetch function** — `fetchWebpage` → `assertPublicUrl` + `safeLookup` (validates at socket connect, handles IP literals, IPv4-mapped IPv6, manual redirects max 3, overall body deadline). Never add a second fetcher (#46, #48). Fetched text is labelled as untrusted information, not instructions. Per-user web cache 10 min / 200 entries.
- **Memory** (Firestore, keyed by userId), two tiers:
  - Global, always injected: `name`, `homeLocation {city, lat, lon, updatedAt}`, `people [{name, relation}]` (max 15), `personality {tone, verbosity, proactivity}`, `dietaryPreferences`, `allergies` (≤25 each), `lastProfileReviewAt`. Flat top-level fields, never a nested `profile` map.
  - Local, on demand: `preferences` map, `daily/` (trimmed to 50), `lists/shopping`, `observations/`. `buildMemoryContext` clamps to 600 chars. `collectPreferences` merges legacy dotted keys on read (#16/#37).
  - `computeProfileStatus`: no name → setup form (`profile-setup.tsx`); name but no/old `lastProfileReviewAt` (30 days) → spoken recheck. Only `mark_profile_reviewed` writes the timestamp.
- **Auth.** First WS message `{type:"user_id", build}` must carry `WS_SHARED_SECRET` (timing-safe) or close `4001` before any Gemini work. Web gets the secret injected into HTML; mobile has it baked in. **The gate is weak — see #12/#34.** Beyond it, `userId` is self-asserted. `POST /api/user/:id/claim` mints a one-time device secret only if the doc does not exist (**never loosen — account takeover, #24**); `DELETE /api/user/:id` and `GET/POST /api/user/:id/profile` require `Authorization: Bearer <secret>`. Mobile stores it in Keychain under per-uid key `argus_secret_${id}`.
- **Limits:** `/api/*` 300/min/IP, `WS_MAX_CONN_PER_IP` 50, per-connection message rate/type/size checks, fleet-wide `MAX_GLOBAL_CONCURRENT_SESSIONS` 400 via a 10-shard Firestore counter (fails open, close `4029`). `sessionsByUser` supersedes a user's prior session (`4002`). Per-IP limits are per-instance only.
- **Greet:** the client sends `greet` on a 1200ms timer; the server latches it *above* `waitForAuth` and replays when the session is live (#49). Greet turn text is `GREET_TURN` (one sentence, ≤15 words, no tools).
- **Mic gate is server-side** (#60): the client sends every chunk tagged `gated`; `MIC_GATE_MODE` (`drop`|`time`|`energy`|`hybrid`|`open`, currently `drop`), `MIC_GATE_OPEN_AFTER_MS` (1500), `MIC_GATE_RMS_MIN`, backstopped by `MAX_SUPPRESS_MS`. `SPEECH_RMS_MIN` (800, env) drives only the `heard` ack and latency v2 logging.
- **`client_log`**: `{type:"client_log", event, detail}` → `📱 Client [event] detail`. Sanitised (strips `=`/`|`), clamped to 300 chars, diagnostics only — never audio/image/transcript content. `audio_state` events (build 58+) report real `AVAudioSession` state; key legend is beside `reportAudioState` in `home.tsx`. `audio_render` events (build 59+) report what the players actually rendered (`rf`/`rl` frames, `b`/`ems` bursts), expo-av session deactivations (`da`/`pa`), recorder timing and a per-player AVPlayer snapshot (`pl`), at `start`/`play`/`turn`/`drained`; legend beside `reportRender`. `DIAG_MIC_PAUSE_DURING_PLAYBACK=1` (server env, off, never deployed) tells build 59+ to stop recording during playback — a diagnostic lever, no longer needed for #64.
- **Geo/weather:** `ip-api.com` (plaintext HTTP — output sanitised by `sanitizeLocationField` + lat/lon range checks before reaching prompt or URL; accepted residual risk), cached per IP. Open-Meteo with 3s timeout, 30-min cache by rounded lat/lon, last-good fallback up to 6h, `geocodeCity` for homeLocation.
- **Mobile** (`services/websocket.ts` `ArgusSocket`, `app/(main)/home.tsx`): 1s mic chunks (`CHUNK_MS`), frames every 2s during a turn / 5s idle, PCM played as WAV-wrapped `Audio.Sound` bursts (max 12 chunks per burst, preloaded ahead, all instances tracked in `liveSoundsRef`). Gain lives only in `services/audioGain.ts` (1.5, linear below 80% FS), imported by playback and the A/B harness. `patches/expo-av+16.0.8.patch` adds `DefaultToSpeaker`, `.voiceChat` mode (reset to Default for other categories), `setPreferredSampleRate:48000`, speaker override applied on every pass (not over headsets/BT), real-session drift detection + interruption/route-change/media-reset resync (#63), `getAudioSessionDiagnostics`, a pass-through `MTAudioProcessingTap` render meter on every player item, reporting of load failures for items `AVQueuePlayer` already dequeued, and `argusAbandonStalledLoads` (#64). Burst loads time out at 3s (`LOAD_TIMEOUT_MS`); failed bursts requeue smaller and retry. Mute resets on every connect. The Audio A/B test screen is `__DEV__`-only.
- **Routing** after consent/profile exists in three places: `index.tsx`, `consent.tsx` **and `sign-in.tsx`** — easy to miss the third.
- **Privacy:** transcript text and grounding search queries are logged only under `LOG_TRANSCRIPT_TEXT=1` (the App Store disclosure says speech isn't stored). Never log port names (Bluetooth devices are named after owners).

## Working conventions

**Pre-ship verification** (proves it compiles, never that it works): backend `node --check <file>` + `npm test`; mobile `npx tsc --noEmit` + `npx expo export:embed --eager --platform ios --dev false` (reproduces EAS's bundle step). To prove a `__DEV__` gate stripped something, grep the production bundle.

**Verify, don't trust notes — including this file.** Its "shipped in build N"/"deployed" claims have been wrong repeatedly.
- **Deployed code:** prove behaviour black-box (e.g. `403` from `/api/user/<id>/profile` with no auth), or hash the live Artifact Registry layer against HEAD. `/api/health` returns static config and passes with a dead Gemini key; only `{type:"connected"}` from a real WS session proves the key.
- **Phone build:** `npx eas build:list --platform ios --json`, diff `gitCommitHash` against the fix commit. Server log `👤 User: <id> — client build X` shows which binary a session ran (`unreported` = pre-build-55 or Expo Go).
- **Live uid:** read it from `User:`/`claim` log lines before calling a memory feature broken. Reinstall wipes `AsyncStorage` (`argus_uid` regenerates); Keychain survives.
- **Model/config changes** must be validated with `greet-race.mjs` (which streams real audio + a JPEG after the greet) — a probe without media missed the 3.1 `1007` that killed every phone session (#54).
- **Probes that pass for the wrong reason are failures.** Check *why* each case failed (`ECONNREFUSED` ≠ blocked, #48); make matchers agree with transcripts, not the reverse (#59); report rates, not n=1. Never embed hand-typed base64 as a payload.
- **An A/B that exonerates everything means the real variable isn't in the test** (#43).
- **Check the tool-call histogram in logs before rewording a prompt** (#47). Tool payload size drives verbosity more than prompt rules do (#50).
- **A rule that suppresses an admission of ignorance must state, in the same breath, that inventing an answer outranks it** — otherwise the model hallucinates (#59).
- **Silently ignored messages are invisible twice.** Handle or log the not-ready case for every client message type. `ws` discards messages arriving with no `message` listener, so any `await` between detaching one listener and attaching the next is a hole.
- **When every JS-side probe is silent during a JS-visible symptom, move down a layer** (#63). When instrumenting a "nothing happened" bug, instrument what a successful-looking failure would emit, not just error paths (#62).
- **Mojeek throttles this dev machine's IP** (200 with ~5.5KB and no `<li class="rN">`). Don't "fix" the parser; test against captured markup. Overpass also blocks a hammering dev IP.
- **Firestore:** `set(..., {merge:true})` does not split dotted keys (unlike `update()`); `FieldValue.delete()` keys pass raw.
- **Editing `mobile/patches/expo-av+16.0.8.patch`:** hunk counts must be recomputed. Verify with `rm -rf node_modules/expo-av && npm install` + grep each change, and ideally apply against a pristine npm tarball. Objective-C can't compile on Windows — the EAS build is the compile check.
- **Local Expo modules:** podspec must be in the module's `ios/` subdir; verify with `npx expo-modules-autolinking resolve --platform apple --json`.

**Logs** (PowerShell, not Bash; may need `gcloud auth login`):
```
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=argus" --project agus-488919 --limit=400 --format="value(timestamp,textPayload)" --order=desc
```
Use `--order=desc` — `asc` with `--limit` returns the oldest entries; `--freshness` did not constrain it. To segment sessions: split on `Client connected`, end at the first `Client disconnected`, read the model off each `Connected to Gemini Live API` line.

**⚠️ gcloud secret leaks:** `gcloud run services describe` prints `GEMINI_API_KEY` in plaintext. `gcloud services api-keys create` prints the new key (and `*> $null` doesn't reliably suppress it in PS 5.1); `api-keys delete` echoes the full `keyString`.

| Log line | Meaning |
|---|---|
| `🎤 Audio chunks: N` (± `— mic RMS`) | At `N % 100 === 1`; absence = zero mic chunks. Match both formats. Mic level sampled every 25th chunk (room floor ~645–700). |
| `🎯 Response latency v2` | The trustworthy latency metric (last loud chunk → response). v1 is broken on 3.1; `⏱️ Turn latency` is saturated at ~1s; `🗣️ ...quiet since` includes speaking time. |
| `🔇 Turn complete — N audio chunks over Nms` | Turn duration. |
| `🎙️ User speech detected` | From input transcription. Many of these ⇒ mic is not dead. |
| `⚡ Gemini interrupted its own response` | Barge-in. Rate = these ÷ turn-completes. |
| `🔕 Mic gate (<mode>): held N, passed M` | Per-turn gate result. |
| `🔊 Mic RMS during response — playing: … \| pre-playback: …` | Echo sample; also a rough **silent-turn detector**: silent turns p50 ≈ 857–879, audible usually ≥ 885 (build 60 had a verified-audible turn at 884). Read p50, not min. Build 59+'s `audio_render` `rl` is the authoritative answer. |
| `🎤⚠️ Mic gap` | Client stopped sending unexpectedly (only meaningful for clients that send while gated). |
| `👋 Greet arrived before the Gemini session was ready — replaying it` | #49 latch working. |
| `🔎` | Search grounding fired. |
| `♻️ Superseding prior session` | Duplicate session closed. |
| `⏱️ Tool <name>` / `⏱️ reserveGlobalSlot` / `📝 System instruction built` | Firestore timings. |
| `Location:` | Absent = geo cache hit. |
| `📱 Client [event]` | Client telemetry: `burst_load_failed`, `burst_load_abandoned`, `burst_silent`, `burst_watchdog`, `audio_session_recovered`, `audio_state`, `audio_render`. `burst_load_failed chunks1 ms0 … -11800 (-12842)` is the #64 trigger (a near-empty audio chunk) — recovered from on build 60+, fatal to the session on 54–59. |

**App Store:**
1. Uploading to TestFlight does not select a build for review — do that on the **App Store** tab (Apple once reviewed a months-old build, #23).
2. **Before every build, check the version train:** if Apple approved the version in `app.json`, bump it. `autoIncrement` only bumps the build number, and the marketing version is baked in, so a closed train always costs a full rebuild. Happened four times (#29, #38, #56, #58). It presents either as "You've already submitted this version" or as a **silent** `eas submit` failure (`ERRORED`, `error: null`, no logs — real reason only in Apple's email). On any unexplained submit failure, check the train first; resubmitting a previously-accepted build that fails identically confirms account/version state. Currently `1.0.5`: build 60 submitted for review 2026-09-27. Once Apple approves it, the 1.0.5 train is closed — bump before the next build.

**Probes** (`backend/scripts/`, all scrape the WS secret from `GET /` with a double-quote-only regex because the placeholder secret contains an apostrophe):
`audio-probe.mjs` (captures Gemini PCM, band energy/centroid raw and gained), `greet-race.mjs` (greet at a chosen delay + media; fails if session dies), `latency-probe.mjs` (real speech in, last-chunk→first-audio), `vision-nag-probe.mjs` (dark frames + questions; nag/hallucination rate; fixtures via `fixtures/make-fixtures.ps1`), `mic-gate-probe.mjs` (gate obeys env; VAD sweep needs `MIC_GATE_MODE=open` briefly — its "didn't abort" is meaningless in `drop`). Recreate `scratchpad/ssrf.mjs`-style blocklist tests when touching the fetcher.

## Do not re-try

- **`realtimeInputConfig.automaticActivityDetection` on 2.5** — fatal `1007` mid-conversation at both 1500ms and 500ms. Accepted on 3.1 but measured as no latency win (#55).
- **Explicit `contextWindowCompression` trigger/target tokens** — same risk class; default 80% is deliberate.
- **`thinkingBudget = 0`** — measured slower (≈1986 vs 1733ms) plus a non-response. On 3.1 the default `thinkingLevel` is already `minimal`.
- **Buffering gated mic chunks and flushing at turn end** — the buffer contains Argus's own echoed voice.
- **`CHUNK_MS` below 1000** — 400ms was worse (native recorder overhead).
- **A native `AVAudioEngine` rewrite** — 6 build cycles, no audible output (#39).
- **Loosening `claimUserSecret`'s refuse-if-doc-exists guard** (#24).
- **Half-duplex as a muffling fix, or more playback gain** — muffling was the gain itself (#43); sample-rate clamping was measured and ruled out (#42).
- **Reading "cuts me off" as barge-in on 3.1 without pulling the rate** — 3.1 is 0.05/turn vs 0.41 before; the cause was turn length vs the mic gate (#59).
- **Prompt rewording before checking the tool histogram** (#47).
- **Search scrapers/fallbacks:** DuckDuckGo `html/`/`lite/` (anomaly page / ads), searx.be, searxng.site, priv.au, ecosia, startpage, Marginalia — all probed 2026-08-27, none usable. Search is Gemini grounding (#52).
- **Re-suspecting for silent audio (#64):** the AVAudioSession/route, unended interruptions (`ib:1 ie:0`), expo-av's session deactivations (`da`), barge-in, leaked players. All measured and cleared; the cause was a hung player load.
- **Re-suspecting for the dead-mic class:** the audio loop not starting at 1500ms, expo-av's `_recorderExists` latch, `setAudioModeAsync` contention — all ruled out in #57.

## Open issues

Numbers are stable and cross-referenced (in memory notes and commits) — never renumber. Resolved entries are condensed under "Resolved — durable facts" below.

- **#5 Model retirement risk.** Both arms are preview models; re-verify names against Gemini docs periodically.
- **#12 / #34 WS secret is effectively public.** It is injected into HTML for any visitor (accepted while the web page is unpromoted), and the deployed value is the literal placeholder `<same value as backend's WS_SHARED_SECRET>`. Real bounds on spend: the 400-session global cap and a $500/month budget *alert* (not a cap). Rotation breaks every installed build, so it must ship with one — see action item 1. Redesign if the web page is ever promoted: per-session token from an authenticated endpoint.
- **#44/#59/#60 Mic gate discards user speech.** In `drop` mode the user's speech during Argus's reply is thrown away (3.1 mic gap p50 11.6s, p90 23.9s) — reported as "it cut me off". Server-side gate is ready; choose a mode from the echo floor (action item 3). Re-measure barge-ins/turn after; revert to `drop` if > ~0.2.
- **#59 residuals.** 3.1 turns run long (p50 5.9s after the prompt fix, p90 still ~14s). Three sessions connected, got greeted, then sent neither frames nor mic and ended `1008 The operation was aborted` — undiagnosed (backgrounding vs client loop failure; server can't tell).
- **#57 residuals, unfixed:** a mid-session socket blip exits `startAudioLoop` permanently with no error (it returns normally, so `.catch` never fires). `stopAudio()` calls `stopAndUnloadAsync()` un-awaited inside a try/catch → unhandled rejection on every disconnect.
- **#64 residuals** (root cause fixed in build 60, see Resolved). Builds 54–59 still go silent for the rest of a session whenever a reply starts with a near-empty audio chunk, and 60 still takes one failed load per occurrence (4 in 14 replies on 2026-09-27). Server-side filter for near-empty chunks in progress: it protects every installed build without a release. Unconfirmed whether the tiny chunks come from Gemini or from the relay.
  - A fresh-install user got a greet turn with 0 audio chunks (2026-09-21T17:38:32Z). Undiagnosed, not #64.
  - Build 58: 3 of 5 in-app reconnects started with `snd:1` (the hung player surviving teardown) and ended within 1–3s, followed by a fresh launch. Crash vs force-quit never confirmed.
- **#4 residual:** mobile frames are JPEG q0.5 but never resized (larger than web's 640×480). Flag if bandwidth matters.
- **#24 residual:** a legacy doc with data but no `deviceSecret` has no safe self-heal; deliberately unfixed.
- **#36:** Gemini's real concurrent-Live ceiling for this tier is unpublished; infra is sized for 200, not proven. No real (non-mocked) Gemini load test has been done.
- **#52:** `web_search`/`research_topic` still scrape Mojeek (403s from production). Remove once grounding (`🔎`) is confirmed firing in real conversations.
- **Weather (#64 note):** production Open-Meteo fetches failed for weeks with an error body (likely per-egress-IP rate limit, unconfirmed); now logged as `Open-Meteo HTTP <status>`. Pick a fallback provider only if it recurs.
- No WS keepalive and `staysActiveInBackground: false` — backgrounding or NAT idle can drop a session.
- `mobile/` has no crash reporting (action item 4).

## Resolved — durable facts

Only the fact or trap each fix left behind. Full history is in git.

1–3. Per-connection `userId` (never module globals — also applies to `agents.js` timers); `waitForUserId` before building the instruction; weather cache keyed by location.
7, 13, 14. Expo SDK 54 migration: native modules pinned to `bundledNativeModules.json`; `overrides: {"react-dom": "19.1.0"}` because EAS's `npm ci` rejects what `npm install` tolerates (verify with a real `npm ci` after wiping `node_modules`); `babel-preset-expo` must be a direct devDependency.
8. Unused `@google/adk` removed; 6 moderate transitive Firestore audit findings remain, not worth a breaking major. Watch for UTF-16LE appends to `.gitignore` from PowerShell.
9–11. WS auth/limits added; stale `deploy/` removed; SMS permissions removed from `app.json`.
15. expo-router needs `app/index.tsx`; do redirects declaratively, not in a `useEffect`.
16, 37. Dotted-key preference writes (see Firestore convention); prompt size never grew with usage. In-session degradation is context window growth from video (258 tok/s vs 25 audio; compression fires ~11 min) — it resets on reconnect, memory bloat would not.
17. `autoIncrement: true`, real backend URL in EAS env, `ascAppId: 6761696821`.
18. Each `Audio.Sound` load costs ~100–300ms; hence bursts and preloading.
20–22. UI polish (idle badges, error toasts, `TOOL_LABELS`, captions via React Context, default off). Keep `TOOL_LABELS` in sync with new tools — unknown ones render raw `snake_case`.
21, 38, 41, 42. iOS audio: expo-av never requests `DefaultToSpeaker` or sets a mode; earpiece routing was the real "too quiet" cause; `overrideOutputAudioPort` must re-apply on every pass; `.voiceChat` gives AEC.
23, 26. App Review: purpose strings must state purpose with a concrete example; AI data sharing needs an in-app consent screen naming Gemini (`consent.tsx`, key `argus_ai_data_consent`) — a privacy-policy link alone doesn't satisfy 5.1.1/5.1.2. `ITSAppUsesNonExemptEncryption: false` is set.
24. Keychain survives reinstall, `AsyncStorage` doesn't → scope Keychain keys per uid. DELETE response is the source of truth; cleanup has its own try/catch.
25. AUDIO-only sessions never populate `msg.text`; transcripts come from `serverContent.outputTranscription`.
27. `onclose`/`onerror` must log real codes/reasons. Gemini `onerror` closes the client socket (otherwise zombie connections hold slots).
30. `shutterSound: false` on `takePictureAsync` (hardware-locked in Japan/Korea).
31. Audio+video Live sessions are capped at 2 min without context compression.
32, 36. Capacity/cost: Tier 1 paid; ~$0.10/min/connection worst case; sharded global counter; budget alert on account `01B234-07EDB3-224CBF`. CGNAT makes low per-IP caps reject real users.
33. Silent dead-mic class, cause 1: unobserved promise rejection in the audio loop. Stale sockets: detach handlers, epoch-stamp messages. Never touch the SDK's `.text`/`.data` getters on audio messages (log floods, #33/#40) — use `extractAudioData`.
35. Mic chunk count proves the loop runs, not that it captures sound — hence mic RMS logging.
40. Profile/personality/home-location work; `settings.tsx` saves without `markReviewed`. Connection-open costs ~1s once per session (`reserveGlobalSlot` ~160ms is the largest uncached piece), not per turn.
43. Muffling was `tanh(x × 5.0)` gain (crest 6.49 → 2.35); raw Gemini audio peaks at 85% FS. Now 1.5.
44. Self-interruption was structural (perfect 1:1:1 turns/speech/barge-ins): mic streamed during Argus's replies with `START_OF_ACTIVITY_INTERRUPTS`. Gating took barge-in to ~0.
45. Overpass: every clause in a union needs its own `(around:...)`, else planet-wide query → timeout. Category allowlist; ~10-mile default radius; mirrors hedged at 2.5s intervals.
46, 48. SSRF: see Architecture's single-fetcher rule. Metadata needs `Metadata-Flavor: Google`, but other link-local/private targets were reachable before the fix.
47, 50. `research_topic` (search + 3 parallel reads) and `research_place` (site + menu link). Payloads capped (menu 1500, homepage 1500 or 400 once a menu is found). Source classification labels, not ranking.
49. "40-second delay" was a dropped greet; nothing was slow.
53. Build 38 → 48 was almost entirely audio fixes; backend changes reach every installed build without a release.
54, 55. 3.1 is ~2.6x faster end-to-end (latency-probe median 2014ms vs 5273ms on 2.5). `heard` ack lands ~50–100ms after speech onset. `VAD_SILENCE_MS` and `TURN_COVERAGE` measured as no latency win (`TURN_COVERAGE=TURN_INCLUDES_ONLY_ACTIVITY` remains a context-growth lever for long sessions). SDK 56+ `expo-audio` `useAudioStream` could remove mic buffering latency, but has no speaker/AEC controls — would need a new native patch.
57. Silent dead-mic, cause 3: mute state persisted across reconnects with its switch unmounted. Technique: frame cadence (2s vs 5s) remotely reveals the client's `mutedRef`.
59. `SPEECH_RMS_MIN` calibrated from production (room 645–698, speech windows ≥867, p50 960), not from `reference-audio.wav`.
61. Playback registered-sound fix (`liveSoundsRef`); a concurrent-burst race was orphaning players. Hardening, not the silent-audio cause.
62. Bursts capped at 12 chunks; failed bursts requeue at half size; `recoverAudioSession()` toggles `allowsRecordingIOS` because expo-av no-ops `setAudioModeAsync` with an unchanged mode. Recovery runs only after the token check (barge-ins legitimately stop near position 0).
63. expo-av's `EXAudioSessionManager` trusted cached state over the real session (5 defects: early returns, no interruption flag reset, no-op media reset, gated override). Patched with drift detection; every step is a no-op when already correct to avoid route-change loops. Did not fix #64.
64. Silent audio ("Speaking" + captions, no sound, rest of session). **Cause:** a reply's first burst is its first chunk alone; when that chunk is near-empty (`chunks1 ms0`) the WAV is unplayable and every `AVPlayerItem` fails `-11800/-12842`. `AVQueuePlayer` dequeues the failed item before expo-av's KVO block runs, and that block only handled the *current* item, so the failure was dropped and `createAsync` never settled. `playNextInQueue` awaits it holding `isPlayingRef`, so every later burst queued behind it. That is why the greet was hit hardest (15/31 silent greets on 54–58), why silence covered whole turns across several players, why no telemetry fired, and why reconnect (which resets the flag) was a coin flip. #62's occasional `-11800/-12842` was the same failure caught on the rare path expo-av did report. **Fixed in build 60:** the patch reports failures of dequeued items; loads time out at 3s and are abandoned natively; failed bursts retry. Verified 2026-09-27: 14/14 replies audible, 4 failures all recovered from. **How it was found:** classifying turns by the `🔊 playing:` p50, then build 59's `audio_render` (`b:0 rf:0 ti:0`, `pl:` player alive with no current item). The session, route, interruption and `da` theories were measured and cleared on the way.

## Action items (Rollie only)

1. **Rotate `WS_SHARED_SECRET`** (#34), sequenced with a shippable build — every installed build stops connecting when it changes. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, set on Cloud Run and `eas env:update production --variable-name EXPO_PUBLIC_WS_SHARED_SECRET`, then build. Then simplify the probes' secret regex.
2. **Build 60 (1.0.5) is in App Store review** (submitted 2026-09-27) — the first build without #64. Never submit 54–59. After approval, bump `app.json` before the next build.
3. **Pick the mic gate mode** (#60) from real sessions **where audio was audible** (silent turns pollute the echo sample — check `🔊 playing:` p50). Talk over Argus deliberately, compare `playing` p50/p90 to the 867 speech floor: echo well below → `energy`/`hybrid` with `MIC_GATE_RMS_MIN` between; overlapping → `time`. Set via `--update-env-vars "^;^MIC_GATE_MODE=hybrid;MIC_GATE_OPEN_AFTER_MS=1500;MIC_GATE_RMS_MIN=<n>"`. Revert with `MIC_GATE_MODE=drop` if barge-ins/turn exceed ~0.2.
4. **Add crash reporting to `mobile/`** (Sentry/Crashlytics). Every client-side crash report so far was diagnosed by inference from backend logs.
5. Optional: `mobile/.env.example` contains what look like real Google OAuth client IDs (public by design, just unusual in an example file).

## Onboarding order

`README.md` → `ARCHITECTURE.md` → `backend/server.js` → `backend/agents.js` → `mobile/app/(main)/home.tsx`. Validate the web PWA end-to-end before touching the Expo app.

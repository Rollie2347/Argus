/**
 * Argus — The All-Seeing Companion
 * Backend: Express + WebSocket relay to Gemini Live API with ADK-style agents
 */

import { GoogleGenAI, Modality } from "@google/genai";
import crypto from "crypto";
import dotenv from "dotenv";
import express from "express";
import { readFileSync } from "fs";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { buildSystemInstruction, TOOLS, handleToolCall } from "./agents.js";
import {
  deleteUserData,
  claimUserSecret,
  verifyDeviceSecret,
  reserveGlobalSlot,
  releaseGlobalSlot,
  getUserMemory,
  updateUserMemory,
  computeProfileStatus,
  setHomeLocation,
  setPeople,
  setPersonality,
  markProfileReviewed,
  DEFAULT_PERSONALITY,
} from "./memory.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WS_SHARED_SECRET = process.env.WS_SHARED_SECRET;
// Env-overridable so a model A/B is a ~30s env flip, not a rebuild:
//   gcloud run services update argus --region us-central1 \
//     --update-env-vars LIVE_MODEL=gemini-3.1-flash-live-preview
// and revert by setting it back (or --remove-env-vars LIVE_MODEL). Verify any
// flip with scripts/greet-race.mjs — a wrong/retired model name or an
// unsupported config field fails at session setup, which the probe catches.
// Candidate as of 2026-08-31: gemini-3.1-flash-live-preview (released
// 2026-03), which Google documents as improving latency over 2.5 native
// audio. Caveat for 3.1: thinkingConfig takes `thinkingLevel`, not
// `thinkingBudget` — do not set THINKING_BUDGET on that arm.
const MODEL = process.env.LIVE_MODEL || "gemini-2.5-flash-native-audio-preview-12-2025";
// Unset by default — matches existing behavior exactly (the model's own
// automatic thinking budget, whatever that is for this preview model).
// LiveConnectConfig.thinkingConfig.thinkingBudget accepts 0 (disabled), -1
// (automatic), or a token count; see the @google/genai SDK's genai.d.ts.
// Deliberately not defaulted to a reduced value — CLAUDE.md's Phase 5 design
// explicitly said not to cut thinking budget blindly, and the tradeoff can
// only be judged from real sessions (the turn-latency logging below), which
// requires a real deploy this env var can then be redeployed with different
// values for, without a code change each time.
const THINKING_BUDGET = process.env.THINKING_BUDGET !== undefined ? parseInt(process.env.THINKING_BUDGET, 10) : null;

// Google Search grounding, first-party, using the Gemini key already present.
//
// Replaces scraping a search engine, which was never going to hold: Mojeek
// soft-throttles some IPs (200 with an empty results page) and hard-blocks
// others (403), and Cloud Run's egress IP is not fixed, so search reliability
// was luck of the draw per instance. Every keyless alternative was probed on
// 2026-08-27 and none was usable — DuckDuckGo's lite endpoint returned nothing
// but a sponsored ad, searx.be has JSON disabled, ecosia 403s, Marginalia is a
// niche index.
//
// ⚠️ This is a change to the LIVE SESSION CONFIG, which is the exact class of
// change that killed sessions with a fatal 1007 twice (see the
// realtimeInputConfig comment further down). It is therefore a kill switch,
// not a constant: set GOOGLE_SEARCH_GROUNDING=0 to turn it off with
// `gcloud run services update argus --region us-central1
//  --update-env-vars GOOGLE_SEARCH_GROUNDING=0`, which takes ~30s instead of
// the ~5min a rebuild costs. Verify with scripts/greet-race.mjs, which opens a
// real session and fails loudly if setup breaks.
const GOOGLE_SEARCH_GROUNDING = process.env.GOOGLE_SEARCH_GROUNDING !== "0";

// 3.1-only session-config knobs, every one omitted from the config entirely
// unless its env var is set — the same kill-switch pattern as LIVE_MODEL and
// GOOGLE_SEARCH_GROUNDING, because session-config fields are the class of
// change that has fatally 1007'd twice on 2.5. Flip with
// `gcloud run services update argus --update-env-vars ...` (~30s) and validate
// with scripts/greet-race.mjs (media path) + scripts/latency-probe.mjs before
// trusting a combination.
//
// THINKING_LEVEL ("minimal"|"low"|"medium"|"high"): 3.1's replacement for
//   thinkingBudget. Docs say the DEFAULT is already "minimal" (lowest
//   latency), so this is not a speed lever — it exists for testing whether a
//   higher level improves answer quality enough to pay for.
// VAD_SILENCE_MS: automaticActivityDetection.silenceDurationMs. ⚠️ On 2.5 the
//   mere PRESENCE of automaticActivityDetection killed sessions with 1007
//   (#27/#41) — that finding was scoped to 2.5; 3.1's docs list the field as
//   supported. Never set this while LIVE_MODEL is unset/2.5.
// TURN_COVERAGE ("TURN_INCLUDES_ONLY_ACTIVITY"): 3.1 defaults to
//   TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO — every camera frame lands in
//   every turn's context, where 2.5's default excluded them. Frames dominate
//   token spend 10:1 (#37), so this both grows context faster and adds
//   per-turn prompt tokens.
const THINKING_LEVEL = process.env.THINKING_LEVEL || null;
const VAD_SILENCE_MS = process.env.VAD_SILENCE_MS !== undefined ? parseInt(process.env.VAD_SILENCE_MS, 10) : null;
const TURN_COVERAGE = process.env.TURN_COVERAGE || null;

// Validate required env vars at startup
if (!GEMINI_API_KEY) {
  console.error("FATAL: GEMINI_API_KEY is not set. Set it in your .env file or environment.");
  process.exit(1);
}
if (!WS_SHARED_SECRET) {
  console.error("FATAL: WS_SHARED_SECRET is not set. Set it in your .env file or environment — see backend/.env.example.");
  process.exit(1);
}

function getClientIp(req) {
  return ((req.headers["x-forwarded-for"] || req.socket.remoteAddress) + "").split(",")[0].trim();
}

// Per-IP request counter for HTTP routes. In-memory only — on Cloud Run this
// resets per instance and doesn't coordinate across concurrent instances, but
// with session-affinity scale-to-zero traffic at personal-testing volume that's
// an acceptable gap, not a real bypass surface.
function httpRateLimit(windowMs, max) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) if (now > entry.resetAt) hits.delete(ip);
  }, windowMs).unref();
  return (req, res, next) => {
    const ip = getClientIp(req);
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count++;
    if (entry.count > max) return res.status(429).json({ error: "Too many requests" });
    next();
  };
}

// Express app
const app = express();
const server = createServer(app);
app.use(express.json({ limit: "100kb" })); // profile POST body only — small, structured

// Per-IP HTTP limit. Same CGNAT reasoning as WS_MAX_CONN_PER_IP: every new
// install calls POST /api/user/:id/claim once, so a few hundred users sharing
// a carrier egress IP can legitimately produce a few hundred requests in a
// short window. 60/min would have turned that into failed claims — which is
// exactly the failure mode behind known issue #24 (a device stranded without
// a device secret because its one claim attempt failed).
app.use("/api", httpRateLimit(60_000, parseInt(process.env.HTTP_RATE_LIMIT_PER_MIN) || 300));

app.get("/api/health", (req, res) => {
  const tools = TOOLS[0].functionDeclarations.map(f => f.name);
  res.json({
    status: "ok", name: "Argus", version: "0.3", model: MODEL,
    agents: ["kitchen", "shopping", "fixit", "restaurant", "search", "memory", "context"],
    tools: tools, toolCount: tools.length,
    services: ["firestore", "weather", "web-search"],
    location: { lat: process.env.WEATHER_LAT || "41.88", lon: process.env.WEATHER_LON || "-87.63" },
    timezone: process.env.TIMEZONE || "America/Chicago",
  });
});

// Mints a one-time bearer secret for a fresh userId. Only succeeds the first
// time a given userId is claimed, so it can't be used to steal an existing
// user's credential — see claimUserSecret in memory.js.
app.post("/api/user/:userId/claim", async (req, res) => {
  try {
    const secret = await claimUserSecret(req.params.userId);
    if (!secret) return res.status(409).json({ error: "already claimed" });
    res.json({ secret });
  } catch (err) {
    console.error("Claim user secret error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/user/:userId", async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!(await verifyDeviceSecret(req.params.userId, token))) {
    return res.status(403).json({ error: "forbidden" });
  }
  try {
    await deleteUserData(req.params.userId);
    res.json({ status: "deleted" });
  } catch (err) {
    console.error("Delete user data error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Same Bearer device-secret auth as POST/DELETE. This returns name, home
// city, and family/friends' names+relations — real PII, and userIds appear
// in plaintext in Cloud Run request logs (known issue #32), so trusting the
// self-asserted userId alone here would let anyone who's seen a userId pull
// another user's profile. Used by mobile routing to decide whether the
// setup form should block home.tsx.
app.get("/api/user/:userId/profile", async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!(await verifyDeviceSecret(req.params.userId, token))) {
    return res.status(403).json({ error: "forbidden" });
  }
  try {
    const mem = await getUserMemory(req.params.userId);
    res.json({
      status: computeProfileStatus(mem),
      name: mem.name || null,
      homeLocation: mem.homeLocation || null,
      people: mem.people || [],
      personality: mem.personality || DEFAULT_PERSONALITY,
    });
  } catch (err) {
    console.error("Get profile error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Same Bearer device-secret auth as DELETE — this writes identity data, not
// just preferences, so it shouldn't trust the self-asserted userId alone.
// markReviewed is an explicit client-sent flag rather than being inferred
// from which fields are present: the setup form and a settings-only
// personality edit both POST here, but only the former should reset the
// 30-day recheck clock (see computeProfileStatus in memory.js).
app.post("/api/user/:userId/profile", async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!(await verifyDeviceSecret(req.params.userId, token))) {
    return res.status(403).json({ error: "forbidden" });
  }
  try {
    const userId = req.params.userId;
    const { name, homeCity, people, personality, markReviewed } = req.body || {};
    const tasks = [];
    if (typeof name === "string" && name.trim()) {
      tasks.push(updateUserMemory(userId, { name: name.trim().slice(0, 100) }));
    }
    if (typeof homeCity === "string" && homeCity.trim()) {
      tasks.push(setHomeLocation(userId, homeCity.trim()));
    }
    // One write for the whole list — see setPeople in memory.js for why this
    // isn't a loop of addPerson calls.
    if (Array.isArray(people)) tasks.push(setPeople(userId, people));
    if (personality && typeof personality === "object") {
      tasks.push(setPersonality(userId, personality));
    }
    await Promise.all(tasks);
    if (markReviewed) await markProfileReviewed(userId);
    res.json({ status: "ok" });
  } catch (err) {
    console.error("Update profile error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Serve frontend. index.html gets the WS shared secret injected server-side
// (from env, never committed) so the public demo page can open an authorized
// connection without the secret ever living in git history.
const frontendPath = path.join(__dirname, "..", "frontend");
function serveIndexWithSecret(req, res) {
  const html = readFileSync(path.join(frontendPath, "index.html"), "utf8")
    .replace("__WS_SHARED_SECRET__", WS_SHARED_SECRET);
  res.type("html").send(html);
}
app.get("/", serveIndexWithSecret);
app.get("/index.html", serveIndexWithSecret);
app.get("/privacy", (req, res) => {
  res.sendFile(path.join(frontendPath, "privacy.html"));
});
app.get("/terms", (req, res) => {
  res.sendFile(path.join(frontendPath, "terms.html"));
});
app.get("/about", (req, res) => {
  res.sendFile(path.join(frontendPath, "about.html"));
});
app.use(express.static(frontendPath, { index: false }));

// WebSocket server. maxPayload is a blunt outer guard against oversized frames
// arriving before per-message validation below ever runs.
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4 * 1024 * 1024 });

// Per-IP cap. This was 5, which is fine for one household but actively breaks
// at real user counts: mobile carriers put large numbers of subscribers behind
// a handful of CGNAT addresses, and campus/office WiFi does the same, so a
// low per-IP cap rejects legitimate users who simply share an egress IP. It is
// a blunt anti-abuse guard, not a spend cap — MAX_GLOBAL_CONCURRENT_SESSIONS
// below is what actually bounds cost, so this can be generous.
const WS_MAX_CONN_PER_IP = parseInt(process.env.WS_MAX_CONN_PER_IP) || 50;
// Fleet-wide budget so organic growth (or abuse) past this fails safe with a
// clear rejection instead of silently becoming an uncapped Gemini bill —
// connectionsByIp above only bounds a single IP, not total concurrent spend.
// Default raised 250 -> 400: the sharded counter is deliberately approximate
// (see reserveGlobalSlot), so a cap only 25% above a 200-user target would
// start rejecting real users before the target was actually reached.
const MAX_GLOBAL_CONCURRENT_SESSIONS = parseInt(process.env.MAX_GLOBAL_CONCURRENT_SESSIONS) || 400;
const WS_MSG_RATE_LIMIT = 30; // messages/sec/connection
const ALLOWED_WS_TYPES = new Set(["audio", "image", "user_id", "greet"]);
const MAX_AUDIO_B64_LEN = 200_000; // ~150KB raw — generous for a 1s 16kHz/16-bit mono chunk
const MAX_IMAGE_B64_LEN = 3_000_000; // ~2.2MB raw — generous for a quality:0.5 JPEG frame
const connectionsByIp = new Map();
// One live session per user. Nothing previously stopped a single userId from
// holding several concurrent Gemini sessions — a client that reconnected
// before its old socket finished closing left the old session alive and
// answering, so two sessions streamed audio back at once. This is the
// server-side backstop for that; the client also guards it (see the epoch
// check in mobile/app/(main)/home.tsx).
const sessionsByUser = new Map();

// Per-IP geolocation cache (mirrors weather.js's location cache). The
// ipapi.co lookup below was measured adding ~150-500ms to every single
// connection open, not just first load — cache it so reconnects from the
// same IP skip the round trip.
const geoCache = new Map();
const GEO_CACHE_DURATION = 30 * 60 * 1000;

// Strips anything that isn't a plausible place-name character before a
// geo-lookup response is allowed into the Gemini system prompt (userCity) —
// the lookup travels over plaintext HTTP (see fetch call below), so a
// MITM-forged response body must not be able to smuggle prompt-injection
// content (newlines, instruction-shaped text) into the prompt, only inert
// wrong-location text at worst.
function sanitizeLocationField(s) {
  return String(s || "")
    .replace(/[^\p{L}\p{N}\s,.'-]/gu, "")
    .slice(0, 100)
    .trim();
}

// Replicates @google/genai's LiveServerMessage.data getter (walks
// serverContent.modelTurn.parts, concatenates inlineData) without going
// through that getter directly. The SDK's own getter warns on ANY
// non-inlineData field present in a part — including `thought` fields,
// unlike its sibling .text getter, which explicitly excludes `thought` from
// its equivalent warning (verified in the SDK source, dist/node/index.cjs).
// This model streams thinking content in most responses by default, so
// every access to msg.data was logging "there are non-data parts
// [thought]..." and re-walking every part — the exact bug class known issue
// #33 already fixed for msg.text, just via the sibling getter this time.
/**
 * Loudness of one inbound mic chunk, for the logs.
 *
 * Incoming chunks are base64 PCM16LE at 16kHz. RMS separates the two failures
 * a chunk counter cannot: a live recording loop capturing real speech, and a
 * live recording loop capturing nothing. Silence sits in the single digits;
 * a room with someone talking in it lands in the hundreds or thousands.
 *
 * "silent" here means the audio is inaudible, which on its own does not say
 * whose fault that is — a muted input, a mic captured by another app, or the
 * wrong input route all look the same from here. It does rule out the whole
 * server and model side, which is the expensive half to chase.
 */
function describeMicLevel(b64) {
  try {
    const buf = Buffer.from(b64, "base64");
    const n = Math.floor(buf.length / 2);
    if (!n) return "level unknown (empty chunk)";
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const s = buf.readInt16LE(i * 2);
      sum += s * s;
      const a = Math.abs(s);
      if (a > peak) peak = a;
    }
    const rms = Math.round(Math.sqrt(sum / n));
    // 32767 is full scale; ~30 RMS is below anything a mic in a real room
    // produces, so it means the capture is not picking up sound at all.
    const verdict = rms < 30 ? "SILENT — capturing no sound" : "live";
    return `RMS ${rms} peak ${peak} (${verdict})`;
  } catch {
    return "level unknown (undecodable chunk)";
  }
}

// Sampled RMS of one inbound mic chunk, cheap enough for EVERY chunk.
//
// Exists because the 🎯 Response latency metric silently broke on
// gemini-3.1-flash-live-preview: 2.5 streamed inputTranscription WHILE the
// user spoke, so "last transcription chunk" approximated speech end — 3.1
// delivers the whole input transcript batched 2-3ms before the response
// starts, which made the metric read 2ms and mean nothing. Chunk loudness is
// model-independent: the client sends a chunk every second regardless, and
// the last LOUD one is the last one containing speech.
//
// Every 4th sample, so a 1s/16k chunk costs ~4k reads — noise-vs-speech needs
// no more (floor measured ~670-800 RMS, speech 4243+, see #49). The base64
// decode this adds per chunk is small next to the JSON.parse of the same
// ~43KB message that already happens on this path.
function quickRms(b64) {
  try {
    const buf = Buffer.from(b64, "base64");
    const n = Math.floor(buf.length / 2);
    if (!n) return 0;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n; i += 4) {
      const s = buf.readInt16LE(i * 2);
      sum += s * s;
      count++;
    }
    return Math.round(Math.sqrt(sum / count));
  } catch {
    return 0;
  }
}
// Between the measured room-noise floor (~670-800) and real speech.
//
// ⚠️ 1500 was WRONG and shipped broken: across 11 real turns on 2026-09-01 the
// v2 latency line never fired once, meaning no forwarded chunk ever cleared
// it — so the {type:"heard"} ack never fired either. It was validated against
// reference-audio.wav (Gemini's own output, peaking at 85% full scale), which
// is nothing like a phone mic capturing a person at conversational distance.
// Same error class as the #43 harness flaw: verified with input that wasn't
// representative of the real thing.
//
// 1100 sits ~1.4x above the measured floor. Biased deliberately toward
// FALSE POSITIVES: the only consequence of one is the badge reading "Heard
// you" a moment early, which reverts at turn complete, whereas a false
// negative silently kills the feature — which is exactly what just happened.
const SPEECH_RMS_MIN = 1100;

function extractAudioData(msg) {
  const parts = msg.serverContent && msg.serverContent.modelTurn && msg.serverContent.modelTurn.parts;
  if (!parts) return undefined;
  // Collect first so the overwhelmingly common single-part case can skip the
  // decode/re-encode entirely. The SDK unconditionally does atob() on every
  // part then btoa() on the concatenation; for one part that round trip is
  // pure waste on the hot audio path (a ~43KB base64 chunk per second per
  // session), and CPU — not memory — is the binding Cloud Run constraint
  // here (see CLAUDE.md known issue #36). Multi-part still concatenates raw
  // bytes before re-encoding, matching the SDK's semantics exactly.
  const encoded = [];
  for (const part of parts) {
    if (part.inlineData && typeof part.inlineData.data === "string") {
      encoded.push(part.inlineData.data);
    }
  }
  if (encoded.length === 0) return undefined;
  if (encoded.length === 1) return encoded[0];
  return btoa(encoded.map((e) => atob(e)).join(""));
}

function validSecret(secret) {
  if (typeof secret !== "string" || !secret) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(WS_SHARED_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Both known clients (frontend/index.html, mobile/services/websocket.ts) send
// {type:"user_id", id, name, secret} as their first message right after the
// socket opens. Reject immediately on a missing/wrong secret instead of
// falling back to a default identity — an unauthenticated connection should
// never reach the point of opening a billed Gemini session.
function waitForAuth(clientWs, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clientWs.off("message", onMessage);
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    function onMessage(raw) {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== "user_id" || !msg.id) return;
        if (!validSecret(msg.secret)) return finish(null);
        finish({ id: String(msg.id).slice(0, 200), name: msg.name ? String(msg.name).slice(0, 200) : "" });
      } catch (_) {}
    }
    clientWs.on("message", onMessage);
  });
}

wss.on("connection", async (clientWs, req) => {
  const ip = getClientIp(req);
  console.log("👁️ Client connected", ip);

  const currentConns = connectionsByIp.get(ip) || 0;
  if (currentConns >= WS_MAX_CONN_PER_IP) {
    console.warn("Rejected connection — too many from", ip);
    clientWs.close(4008, "too many connections");
    return;
  }
  connectionsByIp.set(ip, currentConns + 1);
  let releasedConn = false;
  const releaseConn = () => {
    if (releasedConn) return;
    releasedConn = true;
    const c = (connectionsByIp.get(ip) || 1) - 1;
    if (c <= 0) connectionsByIp.delete(ip); else connectionsByIp.set(ip, c);
  };
  clientWs.on("close", releaseConn);
  clientWs.on("error", releaseConn);

  let msgCount = 0;
  let msgWindowStart = Date.now();
  function withinMsgRate() {
    const now = Date.now();
    if (now - msgWindowStart > 1000) { msgWindowStart = now; msgCount = 0; }
    msgCount++;
    return msgCount <= WS_MSG_RATE_LIMIT;
  }

  // The client fires `greet` on a fixed 1200ms timer after the WebSocket opens
  // (mobile/services/websocket.ts:49) with no way to know whether the Gemini
  // session exists yet, and the main handler gates on `session` with no else
  // branch — so an early greet was discarded with nothing logged. Argus then
  // never spoke first, the user waited for a greeting that had already been
  // thrown away, and eventually spoke themselves: one real session logged ~25s
  // of silence followed by a completely normal 1515ms reply, which reads as
  // "it took 40 seconds to answer".
  //
  // This MUST sit above waitForAuth. That helper detaches its own listener the
  // moment auth succeeds, leaving no `message` listener at all across
  // reserveGlobalSlot (174-1418ms measured) and buildSystemInstruction
  // (85-665ms) — and `ws` drops messages with no listener rather than
  // buffering them. A first attempt latched below that gap and changed
  // nothing, which scripts/greet-race.mjs caught before it reached anyone.
  //
  // Fixed server-side deliberately: it repairs every build already installed
  // rather than waiting on a release.
  let greetPending = false;
  const earlyGreetListener = (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m && m.type === "greet") greetPending = true;
    } catch { /* malformed frames are the main handler's problem */ }
  };
  clientWs.on("message", earlyGreetListener);

  const auth = await waitForAuth(clientWs);
  if (!auth) {
    console.warn("Rejected unauthenticated WS connection from", ip);
    clientWs.close(4001, "unauthorized");
    return;
  }

  // Fleet-wide capacity check — must happen after auth (an unauthenticated
  // connection should never consume a slot) and before opening the billed
  // Gemini session below.
  // Sharded counter: 10 Firestore shard reads plus a transactional write, all
  // in the connection-open path. Measured rather than assumed, because it is
  // the single largest Firestore operation Argus performs.
  const slotStart = Date.now();
  const slot = await reserveGlobalSlot(MAX_GLOBAL_CONCURRENT_SESSIONS);
  console.log(`⏱️ reserveGlobalSlot: ${Date.now() - slotStart}ms`);
  if (!slot.allowed) {
    console.warn(`Rejected connection — at global capacity (${slot.count}/${MAX_GLOBAL_CONCURRENT_SESSIONS})`);
    clientWs.close(4029, "at capacity, try again shortly");
    return;
  }
  let releasedGlobalSlot = false;
  const releaseGlobal = () => {
    if (releasedGlobalSlot) return;
    releasedGlobalSlot = true;
    releaseGlobalSlot(slot.shard);
  };
  clientWs.on("close", releaseGlobal);
  clientWs.on("error", releaseGlobal);

  // Auto-detect user location via IP for personalised weather + context.
  // Runs only after auth succeeds, so a rejected connection never triggers it.
  let userLat = parseFloat(process.env.WEATHER_LAT) || 41.88;
  let userLon = parseFloat(process.env.WEATHER_LON) || -87.63;
  let userCity = process.env.WEATHER_CITY || "your area";
  if (ip && !ip.includes("127.0.0.1") && !ip.includes("::1")) {
    const cachedGeo = geoCache.get(ip);
    if (cachedGeo && Date.now() - cachedGeo.time < GEO_CACHE_DURATION) {
      ({ lat: userLat, lon: userLon, city: userCity } = cachedGeo.data);
    } else {
      try {
        // ipapi.co's free tier caps at 1,000 req/day — nowhere near enough
        // headroom at 200-concurrent-user scale (this fires once per
        // connection open per uncached IP). ip-api.com's free tier is
        // 45 req/min (~64,800/day) with no signup, but HTTP-only on the free
        // tier (no HTTPS) — ipwho.is/ipapi.co both offer HTTPS but share the
        // same ~1,000/day-per-caller ceiling that motivated moving off
        // ipapi.co in the first place, so they don't actually fix the
        // problem. Since a plaintext response here isn't tamper-proof in
        // transit, both fields below are strictly validated/sanitized
        // before they reach userLat/userLon/userCity — which flow into
        // weather.js's URL and the Gemini system prompt respectively — so a
        // MITM-forged response can't inject prompt content or malformed
        // URL params, only (at worst) a wrong-but-inert location string.
        const geo = await (await fetch(
          "http://ip-api.com/json/" + ip + "?fields=status,lat,lon,city,regionName",
          { signal: AbortSignal.timeout(3000) }
        )).json();
        const lat = Number(geo.lat), lon = Number(geo.lon);
        const validCoords = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
        if (geo.status === "success" && validCoords) {
          userLat = lat; userLon = lon;
          userCity = sanitizeLocationField([geo.city, geo.regionName].filter(Boolean).join(", ")) || "your area";
          console.log("📍 Location:", userCity);
          geoCache.set(ip, { data: { lat: userLat, lon: userLon, city: userCity }, time: Date.now() });
        }
      } catch (e) { console.warn("Geolocation failed:", e.message); }
    }
  }

  let userId = auth.id;
  console.log("👤 User:", userId);

  // Supersede any still-open session for this user before opening a new one.
  const sessionKey = auth.id;
  const priorWs = sessionsByUser.get(sessionKey);
  if (priorWs && priorWs !== clientWs) {
    console.log("♻️ Superseding prior session for", sessionKey);
    try { priorWs.close(4002, "superseded by a newer session"); } catch (_) {}
  }
  sessionsByUser.set(sessionKey, clientWs);
  clientWs.on("close", () => {
    if (sessionsByUser.get(sessionKey) === clientWs) sessionsByUser.delete(sessionKey);
  });

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  let session = null;
  let audioChunks = 0;
  let imageFrames = 0;
  let transcriptBuffer = "";
  // Turn-latency instrumentation (Bug 2 investigation): timestamp of the
  // last audio chunk forwarded to Gemini, and whether a response is
  // currently in flight — lets us log how long Gemini actually took to
  // start responding, separate from connection-open latency.
  let lastAudioForwardedAt = 0;
  let responseInFlight = false;
  // When the current response began, and how many mic chunks were dropped
  // because of it. See the suppression block in the client audio handler.
  let responseStartedAt = 0;
  let suppressedChunks = 0;
  // Wall-clock of the last mic chunk actually received from the client, used
  // to spot the mic going quiet mid-session.
  let lastAudioReceivedAt = 0;
  // Ceiling on how long mic audio may be suppressed for a single turn. Long
  // enough to cover any real response (the longest measured is ~12s), short
  // enough that a turn which never reports completion cannot leave the
  // microphone dead for the rest of the session.
  const MAX_SUPPRESS_MS = 20000;
  // Turn-shape instrumentation. The existing "turn latency" number is measured
  // from the last forwarded audio chunk, and the client sends a chunk every
  // ~1s whether or not anyone is speaking — so that metric is structurally
  // incapable of exceeding ~1s and cannot explain a long silent gap. These
  // track how long Argus actually spoke for and how long it stayed quiet
  // between turns, which is what distinguishes "rambled for 36s" from "said
  // nothing for 36s".
  let turnStartedAt = 0;
  let turnAudioChunks = 0;
  let lastTurnEndedAt = 0;
  let userSpeechOpen = false;
  // Response-latency instrumentation for the Phase 5 thinking-budget A/B
  // (see THINKING_BUDGET above). The existing "Turn latency" metric is
  // known-flawed (see known issue #35 in CLAUDE.md) — it measures from the
  // last forwarded 1s audio chunk, which the client sends every second
  // whether or not anyone is speaking, so it can never exceed ~1s and isn't
  // real response latency. This measures from the last actual user-speech
  // transcription chunk to the first sign of a response instead — still an
  // approximation (transcription lags real speech end slightly), but a much
  // closer proxy, and the only one available without client-side changes.
  let lastUserSpeechAt = 0;
  // Arrival time of the last mic chunk whose RMS cleared SPEECH_RMS_MIN —
  // the model-independent speech-end proxy backing "Response latency v2"
  // (see quickRms). Underestimates true speech-end→response by 0..~1s (the
  // chunk containing the end of speech arrives up to one CHUNK_MS after the
  // user stopped), which is constant-shaped across model arms, so A/B deltas
  // are honest even though absolute values read low.
  let lastLoudChunkAt = 0;
  // Loudest forwarded chunk since the last turn ended. Logged at turn
  // complete so SPEECH_RMS_MIN can be tuned against what this app's users
  // ACTUALLY produce, rather than against a reference file — the mistake that
  // shipped the threshold too high in the first place.
  let windowPeakRms = 0;
  // One {type:"heard"} per question: set when the first loud chunk of an
  // inter-turn window is forwarded, cleared at turn complete.
  let heardSent = false;
  try {
    // Build dynamic system instruction with live memory, weather + location context
    const sysStart = Date.now();
    const systemInstruction = await buildSystemInstruction(userLat, userLon, userCity, userId);
    console.log(`📝 System instruction built with live context — ${Date.now() - sysStart}ms, ${systemInstruction.length} chars`);

    session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        // Live API only emits `msg.text` for TEXT-modality responses. This
        // session is AUDIO-only, so without requesting a transcript here,
        // there is no text at all to caption — closed captions had nothing
        // to display regardless of the mobile-side toggle.
        outputAudioTranscription: {},
        // Diagnostic (added 2026-08-09 to chase a reported 36s mid-session
        // pause): without this there is no server-side signal for when the
        // USER spoke, so a silent gap is indistinguishable from Argus giving
        // a very long answer. Only the *timing* is logged by default; the
        // transcript text is logged only when LOG_TRANSCRIPT_TEXT=1, since
        // the App Store disclosure states Argus does not store speech and
        // Cloud Run logs are retained.
        inputAudioTranscription: {},
        // Without this, sessions that stream both audio AND video (Argus
        // sends camera frames alongside mic audio in the same session) are
        // hard-capped at 2 minutes per Gemini's Live API docs and silently
        // terminate — no error, just an onclose. Sliding-window compression
        // lets sessions run indefinitely instead.
        contextWindowCompression: { slidingWindow: {} },
        // DO NOT re-add `realtimeInputConfig.automaticActivityDetection` here
        // without new evidence. It has now been tried TWICE and produced the
        // same fatal crash both times:
        //   - 2026-08-07 (known issue #27): raised silenceDurationMs to
        //     1500ms; session died with `1007 The audio content type
        //     (CONTENT_TYPE_AUDIO) is not supported for this model
        //     configuration` shortly after a barge-in interruption.
        //   - 2026-08-13: re-added with the opposite goal (LOWERING
        //     silenceDurationMs to 500ms for speed), on the reasoning that
        //     the first crash might have been specific to the raised value.
        //     Confirmed 2026-08-21 on build 40 / revision argus-00027-fs9:
        //     identical `1007` close, again mid-conversation, again in a
        //     barge-in-heavy session — and the user-visible symptom was the
        //     app dropping to the dormant home screen with the question
        //     unanswered.
        // Two attempts, opposite parameter directions, identical failure:
        // the trigger is this config field EXISTING on this preview model,
        // not the value it carries. Gemini's default VAD (~800ms silence)
        // works fine; the ~300ms it might save is not worth a hard session
        // kill. If turn-end latency ever needs tuning again, do it on the
        // client (mic chunking) or by changing models — not here.
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Puck" },
          },
        },
        // See THINKING_BUDGET above — omitted entirely (not even sent as
        // undefined) when unset, so the model's own default applies exactly
        // as before this existed. THINKING_LEVEL (3.1's parameter) wins if
        // both are set — never set THINKING_BUDGET on the 3.1 arm.
        ...(THINKING_BUDGET !== null ? { thinkingConfig: { thinkingBudget: THINKING_BUDGET } } : {}),
        ...(THINKING_LEVEL ? { thinkingConfig: { thinkingLevel: THINKING_LEVEL } } : {}),
        // Env-gated 3.1 knobs — see their declarations up top. Omitted
        // entirely when unset, exactly like everything else here.
        ...((TURN_COVERAGE || (VAD_SILENCE_MS !== null && !Number.isNaN(VAD_SILENCE_MS))) ? {
          realtimeInputConfig: {
            ...(TURN_COVERAGE ? { turnCoverage: TURN_COVERAGE } : {}),
            ...(VAD_SILENCE_MS !== null && !Number.isNaN(VAD_SILENCE_MS) ? { automaticActivityDetection: { silenceDurationMs: VAD_SILENCE_MS } } : {}),
          },
        } : {}),
        systemInstruction: {
          parts: [{ text: systemInstruction }],
        },
        // Grounding first, then the in-process functions. Both kinds of tool
        // coexist in this array — googleSearch is handled inside the model, so
        // no toolCall ever arrives for it and handleToolCall never sees one.
        tools: GOOGLE_SEARCH_GROUNDING ? [{ googleSearch: {} }, ...TOOLS] : TOOLS,
      },
      callbacks: {
        onopen: () => {
          console.log(`🔗 Connected to Gemini Live API (model=${MODEL}, thinking=${THINKING_LEVEL || (THINKING_BUDGET === null ? "default" : THINKING_BUDGET)}, vadSilenceMs=${VAD_SILENCE_MS ?? "default"}, turnCoverage=${TURN_COVERAGE || "default"})`);
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: "connected" }));
          }
        },

        onmessage: async (msg) => {
          if (clientWs.readyState !== WebSocket.OPEN) return;

          try {
            // Computed once per message via extractAudioData (below) instead
            // of reading the SDK's own msg.data getter — see that function's
            // comment for why. Every one of this block's several checks below
            // used to call msg.data directly, each one re-triggering the
            // getter's warning and re-walking/re-concatenating every part.
            const audioData = extractAudioData(msg);

            // First sign of a new turn's response (tool call, audio, or
            // transcript text) after the user finished talking — logs how
            // long Gemini actually took to start responding, separate from
            // connection-open latency.
            const isResponseActivity = !!(msg.toolCall || audioData || (msg.serverContent && msg.serverContent.outputTranscription && msg.serverContent.outputTranscription.text));
            if (isResponseActivity && !responseInFlight) {
              responseInFlight = true;
              responseStartedAt = Date.now();
              suppressedChunks = 0;
              turnStartedAt = Date.now();
              turnAudioChunks = 0;
              const quietMs = lastTurnEndedAt ? Date.now() - lastTurnEndedAt : 0;
              console.log(`🗣️ Response turn started${lastTurnEndedAt ? ` — ${quietMs}ms quiet since last turn ended` : ""}`);
              if (lastAudioForwardedAt) {
                console.log(`⏱️ Turn latency: ${Date.now() - lastAudioForwardedAt}ms`);
              }
              if (lastUserSpeechAt) {
                // ⚠️ Broken on 3.1 — inputTranscription arrives batched at
                // response time there, so this reads ~2ms. Kept because it is
                // still honest on the 2.5 arm; use v2 below for comparisons.
                console.log(`🎯 Response latency (last user speech → response start): ${Date.now() - lastUserSpeechAt}ms`);
              }
              if (lastLoudChunkAt) {
                console.log(`🎯 Response latency v2 (last loud mic chunk → response start): ${Date.now() - lastLoudChunkAt}ms`);
              }
            }
            if (audioData) turnAudioChunks++;

            // When the user's own speech starts/stops, per inputAudioTranscription.
            // A long gap with NO user-speech events means dead air on the mic
            // side; a long gap full of them means Gemini heard speech and chose
            // not to respond — completely different bugs.
            // Grounding happens inside the model, so there is no toolCall to
            // log and otherwise no way to tell a grounded answer from an
            // invented one. Source domains and a query COUNT are safe to keep:
            // they confirm it fired and let the sources be sanity-checked.
            //
            // The query TEXT is not. Gemini writes those queries from what the
            // user just said, so "battery life on my Sony headphones" is the
            // user's speech by another route — and Cloud Run logs are retained
            // while the App Store disclosure states Argus does not store
            // speech. It therefore sits behind the same LOG_TRANSCRIPT_TEXT
            // gate as the input transcript, which is the same class of data.
            const gm = msg.serverContent && msg.serverContent.groundingMetadata;
            if (gm) {
              const domains = [...new Set((gm.groundingChunks || [])
                .map((c) => { try { return new URL(c.web && c.web.uri).hostname.replace(/^www\./, ""); } catch { return null; } })
                .filter(Boolean))];
              const queries = gm.webSearchQueries || [];
              console.log(`🔎 Google Search grounding used — ${queries.length} quer${queries.length === 1 ? "y" : "ies"}${domains.length ? ` — sources: ${domains.slice(0, 5).join(", ")}` : ""}`);
              if (process.env.LOG_TRANSCRIPT_TEXT === "1" && queries.length) {
                console.log(`   searched: ${queries.join(" | ").slice(0, 120)}`);
              }
            }

            const inTr = msg.serverContent && msg.serverContent.inputTranscription;
            if (inTr && inTr.text) {
              if (!userSpeechOpen) { userSpeechOpen = true; console.log("🎙️ User speech detected"); }
              lastUserSpeechAt = Date.now();
              if (process.env.LOG_TRANSCRIPT_TEXT === "1") {
                console.log(`   user said: ${String(inTr.text).slice(0, 80)}`);
              }
            }

            if (msg.serverContent && msg.serverContent.interrupted) {
              console.log("⚡ Gemini interrupted its own response (barge-in)");
              // Tell the client to drop whatever it has buffered. Gemini stops
              // generating the moment it detects barge-in, but chunks already
              // forwarded are sitting in the client's playback queue — without
              // this the client finishes speaking the abandoned response and
              // then plays the replacement on top of it, which is audible as
              // Argus talking over itself and repeating (reported on build 41).
              // The client's stopPlayback() already clears the queue and
              // invalidates the in-flight playback token; it just had no way
              // to know an interruption had happened.
              clientWs.send(JSON.stringify({ type: "interrupted" }));
            }

            // Handle tool calls from Gemini
            if (msg.toolCall) {
              console.log("🔧 Tool call:", JSON.stringify(msg.toolCall).substring(0, 200));
              const functionCalls = msg.toolCall.functionCalls || [];
              const functionResponses = [];

              for (const fc of functionCalls) {
                try {
                  // Tool handler wall time. Most handlers are one or two
                  // sequential Firestore round trips; the 200-user audit
                  // ESTIMATED these at 50-150ms each and never measured one.
                  // This sits inside the turn, so unlike the connection-open
                  // costs it is paid again on every tool-using response and
                  // is a real candidate for perceived slowness.
                  const toolStart = Date.now();
                  // Coordinates come from the same per-connection geo lookup
                  // that feeds the system instruction. Passed explicitly
                  // rather than held module-side — see known issue #2 for what
                  // a shared global cost here last time.
                  const result = await handleToolCall(fc, userId, { lat: userLat, lon: userLon, city: userCity });
                  console.log(`⏱️ Tool ${fc.name}: ${Date.now() - toolStart}ms`);
                  functionResponses.push({
                    name: fc.name,
                    id: fc.id,
                    response: result,
                  });
                  console.log(`  → ${fc.name}:`, JSON.stringify(result).substring(0, 150));
                  if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({ type: "tool_event", tool: fc.name }));
                  }
                } catch (toolErr) {
                  console.error(`  ✗ ${fc.name} error:`, toolErr.message);
                  functionResponses.push({
                    name: fc.name,
                    id: fc.id,
                    response: { error: toolErr.message },
                  });
                }
              }

              // Send tool responses back to Gemini
              if (session && functionResponses.length > 0) {
                session.sendToolResponse({ functionResponses });
              }
              return;
            }

            // Handle audio response
            if (audioData) {
              clientWs.send(JSON.stringify({ type: "audio", data: audioData }));
            }

            // NOTE: do not touch msg.text here. This session is AUDIO-only
            // (responseModalities: [Modality.AUDIO]), so the SDK's .text
            // getter can never return anything useful — but reading it
            // concatenates every part and emits a "there are non-text parts
            // inlineData..." warning on every single audio chunk. That was
            // 3,232 of 4,000 log lines (81%) plus per-chunk string work on
            // the hot relay path. Captions come from outputTranscription
            // below instead.

            // Buffer the spoken-audio transcript as it streams in, then flush
            // it as one caption line when the turn completes — matches how
            // the audio itself arrives in chunks and avoids fragmenting the
            // transcript into many tiny lines client-side.
            if (msg.serverContent && msg.serverContent.outputTranscription && msg.serverContent.outputTranscription.text) {
              transcriptBuffer += msg.serverContent.outputTranscription.text;
            }

            // Handle turn complete
            if (msg.serverContent && msg.serverContent.turnComplete) {
              if (transcriptBuffer) {
                clientWs.send(JSON.stringify({ type: "text", data: transcriptBuffer }));
                transcriptBuffer = "";
              }
              clientWs.send(JSON.stringify({ type: "turn_complete" }));
              // Duration + chunk count make a long pause self-explaining: a
              // 36s turn with hundreds of chunks is Argus talking too long; a
              // 36s quiet gap before the next turn is Argus not responding.
              if (turnStartedAt) {
                const spokenMs = Date.now() - turnStartedAt;
                console.log(`🔇 Turn complete — ${turnAudioChunks} audio chunks over ${spokenMs}ms`);
              }
              // Chunks dropped this turn. If barge-ins persist while this is
              // non-zero, something other than the mic stream is triggering
              // them; if this is zero, the client gate is catching everything
              // and the server gate is redundant.
              if (suppressedChunks) console.log(`🔕 Suppressed ${suppressedChunks} mic chunks during response`);
              lastTurnEndedAt = Date.now();
              turnStartedAt = 0;
              responseInFlight = false;
              userSpeechOpen = false;
              lastUserSpeechAt = 0;
              lastLoudChunkAt = 0;
              // Loudness only, never content — same basis as the mic-level
              // line. Says whether SPEECH_RMS_MIN is calibrated for real
              // users: a window that peaked below it is one where the ack
              // could not have fired.
              console.log(`🎚️ Loudest mic chunk this window: RMS ${windowPeakRms} (threshold ${SPEECH_RMS_MIN}, ack ${heardSent ? "FIRED" : "did not fire"})`);
              windowPeakRms = 0;
              heardSent = false;
            }
          } catch (err) {
            console.error("Error processing Gemini message:", err.message);
          }
        },

        onerror: (err) => {
          // JSON.stringify(err) on an ErrorEvent-like object frequently
          // serializes to "{}" since .message/.error aren't always
          // own-enumerable — log the actual fields so a real occurrence is
          // diagnosable instead of leaving no trace of why it happened.
          console.error("Gemini error:", err?.message || err?.error?.message || JSON.stringify(err).substring(0, 300));
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: "error", data: "Connection error" }));
            // Gemini-side errors aren't reliably followed by onclose — close the
            // client socket here too so the connection doesn't linger as a zombie
            // (holding a per-IP connection slot, sending into a dead session).
            clientWs.close();
          }
        },

        onclose: (ev) => {
          // CloseEvent carries the real reason (code/reason/wasClean) — this
          // was previously discarded, leaving no way to tell a normal
          // client-initiated close from a genuine Gemini-side drop.
          console.log("Gemini session closed", ev?.code, ev?.reason || "(no reason given)");
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close();
          }
        },
      },
    });

    console.log(`✅ Gemini session established${GOOGLE_SEARCH_GROUNDING ? " (Google Search grounding ON)" : " (grounding OFF)"} with tools:`, TOOLS[0].functionDeclarations.map(f => f.name).join(", "));

    // Safe to detach synchronously here: `session` was just assigned and no
    // message event can fire between that assignment and this line, so a greet
    // is either latched above or handled by the main listener below — never
    // both, never neither.
    clientWs.off("message", earlyGreetListener);
    if (greetPending) {
      console.log("👋 Greet arrived before the Gemini session was ready — replaying it");
      try {
        session.sendClientContent({ turns: [{ role: "user", parts: [{ text: "greet" }] }], turnComplete: true });
      } catch (e) { console.warn("Replayed greet failed:", e.message); }
    }

    // Client → Gemini
    clientWs.on("message", (raw) => {
      if (!withinMsgRate()) return; // silently drop — protects Gemini quota from a flooding client
      try {
        const msg = JSON.parse(raw.toString());
        if (!msg || typeof msg.type !== "string" || !ALLOWED_WS_TYPES.has(msg.type)) return;

        if (msg.type === "audio" && session) {
          if (typeof msg.data !== "string" || !msg.data || msg.data.length > MAX_AUDIO_B64_LEN) return;
          audioChunks++;
          // Every 25, not every 100. At one chunk per second a 27-second
          // session only ever logged "chunks: 1", which made a live mic and a
          // mic that died after the first chunk look identical in the logs —
          // exactly the distinction needed to diagnose "it just wouldn't
          // answer". 25 bounds a stall to ~25s of ambiguity at negligible
          // log volume.
          if (audioChunks % 25 === 1) {
            // Level, not just count. A chunk counter proves the recording loop
            // is alive; it says nothing about whether the loop is capturing
            // SOUND. Those two failures look identical in the logs and are
            // completely different bugs — one session logged 26 perfectly
            // cadenced chunks while Gemini transcribed zero speech from them,
            // and there was no way to tell "the client sent silence" from
            // "Gemini ignored real audio" without guessing.
            //
            // Only every 25th chunk, so the base64 decode stays off the hot
            // path — CPU is the binding constraint here (CLAUDE.md #36). This
            // is loudness only, never content: no transcript, nothing that
            // contradicts the App Store disclosure.
            console.log(`🎤 Audio chunks: ${audioChunks} — mic ${describeMicLevel(msg.data)}`);
          }
          // A gap much longer than CHUNK_MS means the client stopped sending:
          // the recording loop died, or a gate is stuck shut. Silent before
          // this, and invisible in the chunk counter.
          // Only meaningful outside a response — during one the gate is
          // deliberately dropping chunks, so a gap is expected and warning
          // about it is noise. The first version fired on every single turn.
          if (!responseInFlight && lastAudioReceivedAt && Date.now() - lastAudioReceivedAt > 5000) {
            console.warn(`🎤⚠️ Mic gap: ${Date.now() - lastAudioReceivedAt}ms since last chunk`);
          }
          lastAudioReceivedAt = Date.now();
          // Do not forward mic audio into a response that is already being
          // generated. The SDK default is START_OF_ACTIVITY_INTERRUPTS, so any
          // activity on this stream aborts the turn in progress — which is why
          // build 46 logged a perfect 7 turns / 7 barge-ins, one per turn.
          //
          // The client gates this too (argusSpeakingRef in home.tsx), but it
          // cannot close the whole window: the client only learns a response
          // started when the first audio chunk REACHES it, ~1.7s after Gemini
          // actually began generating. Every chunk sent in that gap still
          // interrupts. Here responseInFlight flips the moment the server sees
          // the first response activity, so the gap is zero.
          //
          // Bounded so a turn that never completes cannot silently kill the
          // microphone for the rest of the session — that failure mode cost 6
          // of 21 sessions once already (see CLAUDE.md #33).
          if (responseInFlight && Date.now() - responseStartedAt < MAX_SUPPRESS_MS) {
            suppressedChunks++;
            return;
          }
          // After the suppression gate on purpose: a chunk the gate discards
          // never reached Gemini, so it must neither count as "speech Gemini
          // is answering" (v2 latency) nor trigger a "heard" the pipeline
          // will not act on.
          const chunkRms = quickRms(msg.data);
          if (chunkRms > windowPeakRms) windowPeakRms = chunkRms;
          if (chunkRms >= SPEECH_RMS_MIN) {
            lastLoudChunkAt = Date.now();
            if (!heardSent && !responseInFlight) {
              // Perceived latency: the client badge otherwise sits on
              // "Observing" for the full ~1-2s until the first response
              // audio arrives, which is the window users read as a hang
              // (#49 — the "40 seconds" complaint was 100% perception).
              // Old builds ignore unknown message types, so this is safe to
              // ship server-first.
              heardSent = true;
              clientWs.send(JSON.stringify({ type: "heard" }));
            }
          }
          // `audio`, not the legacy `media` field: media serializes to
          // realtime_input.media_chunks, which gemini-3.1-flash-live-preview
          // rejects with a fatal `1007 realtime_input.media_chunks is
          // deprecated. Use audio, video, or text instead.` the moment the
          // first chunk arrives (2026-08-31 — this killed every real phone
          // session while greet-race passed, because the probe streams no
          // media at all). 2.5 accepts both forms; audio/video is the
          // non-deprecated one on both models.
          session.sendRealtimeInput({
            audio: {
              data: msg.data,
              mimeType: "audio/pcm;rate=16000",
            },
          });
          lastAudioForwardedAt = Date.now();
        } else if (msg.type === "user_id" && msg.id) {
          if (typeof msg.id !== "string" || msg.id.length > 200) return;
          userId = msg.id;
          console.log("👤 User:", msg.id);
        } else if (msg.type === "greet" && session) {
          try {
            session.sendClientContent({ turns: [{ role: "user", parts: [{ text: "greet" }] }], turnComplete: true });
          } catch (e) { console.warn("Greet failed:", e.message); }
        } else if (msg.type === "image" && session) {
          if (typeof msg.data !== "string" || !msg.data || msg.data.length > MAX_IMAGE_B64_LEN) return;
          imageFrames++;
          console.log(`📷 Frame #${imageFrames}`);
          // `video`, not `media` — see the audio send above.
          session.sendRealtimeInput({
            video: {
              data: msg.data,
              mimeType: "image/jpeg",
            },
          });
        }
      } catch (err) {
        console.error("Error forwarding to Gemini:", err.message);
      }
    });

    clientWs.on("close", () => {
      console.log("👁️ Client disconnected");
      if (session) {
        try { session.close(); } catch (_) {}
        session = null;
      }
    });

    clientWs.on("error", (err) => {
      console.error("Client error:", err.message);
      if (session) {
        try { session.close(); } catch (_) {}
        session = null;
      }
    });
  } catch (err) {
    console.error("Failed to connect:", err);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: "error", data: `Connection failed: ${err.message}` }));
      clientWs.close();
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🏛️ Argus v0.3 running on http://0.0.0.0:${PORT}`);
  console.log(`👁️ Agents: Kitchen | Shopping | Fix-It | General | Memory | Context`);
  console.log(`🔧 Tools: ${TOOLS[0].functionDeclarations.map(f => f.name).join(", ")}`);
  console.log(`🧠 Memory: Firestore | 🌤️ Weather: Open-Meteo`);
});

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
import { deleteUserData, claimUserSecret, verifyDeviceSecret, reserveGlobalSlot, releaseGlobalSlot } from "./memory.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WS_SHARED_SECRET = process.env.WS_SHARED_SECRET;
const MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";

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

  const auth = await waitForAuth(clientWs);
  if (!auth) {
    console.warn("Rejected unauthenticated WS connection from", ip);
    clientWs.close(4001, "unauthorized");
    return;
  }

  // Fleet-wide capacity check — must happen after auth (an unauthenticated
  // connection should never consume a slot) and before opening the billed
  // Gemini session below.
  const slot = await reserveGlobalSlot(MAX_GLOBAL_CONCURRENT_SESSIONS);
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

  try {
    // Build dynamic system instruction with live memory, weather + location context
    const systemInstruction = await buildSystemInstruction(userLat, userLon, userCity, userId);
    console.log("📝 System instruction built with live context");

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
        // Reverted 2026-08-07: an explicit realtimeInputConfig.automaticActivityDetection
        // (silenceDurationMs/prefixPaddingMs) was added here as a Bug 1 mitigation, but
        // the very first live session on the revision that shipped it hit a fatal
        // "Gemini session closed 1007 CONTENT_TYPE_AUDIO is not supported for this model
        // configuration" mid-conversation, right after a barge-in interruption — an error
        // never seen once in the prior 30 days of logs. Single data point, not proven,
        // but a full crash outweighs the mid-sentence-interruption annoyance it was
        // mitigating — back off to Gemini's defaults until this can be confirmed safe.
        // See CLAUDE.md known issues for the full trace.
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Puck" },
          },
        },
        systemInstruction: {
          parts: [{ text: systemInstruction }],
        },
        tools: TOOLS,
      },
      callbacks: {
        onopen: () => {
          console.log("🔗 Connected to Gemini Live API");
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: "connected" }));
          }
        },

        onmessage: async (msg) => {
          if (clientWs.readyState !== WebSocket.OPEN) return;

          try {
            // First sign of a new turn's response (tool call, audio, or
            // transcript text) after the user finished talking — logs how
            // long Gemini actually took to start responding, separate from
            // connection-open latency.
            const isResponseActivity = !!(msg.toolCall || msg.data || (msg.serverContent && msg.serverContent.outputTranscription && msg.serverContent.outputTranscription.text));
            if (isResponseActivity && !responseInFlight) {
              responseInFlight = true;
              turnStartedAt = Date.now();
              turnAudioChunks = 0;
              const quietMs = lastTurnEndedAt ? Date.now() - lastTurnEndedAt : 0;
              console.log(`🗣️ Response turn started${lastTurnEndedAt ? ` — ${quietMs}ms quiet since last turn ended` : ""}`);
              if (lastAudioForwardedAt) {
                console.log(`⏱️ Turn latency: ${Date.now() - lastAudioForwardedAt}ms`);
              }
            }
            if (msg.data) turnAudioChunks++;

            // When the user's own speech starts/stops, per inputAudioTranscription.
            // A long gap with NO user-speech events means dead air on the mic
            // side; a long gap full of them means Gemini heard speech and chose
            // not to respond — completely different bugs.
            const inTr = msg.serverContent && msg.serverContent.inputTranscription;
            if (inTr && inTr.text) {
              if (!userSpeechOpen) { userSpeechOpen = true; console.log("🎙️ User speech detected"); }
              if (process.env.LOG_TRANSCRIPT_TEXT === "1") {
                console.log(`   user said: ${String(inTr.text).slice(0, 80)}`);
              }
            }

            if (msg.serverContent && msg.serverContent.interrupted) {
              console.log("⚡ Gemini interrupted its own response (barge-in)");
            }

            // Handle tool calls from Gemini
            if (msg.toolCall) {
              console.log("🔧 Tool call:", JSON.stringify(msg.toolCall).substring(0, 200));
              const functionCalls = msg.toolCall.functionCalls || [];
              const functionResponses = [];

              for (const fc of functionCalls) {
                try {
                  const result = await handleToolCall(fc, userId);
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
            if (msg.data) {
              const audioB64 =
                typeof msg.data === "string"
                  ? msg.data
                  : Buffer.from(msg.data).toString("base64");
              clientWs.send(JSON.stringify({ type: "audio", data: audioB64 }));
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
              lastTurnEndedAt = Date.now();
              turnStartedAt = 0;
              responseInFlight = false;
              userSpeechOpen = false;
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

    console.log("✅ Gemini session established with tools:", TOOLS[0].functionDeclarations.map(f => f.name).join(", "));

    // Client → Gemini
    clientWs.on("message", (raw) => {
      if (!withinMsgRate()) return; // silently drop — protects Gemini quota from a flooding client
      try {
        const msg = JSON.parse(raw.toString());
        if (!msg || typeof msg.type !== "string" || !ALLOWED_WS_TYPES.has(msg.type)) return;

        if (msg.type === "audio" && session) {
          if (typeof msg.data !== "string" || !msg.data || msg.data.length > MAX_AUDIO_B64_LEN) return;
          audioChunks++;
          if (audioChunks % 100 === 1) {
            console.log(`🎤 Audio chunks: ${audioChunks}`);
          }
          session.sendRealtimeInput({
            media: {
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
          session.sendRealtimeInput({
            media: {
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

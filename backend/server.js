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
import { deleteUserData, claimUserSecret, verifyDeviceSecret } from "./memory.js";

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

app.use("/api", httpRateLimit(60_000, 60));

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
app.use(express.static(frontendPath, { index: false }));

// WebSocket server. maxPayload is a blunt outer guard against oversized frames
// arriving before per-message validation below ever runs.
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4 * 1024 * 1024 });

const WS_MAX_CONN_PER_IP = 5;
const WS_MSG_RATE_LIMIT = 30; // messages/sec/connection
const ALLOWED_WS_TYPES = new Set(["audio", "image", "user_id", "greet"]);
const MAX_AUDIO_B64_LEN = 200_000; // ~150KB raw — generous for a 1s 16kHz/16-bit mono chunk
const MAX_IMAGE_B64_LEN = 3_000_000; // ~2.2MB raw — generous for a quality:0.5 JPEG frame
const connectionsByIp = new Map();

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

  // Auto-detect user location via IP for personalised weather + context.
  // Runs only after auth succeeds, so a rejected connection never triggers it.
  let userLat = parseFloat(process.env.WEATHER_LAT) || 41.88;
  let userLon = parseFloat(process.env.WEATHER_LON) || -87.63;
  let userCity = process.env.WEATHER_CITY || "your area";
  if (ip && !ip.includes("127.0.0.1") && !ip.includes("::1")) {
    try {
      const geo = await (await fetch("https://ipapi.co/" + ip + "/json/", { signal: AbortSignal.timeout(3000) })).json();
      if (geo.latitude) { userLat = geo.latitude; userLon = geo.longitude; userCity = [geo.city, geo.region_code].filter(Boolean).join(", ") || "your area"; console.log("📍 Location:", userCity); }
    } catch (e) { console.warn("Geolocation failed:", e.message); }
  }

  let userId = auth.id;
  console.log("👤 User:", userId);

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  let session = null;
  let audioChunks = 0;
  let imageFrames = 0;

  try {
    // Build dynamic system instruction with live memory, weather + location context
    const systemInstruction = await buildSystemInstruction(userLat, userLon, userCity, userId);
    console.log("📝 System instruction built with live context");

    session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
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

            // Handle text response
            if (msg.text) {
              clientWs.send(JSON.stringify({ type: "text", data: msg.text }));
            }

            // Handle turn complete
            if (msg.serverContent && msg.serverContent.turnComplete) {
              clientWs.send(JSON.stringify({ type: "turn_complete" }));
            }
          } catch (err) {
            console.error("Error processing Gemini message:", err.message);
          }
        },

        onerror: (err) => {
          console.error("Gemini error:", JSON.stringify(err).substring(0, 300));
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: "error", data: "Connection error" }));
            // Gemini-side errors aren't reliably followed by onclose — close the
            // client socket here too so the connection doesn't linger as a zombie
            // (holding a per-IP connection slot, sending into a dead session).
            clientWs.close();
          }
        },

        onclose: (ev) => {
          console.log("Gemini session closed");
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

/**
 * Argus — The All-Seeing Companion
 * Backend: Express + WebSocket relay to Gemini Live API with ADK-style agents
 */

import { GoogleGenAI, Modality } from "@google/genai";
import dotenv from "dotenv";
import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { SYSTEM_INSTRUCTION, TOOLS, handleToolCall } from "./agents.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";

// Express app
const app = express();
const server = createServer(app);

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", name: "Argus", model: MODEL, agents: ["kitchen", "shopping", "fixit", "general"] });
});

// Serve frontend
const frontendPath = path.join(__dirname, "..", "frontend");
app.get("/", (req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});
app.use(express.static(frontendPath));

// WebSocket server
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", async (clientWs) => {
  console.log("👁️ Client connected");

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  let session = null;
  let audioChunks = 0;
  let imageFrames = 0;

  try {
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
          parts: [{ text: SYSTEM_INSTRUCTION }],
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

        onmessage: (msg) => {
          if (clientWs.readyState !== WebSocket.OPEN) return;

          try {
            // Handle tool calls from Gemini
            if (msg.toolCall) {
              console.log("🔧 Tool call:", JSON.stringify(msg.toolCall).substring(0, 200));
              const functionCalls = msg.toolCall.functionCalls || [];
              const functionResponses = [];

              for (const fc of functionCalls) {
                const result = handleToolCall(fc);
                functionResponses.push({
                  name: fc.name,
                  id: fc.id,
                  response: result,
                });
                console.log(`  → ${fc.name}:`, JSON.stringify(result).substring(0, 150));
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
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === "audio" && session) {
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
        } else if (msg.type === "image" && session) {
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
  console.log(`🏛️ Argus v0.2 running on http://0.0.0.0:${PORT}`);
  console.log(`👁️ Agents: Kitchen | Shopping | Fix-It | General Vision`);
  console.log(`🔧 Tools: ${TOOLS[0].functionDeclarations.map(f => f.name).join(", ")}`);
});

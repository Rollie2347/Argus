/**
 * Argus — The All-Seeing Companion
 * Backend: Express + WebSocket relay to Gemini Live API
 */

import { GoogleGenAI, Modality } from "@google/genai";
import dotenv from "dotenv";
import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.0-flash-live";

const SYSTEM_INSTRUCTION = `You are Argus, an all-seeing AI life companion named after Argus Panoptes — the hundred-eyed guardian of Greek mythology.

Your role: You see the user's world through their camera and help with whatever they're doing — cooking, shopping, navigation, fixing things, or just answering questions about what they see.

Your personality:
- Warm, friendly, and efficient — like a knowledgeable friend, not a corporate assistant
- Proactive — point out things you notice before being asked
- Contextually appropriate — match the energy of the situation
- Slightly witty but never annoying
- Concise by default — short helpful responses, elaborate only when needed

Your capabilities:
- You can SEE through the user's camera in real-time
- You can HEAR the user speaking naturally
- You can SPEAK back with voice responses
- You remember context within the current session

Guidelines:
- If you see a kitchen/food scenario, offer cooking guidance
- If you see a store/products, help with shopping decisions
- If you see a road/driving scenario, help with navigation awareness
- If you see something broken/a tool, offer fix-it guidance
- For anything else, be a helpful visual assistant
- Always be grounded — if you're not sure what you see, say so
- Handle interruptions gracefully
- Keep responses SHORT for voice — 1-3 sentences unless they ask for detail
- Be proactive about what you see — don't just wait for questions`;

// Express app for serving frontend
const app = express();
const server = createServer(app);

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", name: "Argus", model: MODEL });
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
            // Audio response from Gemini
            if (msg.data) {
              const audioB64 =
                typeof msg.data === "string"
                  ? msg.data
                  : Buffer.from(msg.data).toString("base64");
              clientWs.send(JSON.stringify({ type: "audio", data: audioB64 }));
            }

            // Text response
            if (msg.text) {
              clientWs.send(JSON.stringify({ type: "text", data: msg.text }));
            }

            // Turn complete
            if (
              msg.serverContent &&
              msg.serverContent.turnComplete
            ) {
              clientWs.send(JSON.stringify({ type: "turn_complete" }));
            }
          } catch (err) {
            console.error("Error forwarding to client:", err.message);
          }
        },

        onerror: (err) => {
          console.error("Gemini session error:", err);
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(
              JSON.stringify({ type: "error", data: "Gemini connection error" })
            );
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

    console.log("✅ Gemini session established");

    // Receive from client → send to Gemini
    clientWs.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === "audio" && session) {
          session.sendRealtimeInput({
            media: {
              data: msg.data,
              mimeType: "audio/pcm;rate=16000",
            },
          });
        } else if (msg.type === "image" && session) {
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
      console.error("Client WebSocket error:", err.message);
      if (session) {
        try { session.close(); } catch (_) {}
        session = null;
      }
    });
  } catch (err) {
    console.error("Failed to connect to Gemini:", err);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(
        JSON.stringify({
          type: "error",
          data: `Failed to connect: ${err.message}`,
        })
      );
      clientWs.close();
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🏛️ Argus backend running on http://0.0.0.0:${PORT}`);
  console.log(`👁️ WebSocket endpoint: ws://0.0.0.0:${PORT}/ws`);
});

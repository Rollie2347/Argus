/**
 * Greet-race probe — does Argus actually speak first?
 *
 * The mobile client fires `greet` on a fixed 1200ms timer after the WebSocket
 * opens (mobile/services/websocket.ts), with no way to know whether the Gemini
 * session exists yet. Connection-open measures 1.0-1.6s, so the greet lands
 * early roughly half the time, and the server's handler gates on `session` —
 * so it was silently discarded. The user then waits in silence for a greeting
 * that was already thrown away, eventually speaks, and gets a perfectly normal
 * ~1.5s reply. The whole thing reads as "it took 40 seconds to answer".
 *
 * This sends the greet after `delayMs` (default 50ms) so it is GUARANTEED to
 * arrive before the session is ready, then reports whether any audio came
 * back. Pass 1200 to reproduce the real client's timing instead.
 *
 *   node scripts/greet-race.mjs [backendUrl] [delayMs]
 */
import { WebSocket } from "ws";

const BACKEND = process.argv[2] || "https://argus-798059802495.us-central1.run.app";
const DELAY_MS = parseInt(process.argv[3] || "50", 10);
const WAIT_MS = 20000;

const html = await (await fetch(BACKEND)).text();
// Double-quoted only — the live secret is the placeholder from known issue #34
// and contains an apostrophe, which a ["'] class would truncate.
const m = html.match(/WS_SECRET\s*=\s*"([^"]*)"/i);
if (!m) throw new Error("could not extract WS secret");

// One second of silent PCM16 mono @16kHz — what the phone's mic loop sends —
// and a minimal valid 1x1 JPEG, what the frame loop sends. Streaming these is
// the part of a real session this probe previously did NOT cover, and the gap
// mattered: the 2026-08-31 flip to gemini-3.1-flash-live-preview passed 10/10
// greet-only probe runs, then killed every REAL session with `1007
// realtime_input.media_chunks is deprecated` on the first camera frame,
// because greet-race never sent a single byte of media. A model/config change
// is only validated when a probe that streams BOTH kinds of media survives it.
const SILENT_PCM_B64 = Buffer.alloc(16000 * 2).toString("base64");
// A real (tiny) JPEG from disk, NOT a base64 literal pasted into source: the
// first version of this embedded a from-memory string that was subtly corrupt,
// and Gemini killed the session with `1007 Invalid value at
// 'realtime_input.video.data' ... Base64 decoding failed` — which looks
// exactly like the send-path bug this probe exists to catch.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const TINY_JPEG_B64 = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "probe-frame.jpg")
).toString("base64");
// How long the session must survive after the media goes up. The 3.1
// media_chunks kill arrived within ~100ms of Frame #1, so 3s is generous.
const MEDIA_HOLD_MS = 3000;

const ws = new WebSocket(BACKEND.replace(/^http/, "ws") + "/ws");
let audioChunks = 0;
let firstAudioAt = 0;
let openedAt = 0;
let mediaSentAt = 0;
let mediaSurvived = false;
let closedEarly = null;

await new Promise((resolve) => {
  const timer = setTimeout(resolve, WAIT_MS);
  const finish = () => { clearTimeout(timer); resolve(); };
  ws.on("open", () => {
    openedAt = Date.now();
    ws.send(JSON.stringify({ type: "user_id", id: "greet_race_probe", name: "Probe", secret: m[1] }));
    setTimeout(() => {
      console.log(`sent greet at +${Date.now() - openedAt}ms`);
      ws.send(JSON.stringify({ type: "greet" }));
    }, DELAY_MS);
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "audio") {
      if (!audioChunks) firstAudioAt = Date.now();
      audioChunks++;
    }
    if (msg.type === "error" && mediaSentAt) { closedEarly = `server error: ${msg.data}`; finish(); }
    if (msg.type === "turn_complete" && audioChunks && !mediaSentAt) {
      // Greet done — now exercise the media path a real session uses.
      mediaSentAt = Date.now();
      ws.send(JSON.stringify({ type: "audio", data: SILENT_PCM_B64 }));
      ws.send(JSON.stringify({ type: "image", data: TINY_JPEG_B64 }));
      console.log(`sent 1s PCM chunk + JPEG frame at +${mediaSentAt - openedAt}ms`);
      setTimeout(() => { mediaSurvived = true; finish(); }, MEDIA_HOLD_MS);
    }
  });
  ws.on("error", (e) => { console.log("ws error:", e.message); finish(); });
  ws.on("close", (code, reason) => {
    if (mediaSentAt && !mediaSurvived) closedEarly = `closed ${code} ${reason || ""} ${Date.now() - mediaSentAt}ms after media`;
    finish();
  });
});
try { ws.close(); } catch {}

console.log(`greet delay      : ${DELAY_MS}ms`);
console.log(`audio chunks back: ${audioChunks}`);
if (audioChunks) {
  console.log(`first audio at   : +${firstAudioAt - openedAt}ms after open`);
  console.log("RESULT: Argus SPOKE FIRST — greet survived");
} else {
  console.log("RESULT: SILENCE — the greet was dropped and Argus never spoke");
}
if (mediaSurvived) {
  console.log(`MEDIA: session survived ${MEDIA_HOLD_MS}ms after a real PCM chunk + JPEG frame`);
} else if (closedEarly) {
  console.log(`MEDIA: FAILED — ${closedEarly}`);
} else {
  console.log("MEDIA: not exercised (greet never completed)");
}
process.exit(audioChunks && mediaSurvived ? 0 : 1);

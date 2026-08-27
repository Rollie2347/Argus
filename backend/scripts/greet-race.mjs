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

const ws = new WebSocket(BACKEND.replace(/^http/, "ws") + "/ws");
let audioChunks = 0;
let firstAudioAt = 0;
let openedAt = 0;

await new Promise((resolve) => {
  const timer = setTimeout(resolve, WAIT_MS);
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
    if (msg.type === "turn_complete" && audioChunks) { clearTimeout(timer); resolve(); }
  });
  ws.on("error", (e) => { console.log("ws error:", e.message); clearTimeout(timer); resolve(); });
  ws.on("close", () => { clearTimeout(timer); resolve(); });
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
process.exit(audioChunks ? 0 : 1);

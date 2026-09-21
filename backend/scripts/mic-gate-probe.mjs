/**
 * Mic-gate probe — does the gate obey MIC_GATE_MODE, and at what mic level
 * does Gemini abort a turn in progress?
 *
 * Two jobs, both impossible to answer any other way without a phone.
 *
 * 1. PLUMBING. The client now sends every mic chunk and tags whether Argus's
 *    audio was playing (`gated`), and the server decides from that. This
 *    streams tagged chunks straight into a live response and reports whether
 *    the session survived, so a gate-mode flip can be verified before it is
 *    trusted. Check the server log for the matching lines:
 *      🔗 Connected ... micGate=<mode>
 *      🔕 Mic gate (<mode>): held N, passed M chunk(s) during response
 *      🔊 Mic RMS during response — playing: ... | pre-playback: ...
 *
 * 2. VAD SENSITIVITY — the risk side of reopening the gate. Gemini's default
 *    activity handling is START_OF_ACTIVITY_INTERRUPTS, so the question that
 *    decides whether an energy gate is safe at all is: how LOUD does audio
 *    have to be before 3.1 aborts the turn it is generating? This streams
 *    REAL speech scaled to a chosen RMS during a response and reports whether
 *    an interruption came back. Sweep it against the echo floor measured on a
 *    real device (🔊 above) and the gate threshold has to sit between them.
 *
 *    The audio is frontend/reference-audio.wav rescaled, not a generated
 *    tone — VAD responds to speech shape, and a sine wave would answer a
 *    different question. This is the "energy/echo test" that #44 said had to
 *    happen before anything was reopened.
 *
 * ⚠️ Job 2 only produces a number when the gate is actually forwarding, i.e.
 * MIC_GATE_MODE is open/time/hybrid on the deployed service. In the default
 * `drop` mode every chunk is held and the correct result is "no interruption,
 * because nothing reached Gemini" — which the probe says explicitly rather
 * than reporting a false clean bill of health.
 *
 *   node scripts/mic-gate-probe.mjs [backendUrl] [targetRms] [chunks]
 */
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BACKEND = process.argv[2] || "https://argus-798059802495.us-central1.run.app";
const TARGET_RMS = parseInt(process.argv[3] || "700", 10);
const CHUNKS = parseInt(process.argv[4] || "4", 10);
const CHUNK_SAMPLES = 16000;

const TINY_JPEG_B64 = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "probe-frame.jpg")
).toString("base64");

const html = await (await fetch(BACKEND)).text();
const secret = (html.match(/WS_SECRET\s*=\s*"([^"]*)"/i) || [])[1];
if (!secret) throw new Error("could not extract WS secret from GET /");

// Real speech, resampled 24k -> 16k the same way latency-probe.mjs does it.
const wav = Buffer.from(await (await fetch(`${BACKEND}/reference-audio.wav`)).arrayBuffer());
const src = wav.subarray(44);
const srcSamples = Math.floor(src.length / 2);
const outSamples = Math.floor(srcSamples * (16000 / 24000));
const pcm = Buffer.alloc(outSamples * 2);
for (let i = 0; i < outSamples; i++) {
  const pos = i * 1.5;
  const i0 = Math.floor(pos);
  const frac = pos - i0;
  const s0 = src.readInt16LE(i0 * 2);
  const s1 = i0 + 1 < srcSamples ? src.readInt16LE((i0 + 1) * 2) : s0;
  pcm.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
}

// Rescale a chunk so its RMS lands on the target. Scaling preserves speech
// shape, which is what VAD keys on — the point is to vary LEVEL alone.
function atRms(buf, target) {
  let sum = 0;
  const n = Math.floor(buf.length / 2);
  for (let i = 0; i < n; i++) { const s = buf.readInt16LE(i * 2); sum += s * s; }
  const rms = Math.sqrt(sum / n) || 1;
  const k = target / rms;
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < n; i++) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(buf.readInt16LE(i * 2) * k))), i * 2);
  }
  return out;
}
function measured(buf) {
  let sum = 0;
  const n = Math.floor(buf.length / 2);
  for (let i = 0; i < n; i++) { const s = buf.readInt16LE(i * 2); sum += s * s; }
  return Math.round(Math.sqrt(sum / n));
}

const scaled = [];
for (let c = 0; c < CHUNKS; c++) {
  const start = (c % 3) * CHUNK_SAMPLES * 2;
  const slice = pcm.subarray(start, Math.min(start + CHUNK_SAMPLES * 2, pcm.length));
  if (slice.length < 2) break;
  scaled.push(atRms(slice, TARGET_RMS));
}
console.log(`streaming ${scaled.length} chunk(s) of real speech rescaled to RMS ~${measured(scaled[0])} (asked ${TARGET_RMS}), tagged gated:true, during Argus's response`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(BACKEND.replace(/^http/, "ws") + "/ws");
let interrupted = false, sentDuringResponse = 0, audioChunks = 0, turnCompleted = false, speaking = false, err = "";

await new Promise((resolve) => {
  const done = setTimeout(resolve, 45000);
  const finish = () => { clearTimeout(done); resolve(); };
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "user_id", id: "mic_gate_probe", name: "Probe", secret }));
  });
  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "connected") {
      ws.send(JSON.stringify({ type: "image", data: TINY_JPEG_B64 }));
      ws.send(JSON.stringify({ type: "greet" }));
    } else if (msg.type === "audio") {
      audioChunks++;
      // Start pushing the moment Argus is genuinely speaking — this is the
      // exact window the gate governs.
      if (!speaking) {
        speaking = true;
        for (const c of scaled) {
          if (turnCompleted) break;
          ws.send(JSON.stringify({ type: "audio", data: c.toString("base64"), gated: true }));
          sentDuringResponse++;
          await sleep(1000);
        }
      }
    } else if (msg.type === "interrupted") {
      interrupted = true;
    } else if (msg.type === "turn_complete") {
      turnCompleted = true;
      setTimeout(finish, 1500);
    } else if (msg.type === "error") { err = msg.data; finish(); }
  });
  ws.on("error", (e) => { err = e.message; finish(); });
  ws.on("close", (code) => { if (!turnCompleted) err = err || `closed ${code}`; finish(); });
});
try { ws.close(); } catch {}

console.log(`\ngreeting audio chunks : ${audioChunks}`);
console.log(`chunks sent mid-turn  : ${sentDuringResponse} (tagged gated:true, RMS ~${TARGET_RMS})`);
console.log(`turn completed        : ${turnCompleted}`);
console.log(`Gemini interrupted    : ${interrupted}`);
if (err) console.log(`note                  : ${err}`);
console.log(
  interrupted
    ? `\nRESULT: audio at RMS ~${TARGET_RMS} DID abort the turn — an energy gate must sit above this level.`
    : `\nRESULT: audio at RMS ~${TARGET_RMS} did NOT abort the turn.` +
      `\n⚠️ Only meaningful if the deployed MIC_GATE_MODE forwards mid-response audio` +
      ` (open/time/hybrid). In the default 'drop' mode nothing reached Gemini, so this` +
      ` says the gate held — not that the level is safe. Check the server's` +
      ` "Mic gate (<mode>): held N, passed M" line to tell which you just measured.`
);

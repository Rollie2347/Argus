/**
 * Speech→response latency probe — the honest per-turn number, no phone needed.
 *
 * Why this exists: the 🎯 Response latency metric (v1) broke silently on
 * gemini-3.1-flash-live-preview — 2.5 streamed inputTranscription while the
 * user spoke, 3.1 delivers it batched ~2ms before the response starts, so v1
 * read 2ms on real sessions and measured nothing. greet-race.mjs cannot fill
 * the gap either: the greet path skips mic chunking and Gemini's silence
 * detection entirely, which is exactly why its ~1.6s win oversold the flip.
 *
 * What this does: opens a real session, streams REAL SPEECH as mic input —
 * frontend/reference-audio.wav (Gemini's own captured voice), decimated
 * 24kHz→16kHz, chopped into the same 1s PCM16 chunks the phone sends, at the
 * same 1s cadence — follows with silence chunks, and measures
 *   last speech chunk sent → first response audio received
 * which includes Gemini's VAD silence detection, generation, and both network
 * legs. It excludes only the phone-side terms (mic buffering, playback
 * decode). The server logs the matching `🎯 Response latency v2` line for
 * each run, measured on the server clock.
 *
 * A camera frame goes up alongside the speech so turn-coverage settings are
 * exercised the way a real session exercises them.
 *
 *   node scripts/latency-probe.mjs [backendUrl] [runs]
 */
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BACKEND = process.argv[2] || "https://argus-798059802495.us-central1.run.app";
const RUNS = parseInt(process.argv[3] || "5", 10);
const SPEECH_SECONDS = 3;
const CHUNK_SAMPLES = 16000; // 1s at 16kHz
const RESPONSE_WAIT_MS = 15000;

const TINY_JPEG_B64 = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "probe-frame.jpg")
).toString("base64");

const html = await (await fetch(BACKEND)).text();
const m = html.match(/WS_SECRET\s*=\s*"([^"]*)"/i);
if (!m) throw new Error("could not extract WS secret");

// Reference audio: 24kHz PCM16 mono behind a 44-byte WAV header. Linear-
// interpolation resample to 16kHz — VAD needs speech-shaped audio, not
// audiophile fidelity.
const wav = Buffer.from(await (await fetch(`${BACKEND}/reference-audio.wav`)).arrayBuffer());
const src = wav.subarray(44);
const srcSamples = Math.floor(src.length / 2);
const outSamples = Math.floor(srcSamples * (16000 / 24000));
const pcm16k = Buffer.alloc(outSamples * 2);
for (let i = 0; i < outSamples; i++) {
  const pos = i * 1.5;
  const i0 = Math.floor(pos);
  const frac = pos - i0;
  const s0 = src.readInt16LE(i0 * 2);
  const s1 = i0 + 1 < srcSamples ? src.readInt16LE((i0 + 1) * 2) : s0;
  pcm16k.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
}
const speechChunks = [];
for (let c = 0; c < SPEECH_SECONDS; c++) {
  const start = c * CHUNK_SAMPLES * 2;
  if (start >= pcm16k.length) break;
  speechChunks.push(pcm16k.subarray(start, Math.min(start + CHUNK_SAMPLES * 2, pcm16k.length)).toString("base64"));
}
const SILENCE_B64 = Buffer.alloc(CHUNK_SAMPLES * 2).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOnce(n) {
  const ws = new WebSocket(BACKEND.replace(/^http/, "ws") + "/ws");
  let latency = null;
  let note = "";
  let firstSpeechSentAt = 0;
  let heardAt = 0;
  await new Promise((resolve) => {
    const overall = setTimeout(() => { note = "timed out"; resolve(); }, 45000);
    const finish = () => { clearTimeout(overall); resolve(); };
    let lastSpeechSentAt = 0;
    let responded = false;

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "user_id", id: "latency_probe", name: "Probe", secret: m[1] }));
    });
    ws.on("message", async (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "connected") {
        // Frame + a settle chunk of silence first, then speech at the real
        // client's cadence, then silence until the response lands.
        ws.send(JSON.stringify({ type: "image", data: TINY_JPEG_B64 }));
        ws.send(JSON.stringify({ type: "audio", data: SILENCE_B64 }));
        await sleep(1000);
        for (const chunk of speechChunks) {
          if (responded) return; // model responded mid-speech (see below)
          ws.send(JSON.stringify({ type: "audio", data: chunk }));
          lastSpeechSentAt = Date.now();
          if (!firstSpeechSentAt) firstSpeechSentAt = lastSpeechSentAt;
          await sleep(1000);
        }
        for (let i = 0; i < 12 && !responded; i++) {
          ws.send(JSON.stringify({ type: "audio", data: SILENCE_B64 }));
          await sleep(1000);
        }
      } else if (msg.type === "heard" && !heardAt) {
        // The server's speech-onset ack — how much earlier the badge can
        // flip than the first response audio. Measured from the FIRST speech
        // chunk sent, since heard fires on speech onset, not speech end.
        heardAt = Date.now();
      } else if (msg.type === "audio" && !responded) {
        responded = true;
        // Response before the scripted speech finished — a real VAD firing on
        // an internal pause in the clip. Still a valid latency sample
        // relative to the last speech chunk that preceded it.
        latency = Date.now() - lastSpeechSentAt;
        if (lastSpeechSentAt === 0) { latency = null; note = "responded before any speech"; }
      } else if (msg.type === "turn_complete" && responded) {
        finish();
      } else if (msg.type === "error") {
        note = `server error: ${msg.data}`;
        finish();
      }
    });
    ws.on("error", (e) => { note = `ws error: ${e.message}`; finish(); });
    ws.on("close", (code) => { if (!responded) note = note || `closed ${code} before responding`; finish(); });
    setTimeout(() => { if (!responded) { note = note || "no response"; finish(); } }, 40000);
  });
  try { ws.close(); } catch {}
  const heardNote = heardAt && firstSpeechSentAt ? ` — heard ack +${heardAt - firstSpeechSentAt}ms after speech began` : "";
  console.log(`run ${n}: ${latency !== null ? latency + "ms (last speech chunk sent → first audio back)" : "NO SAMPLE"}${heardNote}${note ? " — " + note : ""}`);
  return latency;
}

const samples = [];
for (let i = 1; i <= RUNS; i++) {
  const s = await runOnce(i);
  if (s !== null) samples.push(s);
  await sleep(500);
}
if (samples.length) {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  console.log(`\nn=${samples.length}  min=${sorted[0]}  median=${median}  mean=${mean}  max=${sorted[sorted.length - 1]}`);
} else {
  console.log("\nno samples collected");
  process.exit(1);
}

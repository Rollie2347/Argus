/**
 * Audio probe — captures what Argus actually sounds like, without a phone.
 *
 * Opens a real WebSocket session against a running Argus backend, triggers a
 * spoken response via the existing `greet` message, captures the PCM audio
 * Gemini streams back, and measures its frequency content.
 *
 * The point is to settle one question objectively: is the "muffled" voice
 * already muffled when it LEAVES the backend, or is it something the mobile
 * client's playback path does to it? Six build cycles of on-device
 * impressions could not separate those two.
 *
 * It writes two WAVs and analyses both:
 *   argus-raw.wav   — exactly the PCM Gemini produced
 *   argus-gained.wav — the same PCM after mobile's tanh AUDIO_GAIN transform
 *                      (mobile/app/(main)/home.tsx), applied identically here
 *
 * If raw is full-bandwidth and gained is not, the gain is the muffler and the
 * fix is client-side. If raw is ALREADY rolled off, no amount of client work
 * will help and the cause is upstream (model/session config).
 *
 * Usage:
 *   node scripts/audio-probe.mjs [backendUrl] [gain]
 *   node scripts/audio-probe.mjs https://argus-...run.app 5.0
 */

import { WebSocket } from "ws";
import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BACKEND = process.argv[2] || "https://argus-798059802495.us-central1.run.app";
const GAIN = parseFloat(process.argv[3] || "5.0");
const SAMPLE_RATE = 24000; // Gemini Live output rate
const CAPTURE_MS = 25000;

// The frontend page has the shared secret injected server-side at request
// time (serveIndexWithSecret), so fetching it is how a legitimate client
// gets it — no need to hardcode or plumb an env var in.
async function getSecret() {
  const html = await (await fetch(BACKEND)).text();
  // Double-quoted only: the live secret is currently the placeholder string
  // `<same value as backend's WS_SHARED_SECRET>` (known issue #34), which
  // contains an apostrophe — a ["'] character class truncates it there.
  const m = html.match(/WS_SECRET\s*=\s*"([^"]*)"/i);
  if (!m) throw new Error("Could not extract WS secret from index.html");
  return m[1];
}

function pcmToWav(int16, sampleRate) {
  const header = Buffer.alloc(44);
  const dataLen = int16.length * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLen, 40);
  const body = Buffer.alloc(dataLen);
  for (let i = 0; i < int16.length; i++) body.writeInt16LE(int16[i], i * 2);
  return Buffer.concat([header, body]);
}

// Iterative radix-2 FFT, in place on parallel real/imag arrays.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr; cwr = nwr;
      }
    }
  }
}

// Averages the magnitude spectrum over Hann-windowed frames, then reports
// energy per band and the spectral centroid. Centroid is the single most
// useful number here: "muffled" IS a low centroid — energy concentrated at
// low frequencies with the highs rolled off.
function analyse(int16, sampleRate, label) {
  const N = 2048;
  const bands = [[0, 500], [500, 1000], [1000, 2000], [2000, 4000], [4000, 6000], [6000, 8000], [8000, 12000]];
  const acc = new Float64Array(N / 2);
  let frames = 0;
  // Skip near-silent frames so leading/trailing silence doesn't skew results.
  for (let off = 0; off + N < int16.length; off += N) {
    let rms = 0;
    for (let i = 0; i < N; i++) rms += int16[off + i] * int16[off + i];
    rms = Math.sqrt(rms / N);
    if (rms < 300) continue;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
      re[i] = (int16[off + i] / 32768) * w;
    }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) acc[k] += Math.hypot(re[k], im[k]);
    frames++;
  }
  if (!frames) { console.log(`${label}: no non-silent audio`); return null; }
  for (let k = 0; k < N / 2; k++) acc[k] /= frames;

  const binHz = sampleRate / N;
  let total = 0, weighted = 0;
  for (let k = 1; k < N / 2; k++) { total += acc[k]; weighted += acc[k] * k * binHz; }
  const centroid = weighted / total;

  console.log(`\n=== ${label} ===`);
  console.log(`frames analysed: ${frames}   spectral centroid: ${centroid.toFixed(0)} Hz`);
  for (const [lo, hi] of bands) {
    let e = 0;
    for (let k = Math.ceil(lo / binHz); k < Math.min(hi / binHz, N / 2); k++) e += acc[k];
    const pct = (e / total) * 100;
    const bar = "#".repeat(Math.round(pct / 2));
    console.log(`  ${String(lo).padStart(5)}-${String(hi).padStart(5)} Hz  ${pct.toFixed(1).padStart(5)}%  ${bar}`);
  }
  return { centroid, total };
}

const secret = await getSecret();
console.log(`Backend: ${BACKEND}`);
console.log(`Secret:  ${secret.slice(0, 12)}... (${secret.length} chars)`);

const wsUrl = BACKEND.replace(/^https/, "wss").replace(/^http/, "ws") + "/ws";
const ws = new WebSocket(wsUrl);
const chunks = [];
let turns = 0;

const done = new Promise((resolve) => {
  const timer = setTimeout(resolve, CAPTURE_MS);
  ws.on("open", () => {
    console.log("connected, authenticating...");
    ws.send(JSON.stringify({ type: "user_id", id: "audio_probe_diagnostic", name: "Probe", secret }));
    setTimeout(() => ws.send(JSON.stringify({ type: "greet" })), 1200);
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "audio") chunks.push(Buffer.from(msg.data, "base64"));
    else if (msg.type === "text") console.log(`  transcript: ${msg.data.slice(0, 100)}`);
    else if (msg.type === "turn_complete") {
      turns++;
      console.log(`  turn ${turns} complete (${chunks.length} chunks so far)`);
      if (turns >= 1) { clearTimeout(timer); resolve(); }
    } else if (msg.type === "error") console.log(`  error: ${msg.data}`);
  });
  ws.on("close", (c, r) => { console.log(`closed ${c} ${r}`); clearTimeout(timer); resolve(); });
  ws.on("error", (e) => { console.log(`ws error: ${e.message}`); clearTimeout(timer); resolve(); });
});

await done;
try { ws.close(); } catch {}

if (!chunks.length) { console.log("No audio captured."); process.exit(1); }

const pcm = Buffer.concat(chunks);
const raw = new Int16Array(pcm.length / 2);
for (let i = 0; i < raw.length; i++) raw[i] = pcm.readInt16LE(i * 2);
console.log(`\ncaptured ${raw.length} samples (${(raw.length / SAMPLE_RATE).toFixed(2)}s)`);

// Identical transform to mobile's pcmChunksToWavBase64.
const gained = new Int16Array(raw.length);
let clipped = 0;
for (let i = 0; i < raw.length; i++) {
  const v = Math.round(Math.tanh((raw[i] / 32768) * GAIN) * 32767);
  if (Math.abs(v) > 32000) clipped++;
  gained[i] = v;
}

const outRaw = path.join(__dirname, "argus-raw.wav");
const outGain = path.join(__dirname, "argus-gained.wav");
writeFileSync(outRaw, pcmToWav(raw, SAMPLE_RATE));
writeFileSync(outGain, pcmToWav(gained, SAMPLE_RATE));

const a = analyse(raw, SAMPLE_RATE, "RAW (as Gemini produced it)");
const b = analyse(gained, SAMPLE_RATE, `AFTER mobile tanh gain ${GAIN}`);
console.log(`\nsamples driven near full scale by gain: ${((clipped / raw.length) * 100).toFixed(1)}%`);
if (a && b) {
  const shift = b.centroid - a.centroid;
  console.log(`centroid shift from gain: ${shift >= 0 ? "+" : ""}${shift.toFixed(0)} Hz`);
}
console.log(`\nwrote:\n  ${outRaw}\n  ${outGain}`);

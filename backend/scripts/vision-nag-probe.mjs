/**
 * Dark-camera repetition probe — does Argus say "I can't see anything" once,
 * or on every single turn?
 *
 * Why this exists: the vision rule in agents.js told Argus to say so plainly
 * whenever the feed was unusable, with no once-per-episode constraint, so in a
 * dark room it prefixed every answer with it. Checking that a prompt fix holds
 * needs SEVERAL CONSECUTIVE TURNS against a genuinely dark camera — one turn
 * proves nothing, because the first mention is the correct behaviour.
 *
 * What this does: opens a real session, streams a real dark JPEG on the
 * client's 2s cadence for the whole run, then asks several spoken questions
 * that do NOT require vision, one per turn, and prints each turn's transcript
 * (from outputAudioTranscription, which the server flushes as {type:"text"}).
 * It counts how many turns mention not being able to see.
 *
 * It mirrors the client's mic gate (#44) — no audio is sent while Argus is
 * speaking — so the probe cannot manufacture barge-ins the real app wouldn't.
 *
 * Stimulus, and its limits: dark-frame.jpg is a 640x480 JPEG at the near-zero
 * luminance a covered lens produces, and the q*.wav files are questions
 * rendered by the Windows speech synthesiser at the phone's exact 16kHz mono
 * PCM16. Neither is a phone recording. That is fine for THIS question — what
 * matters is that the feed is unusable and that several turns happen — but it
 * is not a substitute for a real device when judging audio quality or mic
 * levels, which is the mistake #43 and #57 both made. Regenerate the fixtures
 * with scripts/fixtures/make-fixtures.ps1.
 *
 *   node scripts/vision-nag-probe.mjs [backendUrl]
 */
import { WebSocket } from "ws";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BACKEND = process.argv[2] || "https://argus-798059802495.us-central1.run.app";
// Runs, not one run. A single pass here means nothing: the first version of
// this probe passed run 1 and then, on run 2 with no change to the server,
// hallucinated "a glass of red wine" from a black frame. Behaviour this
// prompt-dependent has to be reported as a RATE.
const RUNS = parseInt(process.argv[3] || "1", 10);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures");
const CHUNK_SAMPLES = 16000; // 1s at 16kHz, the client's CHUNK_MS
const FRAME_MS = 2000;

const DARK_FRAME = readFileSync(path.join(FIX, "dark-frame.jpg")).toString("base64");
// Two populations, because the pass condition is two-sided. q*.wav are
// answerable without seeing anything — those must NOT keep re-announcing the
// dark camera. v*.wav genuinely require the camera — those MUST still say so,
// or the fix has simply deleted the #40 Phase 6 behaviour that was confirmed
// on-device, which would be a worse bug than the nagging.
const QUESTIONS = readdirSync(FIX).filter((f) => /^q\d+\.wav$/.test(f)).sort();
const VISION_QS = readdirSync(FIX).filter((f) => /^v\d+\.wav$/.test(f)).sort();
if (!QUESTIONS.length) throw new Error("no q*.wav fixtures found in " + FIX);

const html = await (await fetch(BACKEND)).text();
const secret = (html.match(/WS_SECRET\s*=\s*"([^"]*)"/i) || [])[1];
if (!secret) throw new Error("could not extract WS secret from GET /");

// The fixtures are already 16kHz mono PCM16 behind a 44-byte WAV header —
// the exact format the phone sends — so they are chunked, not resampled.
function chunksFor(file) {
  const pcm = readFileSync(path.join(FIX, file)).subarray(44);
  const out = [];
  for (let o = 0; o < pcm.length; o += CHUNK_SAMPLES * 2) {
    out.push(pcm.subarray(o, Math.min(o + CHUNK_SAMPLES * 2, pcm.length)).toString("base64"));
  }
  return out;
}
const SILENCE = Buffer.alloc(CHUNK_SAMPLES * 2).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Matches the ways a voice assistant says it has no usable view. Deliberately
// broad: a false positive here is a visible transcript line you can read and
// judge yourself, whereas a miss would report a nag as fixed.
//
// The first version of this list was too narrow and scored a CORRECT answer
// — "I'm not seeing anything but blackness, so I can't tell what you're
// holding" — as a silent failure. Same class of mistake as #48's blocklist
// test that passed for the wrong reason: read the transcripts the probe
// prints and make the matcher agree with them, never the other way round.
const CANT_SEE = new RegExp([
  "can'?t see", "cannot see", "not able to see", "unable to see",
  "not seeing anything", "don'?t see anything", "nothing (?:to see|visible)",
  "can'?t make (?:it|anything) out", "can'?t tell what",
  "blackness", "nothing but black", "too dark",
  "(?:camera|view|feed)(?: view)? is (?:still )?(?:dark|black|blocked|covered|obstructed)",
].join("|"), "i");

const totals = { runs: 0, nags: 0, visionAsked: 0, visionTold: 0, hallucinated: 0 };
for (let run = 1; run <= RUNS; run++) {
  console.log(`
########## run ${run} of ${RUNS} ##########`);
  const ws = new WebSocket(BACKEND.replace(/^http/, "ws") + "/ws");
  let argusSpeaking = false;
  let transcript = "";
  const turns = [];
  let turnDone = null;

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "audio") argusSpeaking = true;
    else if (msg.type === "text") transcript += (transcript ? " " : "") + msg.data;
    else if (msg.type === "interrupted") argusSpeaking = false;
    else if (msg.type === "turn_complete") { argusSpeaking = false; if (turnDone) turnDone(); }
    else if (msg.type === "error") console.error("server error:", msg.data);
  });

  const waitTurn = (ms) => new Promise((res) => {
    const t = setTimeout(() => { turnDone = null; res("timeout"); }, ms);
    turnDone = () => { clearTimeout(t); turnDone = null; res("ok"); };
  });

  await new Promise((res, rej) => {
    ws.on("open", () => { ws.send(JSON.stringify({ type: "user_id", id: "vision_nag_probe", name: "Probe", secret })); });
    ws.on("message", function first(raw) {
      if (JSON.parse(raw.toString()).type === "connected") { ws.off("message", first); res(); }
    });
    ws.on("error", rej);
    setTimeout(() => rej(new Error("no connected message")), 20000);
  });

  // A dark frame on the client's real cadence for the whole run, so every turn
  // is answered with the camera genuinely unusable rather than merely absent.
  const frameTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "image", data: DARK_FRAME }));
  }, FRAME_MS);
  ws.send(JSON.stringify({ type: "image", data: DARK_FRAME }));

  // Let the greeting land and finish before the first question, exactly as a
  // user would — and record it as turn 0, because a nag in the greeting counts.
  ws.send(JSON.stringify({ type: "greet" }));
  await waitTurn(25000);
  turns.push({ label: "greeting", text: transcript.trim() });
  transcript = "";

  // Vision-needing questions go LAST, so that by the time they are asked the
  // non-vision turns have already had every chance to nag.
  const ASK = [...QUESTIONS, ...VISION_QS];
  for (let i = 0; i < ASK.length; i++) {
    await sleep(1200);
    for (const c of chunksFor(ASK[i])) {
      if (argusSpeaking) break;          // mirror the client mic gate (#44)
      ws.send(JSON.stringify({ type: "audio", data: c }));
      await sleep(1000);
    }
    for (let k = 0; k < 3 && !argusSpeaking; k++) {
      ws.send(JSON.stringify({ type: "audio", data: SILENCE }));
      await sleep(1000);
    }
    const r = await waitTurn(30000);
    turns.push({ label: ASK[i], needsVision: ASK[i].startsWith("v"), text: transcript.trim(), note: r === "timeout" ? "(no turn_complete)" : "" });
    transcript = "";
  }

  clearInterval(frameTimer);
  try { ws.close(); } catch {}

  console.log(`\nDark-camera run — ${turns.length} turns\n${"=".repeat(64)}`);
  let nags = 0, visionAsked = 0, visionTold = 0;
  for (const t of turns) {
    const hit = CANT_SEE.test(t.text);
    if (t.needsVision) { visionAsked++; if (hit) visionTold++; }
    else if (hit) nags++;
    const tag = t.needsVision ? (hit ? "said so (wanted)" : "SILENT (BAD)  ") : (hit ? "mentions blind" : "no mention    ");
    console.log(`\n[${tag}] ${t.label}${t.needsVision ? " [needs vision]" : ""} ${t.note || ""}`);
    console.log(`  ${t.text || "(no transcript)"}`);
  }
  totals.runs++;
  totals.nags += nags;
  totals.visionAsked += visionAsked;
  totals.visionTold += visionTold;
  // A vision question answered WITHOUT saying it cannot see is not merely
  // silence — on a black frame the only thing it can be doing instead is
  // describing something that is not there. Counted separately because it is
  // the serious failure; nagging is only annoying.
  totals.hallucinated += visionAsked - visionTold;
  console.log(`\nrun ${run}: nags=${nags}  vision answered blind-honestly ${visionTold}/${visionAsked}`);
}

console.log(`\n${"=".repeat(64)}\nAGGREGATE over ${totals.runs} run(s)`);
console.log(`Nag turns (non-vision turns re-announcing the dark camera): ${totals.nags}  — want <= 1 per run`);
console.log(`Vision questions answered honestly: ${totals.visionTold}/${totals.visionAsked}`);
console.log(`Vision questions answered by DESCRIBING SOMETHING NOT THERE: ${totals.hallucinated}  — want 0`);
const pass = totals.nags <= totals.runs && totals.hallucinated === 0;
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);

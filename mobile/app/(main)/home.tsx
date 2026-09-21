import { useState, useEffect, useRef } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, SafeAreaView, Alert, Switch, Animated } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Audio } from "expo-av";
// The raw native module, for getAudioSessionDiagnostics — a method our
// expo-av patch adds; it is not part of expo-av's public API.
import ExponentAV from "expo-av/build/ExponentAV";
import { router } from "expo-router";
import { getStoredUser, signOut, deleteAccount } from "../../services/auth";
import { ArgusSocket } from "../../services/websocket";
import { useCaptions } from "../../contexts/CaptionsContext";
import { pcmChunksToWavBase64 } from "../../services/audioGain";
import type { User } from "../../services/auth";

type Status = "dormant"|"connecting"|"observing"|"heard"|"speaking"|"error";
type Line = { text: string; role: "argus"|"user"|"tool" };

// Tried 400 (down from 1000) to cut mic-buffering delay — made things worse,
// not better: backend turn latency and barge-in rate stayed fine, so the
// regression wasn't Gemini, it was audio quality reaching it. Each cycle is a
// real stop/unload/prepare/start native round trip, not a continuous stream;
// at 400ms that fixed overhead is a much bigger fraction of a much smaller
// window, so more of the user's actual speech was lost to restart gaps than
// was saved in buffering time. Back to 1000, the known-good value.
const CHUNK_MS = 1000;
// Camera frames dominate the Gemini Live context window: video bills at 258
// tokens/sec against 25 tokens/sec for audio, so at a flat 2s cadence a real
// 115-second session measured 2026-08-09 spent 14,448 of its ~18,200 context
// tokens (79%) on frames, versus 897 for the entire system instruction.
// Context grows ~9,200 tokens/minute at that rate, and response quality and
// latency degrade as it fills — this is what actually degrades over a long
// conversation, not anything stored about the user.
//
// So: keep the responsive 2s cadence while a turn is actually in flight, and
// back off while nothing is happening. Idle time is exactly when frames are
// worth least — nobody is asking about what the camera sees — and it's most
// of a typical session.
const FRAME_MS = 2000;
const FRAME_MS_IDLE = 5000;
// How long after the last message from the server the conversation still
// counts as active. One full turn (speak → respond) keeps traffic flowing well
// inside this, so the cadence only drops during real lulls.
const FRAME_IDLE_AFTER_MS = 6000;
const CONNECT_TIMEOUT_MS = 12000;
// Barge-in cuts playback off wherever it happens to be, which lands mid-word
// and reads as Argus glitching rather than yielding. Backend logs bear this
// out: on the build that introduced the flush, measured barge-ins per turn
// HALVED while the user reported it "cutting out a lot" — the rate improved
// and each occurrence got more jarring at the same time. A short ramp is the
// difference between a click and a natural trail-off. Kept well under the
// ~100-300ms it takes the replacement burst to load and start, so the fade
// costs no added latency and cannot overlap the next response.
const FADE_MS = 120;
const FADE_STEPS = 6;
// Upper bound on how much audio is merged into ONE data: URI.
//
// prepareBurst used to merge everything queued with no limit. #18 introduced
// merging to remove a load gap at every chunk boundary, not to merge without
// bound — and on a long answer the queue can back up behind a slow load, so a
// single burst could reach several megabytes of base64. AVPlayer is known to
// be fragile with very large data: URIs, and build 55 produced exactly that
// failure on a real device: AVPlayerItem -11800 / -12842 sixteen seconds into
// a fresh launch. Twelve ~180ms chunks is about two seconds of audio, which
// still collapses the per-chunk boundaries #18 cared about while keeping each
// URI small enough to be unremarkable.
const MAX_BURST_CHUNKS = 12;
// A burst that reports finishing without its position ever moving never
// rendered anything. That is silent playback, and it is what makes the app
// look alive while producing nothing.
const SILENT_BURST_POSITION_MS = 40;

const TOOL_LABELS: Record<string, string> = {
  identify_scene: "Looking at what's around you",
  get_recipe_suggestion: "Finding a recipe",
  cooking_timer: "Setting a timer",
  compare_products: "Comparing products",
  diagnose_problem: "Diagnosing the problem",
  read_text: "Reading the text",
  manage_shopping_list: "Updating your shopping list",
  remember_preference: "Remembering that",
  recall_memory: "Checking what it remembers",
  get_weather: "Checking the weather",
  log_daily_activity: "Logging that",
  get_daily_summary: "Pulling up your day",
  forget_memory: "Forgetting that",
  update_profile: "Updating your profile",
  mark_profile_reviewed: "Saving your details",
  web_search: "Searching the web",
  find_places_nearby: "Looking for places near you",
  read_webpage: "Reading the page",
  research_topic: "Looking that up properly",
  research_place: "Reading up on that place",
};

async function getAudioB64(uri: string): Promise<string> {
  const r = await fetch(uri);
  const buf = await r.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}

function ErrorToast({ text, onDone }: { text: string; onDone: () => void }) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    const t = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 600, useNativeDriver: true }).start(({ finished }) => { if (finished) onDone(); });
    }, 3800);
    return () => clearTimeout(t);
  }, []);
  return (
    <Animated.View style={[s.errorToast, { opacity }]}>
      <Text style={s.errorToastTxt}>{text}</Text>
    </Animated.View>
  );
}

export default function Home() {
  const [user, setUser] = useState<User|null>(null);
  const [status, setStatus] = useState<Status>("dormant");
  const [lines, setLines] = useState<Line[]>([]);
  const [muted, setMuted] = useState(false);
  const [thinkingHint, setThinkingHint] = useState<string|null>(null);
  const [errors, setErrors] = useState<{id:number; text:string}[]>([]);
  const [facing, setFacing] = useState<"front"|"back">("back");
  const [deletingData, setDeletingData] = useState(false);
  const { captionsEnabled } = useCaptions();
  const [toolStatus, setToolStatus] = useState<string|null>(null);
  const [camPerm, requestCam] = useCameraPermissions();
  const socketRef = useRef<ArgusSocket|null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const recordingRef = useRef<Audio.Recording|null>(null);
  const loopRef = useRef<boolean>(false);
  const cameraRef = useRef<CameraView>(null);
  const frameIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const audioQueueRef = useRef<string[]>([]);
  const isPlayingRef = useRef(false);
  const soundRef = useRef<Audio.Sound | null>(null);
  const toolStatusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Incremented on every connect and every disconnect. Anything still in
  // flight from an older session (a socket whose close event hasn't landed
  // yet, a queued audio burst, a running capture loop) compares against this
  // and bails out, so a superseded session can't tear down the live one.
  const epochRef = useRef(0);
  // startAudioLoop reads `muted` from the closure it was created in, which
  // never updates for the life of the loop — mirror it in a ref so toggling
  // the mic switch actually takes effect mid-session.
  const mutedRef = useRef(false);
  // True from the first audio chunk of a response until the turn ends — i.e.
  // while Argus's voice is actually coming out of this phone's speaker.
  //
  // This USED to mean "drop the mic chunk". It no longer does: every chunk is
  // sent, and this only tags it so the server knows whether it contains
  // Argus's own voice. The decision about what reaches Gemini moved to
  // MIC_GATE_MODE in server.js, which is an env var — so a threshold can be
  // retuned against a real room in ~30 seconds instead of a 15-minute build
  // and a TestFlight round.
  //
  // Why it ever dropped: the client streamed mic audio continuously through
  // Argus's entire response, and Gemini's default activity handling is
  // START_OF_ACTIVITY_INTERRUPTS — so any activity on that stream aborts the
  // response in progress. Room noise, a breath, or speaker bleed was enough.
  // Build 46 logs showed 7 turns, 7 user-speech events and 7 barge-ins: a
  // perfect 1:1:1, every single turn interrupted exactly once. That is
  // structural, not sporadic, which is also why halving the output gain in
  // build 46 made the rate go UP (0.64 -> 1.00/turn) rather than down — echo
  // loudness was never the driver.
  //
  // Why it stopped: dropping worked (0.41 barge-ins/turn -> 0.05 on 3.1) but
  // cost the user their turn — a median 11.6s and p90 23.9s of speech thrown
  // away per response, which is what gets reported as being cut off (#59).
  // With an 8x margin in hand that trade is the wrong way round. Do NOT
  // reach for realtimeInputConfig.automaticActivityDetection as an
  // alternative — that field has caused an identical fatal 1007 twice on the
  // 2.5 arm (CLAUDE.md #27/#41).
  const argusSpeakingRef = useRef(false);
  // When the current response started. Backs the timeout below.
  const speakingSinceRef = useRef(0);

  // Bounds the TAG, not the microphone — nothing is withheld on this side any
  // more, so a stuck flag can no longer kill the mic the way it could before.
  // It still matters: if turn_complete goes missing (a dropped message, a
  // session ending mid-response) a stuck flag would tell the server every
  // later chunk contains Argus's voice, poisoning the echo measurement and,
  // in a level-based mode, holding the gate shut server-side. The server's own
  // MAX_SUPPRESS_MS is bounded at 20s for the same reason; this sits slightly
  // longer so the server's bound is normally the one that matters.
  const MAX_GATE_MS = 25000;
  function argusIsSpeaking() {
    if (!argusSpeakingRef.current) return false;
    if (Date.now() - speakingSinceRef.current > MAX_GATE_MS) {
      argusSpeakingRef.current = false;
      return false;
    }
    return true;
  }
  const audioStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playbackTokenRef = useRef(0);
  // Pipelining state: the next burst, already loaded and paused, waiting for
  // the current one's didJustFinish — and the timer that loads it. Both are
  // owned by whichever burst is currently playing and invalidated by
  // playbackTokenRef like everything else in the playback path.
  const nextBurstRef = useRef<{ sound: Audio.Sound; expectedMs: number } | null>(null);
  const prepareTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // EVERY loaded sound, so none can be orphaned.
  //
  // soundRef and nextBurstRef are single slots, and startBurst used to
  // overwrite soundRef unconditionally. When two bursts raced (see the
  // prepare timer below) the displaced one was still LOADED and still
  // PLAYING, with no reference left anywhere — so stopPlayback could not
  // stop it and teardownSession could not free it. Each one holds a native
  // player for the life of the JS context.
  //
  // That is the only class of fault that matches "audio worked in other apps,
  // and it took several disconnect/reconnects to clear": teardownSession
  // resets every ref this component owns, so anything surviving it is native
  // or module state, not component state. A leaked player is exactly that.
  const liveSoundsRef = useRef<Set<Audio.Sound>>(new Set());
  // prepareBurst failures this session, cleared on connect — NOT reset by a
  // success. Counting consecutive failures meant an intermittent one among
  // successes never reached the threshold and the user was never told.
  const burstFailuresRef = useRef(0);
  // When a burst fails to load, the size to retry the same audio at.
  const splitBurstRef = useRef(0);
  // Guards recoverAudioSession against re-entry.
  const recoveringAudioRef = useRef(false);
  async function unloadSound(sound: Audio.Sound) {
    liveSoundsRef.current.delete(sound);
    try { await sound.unloadAsync(); } catch {}
  }

  function addLine(text: string, role: Line["role"]) {
    setLines(prev => [...prev.slice(-20), { text, role }]);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }

  function clearConnectTimeout() {
    if (connectTimeoutRef.current) { clearTimeout(connectTimeoutRef.current); connectTimeoutRef.current = null; }
  }

  function handleMsg(msg: any) {
    // Messages from a superseded socket are discarded. Without this, a stale
    // socket's delayed close event reached the branches below and reverted a
    // live session to the dormant screen (camera unmounting mid-conversation),
    // and its leftover audio played on top of the current session's audio.
    if (msg.epoch !== undefined && msg.epoch !== epochRef.current) return;
    lastActivityRef.current = Date.now();
    if (msg.type === "connected") { clearConnectTimeout(); setStatus("observing"); }
    else if (msg.type === "text") { addLine(msg.data, "argus"); setStatus("observing"); clearToolStatus(); }
    else if (msg.type === "tool_event") showToolStatus(TOOL_LABELS[msg.tool] || msg.tool);
    // Server-side speech-onset ack (RMS gate on the mic chunk, ~50-80ms after
    // the first loud chunk lands). Without it the badge sits on "Observing"
    // through the full ~2s until response audio arrives — the window #49
    // showed users read as a hang. Perception, not speed.
    // Functional update: handleMsg lives for the whole session, so reading
    // the `status` state variable here would see the value captured at
    // connect time (the same stale-closure trap mutedRef exists for).
    else if (msg.type === "heard") setStatus(s => (s === "observing" ? "heard" : s));
    else if (msg.type === "audio") { argusSpeakingRef.current = true; speakingSinceRef.current = Date.now(); setStatus("speaking"); enqueueAudio(msg.data); }
    // Gemini abandoned the response it was generating (barge-in). Anything
    // still queued belongs to that abandoned turn, so playing it would talk
    // over — and then repeat ahead of — the replacement response that's about
    // to arrive. Drop it rather than draining it.
    else if (msg.type === "interrupted") { argusSpeakingRef.current = false; stopPlayback({ fade: true }); setStatus("observing"); reportAudioState("interrupted"); }
    // Reported at turn_complete because audio arrives faster than real time,
    // so the reply is normally still PLAYING here — the moment whose route
    // decides whether anything is heard.
    else if (msg.type === "turn_complete") { argusSpeakingRef.current = false; setStatus("observing"); clearToolStatus(); reportAudioState("turn"); }
    else if (msg.type === "disconnected") {
      // Reaching here means the backend genuinely dropped the connection —
      // a user-initiated teardown goes through disconnect() and never emits
      // this. Say so instead of silently falling back to the dormant screen.
      const dropped = socketRef.current;
      teardownSession();
      dropped?.disconnect();
      setStatus("dormant");
      pushError(msg.code === 4029 ? "Argus is at capacity — try again shortly" : "Connection dropped — tap ◉ to reconnect");
    }
    else if (msg.type === "error") { clearConnectTimeout(); pushError(msg.data); setStatus("error"); }
  }

  // Everything needed to stop a session's background work, without touching
  // status or the socket itself.
  function teardownSession() {
    clearConnectTimeout();
    if (audioStartTimerRef.current) { clearTimeout(audioStartTimerRef.current); audioStartTimerRef.current = null; }
    epochRef.current++;
    socketRef.current = null;
    // Must be cleared here. This is a ref on a mounted component, so it
    // survives disconnect -> reconnect: tearing down while Argus was mid-
    // response leaves it true with no turn_complete ever coming, and every
    // later session in the same app launch then sends ZERO mic audio. That
    // reads as "it just won't answer" and is the same silent dead-mic class
    // of bug as known issue #33.
    argusSpeakingRef.current = false;
    stopAudio(); stopFrameLoop(); stopPlayback(); clearToolStatus();
  }

  // Tool status (e.g. "Looking at what's around you") is shown as a transient
  // hint rather than a permanent transcript line, so old activity descriptions
  // don't linger in the caption box alongside newer dialogue.
  function showToolStatus(label: string) {
    setToolStatus(label);
    if (toolStatusTimeoutRef.current) clearTimeout(toolStatusTimeoutRef.current);
    toolStatusTimeoutRef.current = setTimeout(() => setToolStatus(null), 4000);
  }

  function clearToolStatus() {
    if (toolStatusTimeoutRef.current) { clearTimeout(toolStatusTimeoutRef.current); toolStatusTimeoutRef.current = null; }
    setToolStatus(null);
  }

  // Client-side diagnostics, sent to the server so they land in Cloud Run
  // logs alongside the session they belong to.
  //
  // The playback path had NO observability in a release build: one silent
  // catch, one __DEV__-only log, and several unlogged early returns. So
  // "Argus says Speaking but nothing comes out" was undiagnosable after the
  // fact, which is the smaller cousin of the missing crash reporting this
  // project keeps paying for. Loudness, timings and error strings only —
  // never audio content, never transcript text.
  function reportClient(event: string, detail?: string) {
    try { socketRef.current?.sendClientLog(event, detail); } catch {}
  }

  // The REAL iOS audio session, read natively, as one client_log line.
  //
  // Silent playback survived two fixes (#62, #63) with every probe above
  // quiet: sounds loaded, the playhead ran, nothing was heard. So the session
  // or its route is what is wrong, and only the session itself can say how.
  // Fixed key order because NSDictionary's is arbitrary and the server clamps
  // the line at 300 chars — the fields that decide the question come first:
  //   cat/mode/opt  category, mode, option bits    out/in  route port TYPES
  //   vol  output volume   sr  sample rate   oth  other audio playing
  //   sil  iOS says secondary audio should be silenced
  //   act  manager's own "session is active" flag   en  expo-av audio enabled
  //   exav expo-av session mode (0 inactive, 1 muted, 2 active)
  //   rec/sim  allowsRecording / playsInSilentMode   snd  loaded sounds
  //   rc/rr  route changes since launch / last reason (1 new device,
  //          2 device gone, 3 category change, 4 override, 8 config change)
  //   ib/ie  interruptions began/ended   ms  media services resets
  //   rp  drift repairs   ov  speaker overrides applied
  // Absent on builds without the patch (and in Expo Go), so optional.
  const AUDIO_STATE_KEYS = ["cat", "mode", "opt", "out", "in", "vol", "sr", "oth", "sil", "act", "en", "exav", "rec", "sim", "snd", "rc", "rr", "ib", "ie", "ms", "rp", "ov"];
  async function reportAudioState(tag: string) {
    try {
      const d = await ExponentAV.getAudioSessionDiagnostics?.();
      if (!d) return;
      const fmt = (v: any) =>
        typeof v === "boolean" ? (v ? 1 : 0)
        : typeof v === "number" && !Number.isInteger(v) ? v.toFixed(2)
        : v;
      reportClient("audio_state", [`t:${tag}`, ...AUDIO_STATE_KEYS.map(k => `${k}:${fmt(d[k])}`)].join(" "));
    } catch (e: any) {
      reportClient("audio_state_failed", String(e?.message ?? e));
    }
  }

  // Re-assert the iOS audio session after playback has gone silent.
  //
  // expo-av short-circuits setAudioModeAsync when the mode it is given equals
  // the one it already holds, so calling it with the SAME object after the
  // session has gone bad is a no-op and fixes nothing — which is why a
  // reconnect (whose audio loop calls exactly that) was a coin flip rather
  // than a cure, and why it sometimes took several. Toggling a field first
  // forces expo-av to push a real change down to AVAudioSession, which also
  // re-runs the patched category/mode/route setup in EXAV.m (#21/#41):
  // DefaultToSpeaker, .voiceChat and overrideOutputAudioPort.
  //
  // Serialised behind a flag: several bursts can fail at once, and stacking
  // session changes is its own way to break audio.
  async function recoverAudioSession() {
    if (recoveringAudioRef.current) return;
    recoveringAudioRef.current = true;
    try {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      reportClient("audio_session_recovered");
      reportAudioState("recovered");
    } catch (e: any) {
      reportClient("audio_session_recover_failed", String(e?.message ?? e));
      pushError("Audio stopped working — tap ✕ and reconnect");
    } finally {
      recoveringAudioRef.current = false;
    }
  }

  function pushError(text: string) {
    const id = Date.now() + Math.random();
    setErrors(prev => [...prev.slice(-2), { id, text }]);
  }

  function toggleMute(micOn: boolean) {
    setMuted(!micOn);
    mutedRef.current = !micOn;
  }

  async function startAudioLoop() {
    // loopRef is set BEFORE the fallible audio-session call. Previously this
    // ran after it, so a rejection here left the loop permanently un-started
    // with no error anywhere — the camera kept streaming frames while the mic
    // sent nothing for the entire session. Cloud Run logs showed this in 6 of
    // 21 sessions, including 103s/60s/51s ones with zero audio chunks.
    loopRef.current = true;
    const myEpoch = epochRef.current;
    // Configuring the session for recording can lose a race against playback
    // starting up (the greet reply arrives ~1.2s in, right as this runs at
    // ~1.5s) — retry rather than giving up on the microphone for good.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
        // Baseline for the session: what "configured" actually looks like
        // on this phone, to diff a silent turn's line against.
        reportAudioState("start");
        break;
      } catch (e) {
        if (attempt === 2) throw e;
        await new Promise(r => setTimeout(r, 400));
      }
    }
    while (loopRef.current && epochRef.current === myEpoch && socketRef.current?.ready) {
      if (!mutedRef.current) {
        const rec = new Audio.Recording();
        try {
          await rec.prepareToRecordAsync({ android: { extension: ".wav", outputFormat: Audio.AndroidOutputFormat.DEFAULT, audioEncoder: Audio.AndroidAudioEncoder.DEFAULT, sampleRate: 16000, numberOfChannels: 1, bitRate: 128000 }, ios: { extension: ".wav", audioQuality: Audio.IOSAudioQuality.LOW, sampleRate: 16000, numberOfChannels: 1, bitRate: 128000, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false }, web: {} });
          recordingRef.current = rec;
          await rec.startAsync();
          await new Promise(r => setTimeout(r, CHUNK_MS));
          await rec.stopAndUnloadAsync();
          const uri = rec.getURI();
          // Encode + send run off the loop's critical path so the mic comes
          // back up immediately instead of sitting idle through a network
          // round trip — that wait was the dominant chunk of dead-air in
          // each recording cycle and was audible as cutting in and out.
          // Drop the chunk entirely while Argus is speaking (see
          // argusSpeakingRef). Checked again after the encode as well as
          // before it, because a response can begin during the round trip and
          // a chunk landing then is exactly what aborts it. Skipping the
          // encode also keeps that work off the CPU, which is the binding
          // Cloud Run constraint on the other end.
          if (uri) {
            // Whether Argus's audio was actually coming out of the speaker
            // when this chunk was captured. The chunk is SENT either way —
            // the decision about whether it reaches Gemini now lives on the
            // server, where it can be retuned with an env var instead of a
            // build and a TestFlight round (see MIC_GATE_MODE in server.js).
            //
            // This used to drop the chunk outright, which killed the 1:1:1
            // self-interruption of #44 but left the user talking into a dead
            // microphone for the whole turn — a measured median 11.6s and p90
            // 23.9s of discarded speech (#59). Sending it and tagging it is
            // what lets the server measure what Argus's own voice reads as
            // through the mic, which is the number the gate design needs and
            // which nothing has ever sampled, because these were exactly the
            // chunks that were thrown away.
            const gatedAtCapture = argusIsSpeaking();
            getAudioB64(uri).then(b64 => {
              // Re-read at send time and take EITHER as gated. A response can
              // begin during the encode round trip, and a chunk captured
              // while Argus was speaking still carries his voice even if the
              // turn has ended by the time it goes out — so erring toward
              // "gated" keeps the echo sample honest in both directions.
              const gated = gatedAtCapture || argusIsSpeaking();
              if (epochRef.current === myEpoch && socketRef.current?.ready) socketRef.current.sendAudio(b64, gated);
            }).catch(() => {});
          }
        } catch (e) {
          try { await rec.stopAndUnloadAsync(); } catch {}
          // Both prepareToRecordAsync and stopAndUnloadAsync throw
          // synchronously, so a repeating failure would spin this loop on
          // microtasks alone and never yield — starving timers, the frame
          // loop and rendering. This forces a real macrotask yield.
          await new Promise(r => setTimeout(r, 250));
        }
      } else { await new Promise(r => setTimeout(r, 200)); }
    }
  }

  function stopAudio() { loopRef.current = false; try { recordingRef.current?.stopAndUnloadAsync(); } catch {} recordingRef.current = null; }

  // Muted mic means the user cannot be mid-question, so treat it as idle
  // regardless of recency.
  function nextFrameDelay() {
    if (mutedRef.current) return FRAME_MS_IDLE;
    const sinceActivity = Date.now() - lastActivityRef.current;
    return sinceActivity < FRAME_IDLE_AFTER_MS ? FRAME_MS : FRAME_MS_IDLE;
  }

  // Self-scheduling timeout rather than a fixed setInterval, so the cadence can
  // change between ticks (see FRAME_MS_IDLE). It also means a slow
  // takePictureAsync can't stack up overlapping captures the way a fixed
  // interval could — the next tick is only scheduled once this one finishes.
  function startFrameLoop() {
    stopFrameLoop();
    const myEpoch = epochRef.current;
    const tick = async () => {
      if (epochRef.current !== myEpoch) { stopFrameLoop(); return; }
      if (cameraRef.current && socketRef.current?.ready) {
        try {
          // takePictureAsync defaults shutterSound to true — with a real photo
          // capture firing every FRAME_MS for the whole session, that meant a
          // shutter click on every single frame, continuously, for as long as
          // the session stayed connected.
          const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.5, skipProcessing: true, shutterSound: false });
          if (photo?.base64 && socketRef.current?.ready) socketRef.current.sendImage(photo.base64);
        } catch (e) { /* camera transiently busy — skip this tick */ }
      }
      if (epochRef.current !== myEpoch) { stopFrameLoop(); return; }
      frameIntervalRef.current = setTimeout(tick, nextFrameDelay());
    };
    frameIntervalRef.current = setTimeout(tick, FRAME_MS);
  }

  function stopFrameLoop() { if (frameIntervalRef.current) { clearTimeout(frameIntervalRef.current); frameIntervalRef.current = null; } }

  function enqueueAudio(b64: string) {
    audioQueueRef.current.push(b64);
    playNextInQueue();
  }

  // Drains the queue into one merged WAV and loads it PAUSED — created
  // paused deliberately: with shouldPlay:true, a stopPlayback() landing
  // during the load left an already-playing sound nothing tracked while
  // isPlayingRef was false, so the next burst played on top of it (see the
  // #33 overlapping-audio bug). Returns null if nothing is queued or the
  // load was superseded mid-flight.
  //
  // Merging exists because Gemini streams audio in many small pieces;
  // playing each as its own Audio.Sound means a load gap at every chunk
  // boundary, which is audible as jitter/breakup.
  async function prepareBurst(): Promise<{ sound: Audio.Sound; expectedMs: number } | null> {
    if (audioQueueRef.current.length === 0) return null;
    // Take a bounded slice and LEAVE the rest queued, rather than draining
    // everything. Two reasons: it bounds the data: URI (see MAX_BURST_CHUNKS),
    // and it means a failure below can only ever put this slice at risk
    // instead of the whole response.
    // splitBurstRef is set when a burst failed to load: retry the same audio
    // in smaller pieces rather than at the size that just failed.
    const take = splitBurstRef.current > 0 ? Math.min(splitBurstRef.current, MAX_BURST_CHUNKS) : MAX_BURST_CHUNKS;
    const chunks = audioQueueRef.current.slice(0, take);
    audioQueueRef.current = audioQueueRef.current.slice(chunks.length);
    const myToken = playbackTokenRef.current;
    const pcmBytes = chunks.reduce((sum, b64) => sum + atob(b64).length, 0);
    const expectedMs = (pcmBytes / (24000 * 2)) * 1000; // 24kHz, 16-bit mono
    try {
      const wavB64 = pcmChunksToWavBase64(chunks, 24000);
      const loadStart = Date.now();
      const { sound } = await Audio.Sound.createAsync({ uri: `data:audio/wav;base64,${wavB64}` }, { shouldPlay: false });
      liveSoundsRef.current.add(sound);
      splitBurstRef.current = 0;
      // The burst-boundary cost #18/#44 flag. Visible in dev sessions so the
      // 100-300ms estimate finally gets real numbers.
      if (__DEV__) console.log(`[argus] burst load ${Date.now() - loadStart}ms for ${Math.round(expectedMs)}ms of audio`);
      if (playbackTokenRef.current !== myToken) { await unloadSound(sound); return null; }
      return { sound, expectedMs };
    } catch (e: any) {
      // This catch used to be `catch { return null; }` — and the queue was
      // already drained at the top of this function, so a failure here threw
      // away that audio permanently with no error, no log and no symptom
      // other than silence. It is the reason this bug class presents as
      // "Argus says Speaking, captions appear, nothing comes out" instead of
      // as an error.
      burstFailuresRef.current++;
      reportClient(
        "burst_load_failed",
        `n=${burstFailuresRef.current} chunks=${chunks.length} ms=${Math.round(expectedMs)} ${String(e?.message ?? e)}`,
      );
      // Do not throw the audio away. This is what turned a single decode
      // failure into a silent conversation: the queue was drained at the top
      // and the chunks vanished here with no error and no sound. Put them
      // back so the next attempt retries them — but split first, because a
      // burst that failed whole may succeed in halves, and a SINGLE chunk
      // that keeps failing must be dropped or it blocks the queue forever.
      if (chunks.length > 1) {
        audioQueueRef.current = chunks.concat(audioQueueRef.current);
        splitBurstRef.current = Math.max(1, Math.floor(chunks.length / 2));
      }
      if (burstFailuresRef.current >= 3) {
        // Windowed, not consecutive: an intermittent failure among successes
        // used to reset the counter and never warn. Cleared on connect.
        pushError("Audio playback is failing — tap ✕ and reconnect");
      }
      return null;
    }
  }

  async function playNextInQueue() {
    if (isPlayingRef.current) return;
    if (audioQueueRef.current.length === 0) return;
    isPlayingRef.current = true;
    const burst = await prepareBurst();
    if (!burst) { isPlayingRef.current = false; return; }
    startBurst(burst);
  }

  // Plays one prepared burst, and — the pipelining #44 called for — starts
  // loading the NEXT burst ~350ms before this one ends, so the handoff at
  // didJustFinish is a playAsync on an already-loaded sound instead of a
  // serial createAsync. The serial path paid that load (est. 100-300ms, see
  // the burst-load log) at every boundary, and a long answer is many bursts,
  // so the cost compounded on exactly the responses that already feel slow.
  function startBurst(burst: { sound: Audio.Sound; expectedMs: number }) {
    const myToken = playbackTokenRef.current;
    const { sound, expectedMs } = burst;
    // Never displace a still-loaded sound without unloading it. The old code
    // assigned straight over soundRef, which is how a raced burst became an
    // untrackable, unstoppable native player (see liveSoundsRef).
    const displaced = soundRef.current;
    if (displaced && displaced !== sound) unloadSound(displaced);
    soundRef.current = sound;
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    // Furthest the playhead actually reached. A burst that reports finishing
    // without this ever moving was never rendered — the app looks alive and
    // produces nothing, which is the failure mode that survives reconnects
    // and that neither the load-error path nor the watchdog can see.
    let maxPosition = 0;
    // Safety net for a stuck burst: if an OS audio-session interruption (a
    // call, Siri, another app) unloads the sound without ever firing
    // didJustFinish, isPlayingRef previously stayed true forever and every
    // later burst piled up unplayed — reads as "Argus stopped mid-response."
    const finishPlayback = () => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      // A superseded burst must not resurrect the queue stopPlayback() just
      // cleared, or reset a flag a newer burst now owns.
      if (playbackTokenRef.current !== myToken) return;
      // Silent playback: the sound loaded and completed, but nothing ever
      // came out. Recover rather than carrying on pretending — the audio
      // session is what is broken, and re-asserting it is the only thing on
      // this side that can fix it.
      //
      // Strictly AFTER the token check. A barge-in cuts a burst off early and
      // legitimately leaves the playhead near zero, so checking before this
      // point would fire a session recovery on every interruption — a healthy
      // event treated as a fault.
      if (expectedMs > 250 && maxPosition < SILENT_BURST_POSITION_MS) {
        reportClient("burst_silent", `expected ${Math.round(expectedMs)}ms position ${maxPosition}ms`);
        recoverAudioSession();
      }
      // Seamless handoff if the next burst is already loaded.
      const next = nextBurstRef.current;
      nextBurstRef.current = null;
      if (next) { startBurst(next); return; }
      isPlayingRef.current = false;
      playNextInQueue();
    };
    (async () => {
      try {
        watchdog = setTimeout(() => {
          // Reported, not just recovered. A burst that never reports finishing
          // means playAsync succeeded while nothing audible happened — the
          // signature of an audio-session problem rather than a decode one,
          // and previously indistinguishable from it in a release build.
          reportClient("burst_watchdog", `expected ${Math.round(expectedMs)}ms`);
          unloadSound(sound);
          finishPlayback();
        }, Math.max(6000, expectedMs * 2 + 5000));
        sound.setOnPlaybackStatusUpdate((st) => {
          if (!st.isLoaded) { liveSoundsRef.current.delete(sound); finishPlayback(); return; }
          if (st.positionMillis > maxPosition) maxPosition = st.positionMillis;
          if (st.didJustFinish) { unloadSound(sound); finishPlayback(); }
        });
        await sound.playAsync();
        if (prepareTimerRef.current) clearTimeout(prepareTimerRef.current);
        prepareTimerRef.current = setTimeout(async () => {
          prepareTimerRef.current = null;
          if (playbackTokenRef.current !== myToken || nextBurstRef.current) return;
          const next = await prepareBurst();
          if (!next) return;
          if (playbackTokenRef.current !== myToken) { await unloadSound(next.sound); return; }
          // The current burst can finish while the next was still loading —
          // its finish handler then finds nothing prepared AND an
          // already-drained queue, so the loaded audio would never play
          // unless it is started directly here.
          //
          // The test used to be `settled || !isPlayingRef.current`, and the
          // `settled` half was the bug. Between this burst finishing and
          // prepareBurst resolving, an arriving chunk can call enqueueAudio ->
          // playNextInQueue and start a burst of its own. `settled` is true by
          // then, so this path started a SECOND burst concurrently and
          // overwrote soundRef — two sounds playing, one of them orphaned and
          // unstoppable. Short bursts make the window routine: expectedMs for
          // a single ~180ms chunk clamps the timer below to 0ms, so this runs
          // immediately after playAsync.
          //
          // isPlayingRef alone is the correct test: finishPlayback clears it
          // exactly when nothing else has taken over, and leaves it set when
          // something has.
          if (!isPlayingRef.current) {
            isPlayingRef.current = true;
            startBurst(next);
          } else if (!nextBurstRef.current) {
            nextBurstRef.current = next;
          } else {
            await unloadSound(next.sound);
          }
        }, Math.max(0, expectedMs - 350));
      } catch (e) {
        finishPlayback();
      }
    })();
  }

  // Ramps a sound down before unloading it. Detached from soundRef by the
  // caller first, so it owns this sound outright and a newer burst can take
  // over soundRef immediately without waiting on the ramp.
  function fadeOutAndUnload(sound: Audio.Sound) {
    (async () => {
      try {
        for (let i = FADE_STEPS - 1; i >= 0; i--) {
          await sound.setVolumeAsync(i / FADE_STEPS);
          await new Promise(r => setTimeout(r, FADE_MS / FADE_STEPS));
        }
      } catch { /* sound already gone — unload below is still safe */ }
      await unloadSound(sound);
    })();
  }

  // fade is for barge-in, where the audio is being abandoned mid-sentence and
  // a hard cut is audible as a click. Teardown paths (disconnect, screen exit,
  // superseded session) pass nothing and stop instantly — there is no one left
  // to hear a graceful ending, and a 120ms tail would outlive the session.
  function stopPlayback(opts?: { fade?: boolean }) {
    // Invalidates any burst currently mid-load so it unloads itself instead of
    // starting playback after this call.
    playbackTokenRef.current++;
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    // A preloaded next burst belongs to the response being abandoned — on a
    // barge-in it is exactly the audio that must NOT play. Cut it instantly
    // (never faded: it hasn't started, so there is nothing to trail off).
    if (prepareTimerRef.current) { clearTimeout(prepareTimerRef.current); prepareTimerRef.current = null; }
    const preloaded = nextBurstRef.current;
    nextBurstRef.current = null;
    if (preloaded) unloadSound(preloaded.sound);
    const snd = soundRef.current;
    soundRef.current = null;
    if (snd) {
      if (opts?.fade) fadeOutAndUnload(snd);
      else unloadSound(snd);
    }
    // Anything still loaded that the two slots above did not account for.
    // Normally empty; if it is not, a burst was orphaned and this is the only
    // thing that can free it — which is what makes a disconnect/reconnect a
    // real recovery instead of a coin flip.
    for (const s of Array.from(liveSoundsRef.current)) {
      if (s !== snd) unloadSound(s);
    }
  }

  useEffect(() => {
    getStoredUser().then(u => { if (!u) router.replace("/sign-in"); else setUser(u); });
    // Leaving the screen must stop the capture loops and playback — otherwise
    // they keep running against a socket nothing owns any more.
    return () => { const sock = socketRef.current; teardownSession(); sock?.disconnect(); };
  }, []);

  useEffect(() => {
    // "heard" is included so a heard ack whose response never arrives still
    // degrades into the waiting hints instead of pinning "Heard you" forever.
    if (status !== "observing" && status !== "heard") { setThinkingHint(null); return; }
    const iv = setInterval(() => {
      const elapsed = Date.now() - lastActivityRef.current;
      if (elapsed > 8000) setThinkingHint("Taking a bit longer than usual, still here...");
      else if (elapsed > 3500) setThinkingHint("Still thinking...");
      else setThinkingHint(null);
    }, 1000);
    return () => clearInterval(iv);
  }, [status]);

  async function connect() {
    if (!user) return;
    if (!camPerm?.granted) await requestCam();
    // Make sure the microphone is actually granted before a session starts —
    // this used to be fired once on mount with its result ignored.
    const mic = await Audio.requestPermissionsAsync();
    if (!mic.granted) { pushError("Microphone access is off — enable it in Settings"); setStatus("error"); return; }
    setStatus("connecting");
    const myEpoch = ++epochRef.current;
    // Mute is a PER-SESSION control and must be reset here. It used to carry
    // over: `muted` is React state on a component that stays mounted across
    // disconnect -> reconnect, while the Switch that sets it is only rendered
    // `connected ? ... : null` — so muting, tapping ✕, then tapping ◉ again
    // came back muted with the only affordance having been unmounted in
    // between. The audio loop then took its `else` branch every iteration
    // (sleep 200ms, record nothing, send nothing) for the whole session while
    // camera frames, the greeting and the "Observing" badge all carried on
    // normally: zero mic chunks, no error, nothing in the logs. Because the
    // state lives on the mounted component, reconnecting could never clear it
    // and only killing the app would — which is exactly how it was reported.
    // Confirmed in production: two sessions from one tester (2026-08-15 and
    // 2026-09-01) held IDLE frame cadence while Argus was actively streaming
    // audio, which nextFrameDelay() only does when mutedRef is true; the 183s
    // one sent zero mic chunks start to finish.
    setMuted(false);
    mutedRef.current = false;
    // Per-session playback health. Counting these across sessions would mean
    // a reconnect inherits the previous session's failures.
    burstFailuresRef.current = 0;
    splitBurstRef.current = 0;
    const sock = new ArgusSocket(handleMsg, user.id, user.name, myEpoch);
    socketRef.current = sock;
    sock.connect();
    audioStartTimerRef.current = setTimeout(() => {
      if (epochRef.current !== myEpoch) return;
      // startAudioLoop is async and was previously called with no .catch() —
      // a rejection was an unobserved promise, silently costing the whole
      // session's microphone with nothing shown to the user.
      startAudioLoop().catch(err => {
        console.warn("[argus] audio loop failed to start:", err?.message ?? err);
        pushError("Microphone unavailable — tap ✕ and reconnect");
      });
      startFrameLoop();
    }, 1500);
    // Belt-and-suspenders: ArgusSocket's onerror/onclose usually fire on a bad
    // connection, but a silently stalled OS-level socket attempt (bad network,
    // blocked egress) could otherwise leave the UI on "Connecting" indefinitely.
    clearConnectTimeout();
    connectTimeoutRef.current = setTimeout(() => {
      if (epochRef.current === myEpoch) {
        disconnect();
        pushError("Couldn't reach Argus — check your connection and try again");
        setStatus("error");
      }
    }, CONNECT_TIMEOUT_MS);
  }

  function disconnect() {
    const sock = socketRef.current;
    teardownSession();
    sock?.disconnect();
    setStatus("dormant");
  }

  function flipCamera() { setFacing(f => (f === "back" ? "front" : "back")); }

  function confirmDeleteData() {
    if (!user || deletingData) return;
    Alert.alert(
      "Delete my data",
      "This permanently deletes everything Argus remembers about you. This can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: async () => {
          setDeletingData(true);
          try {
            disconnect();
            const ok = await deleteAccount(user.id);
            if (ok) { router.replace("/sign-in"); return; }
            Alert.alert("Couldn't delete data", "Something went wrong. Check your connection and try again.");
          } catch {
            // Any unexpected throw here (network, storage, etc.) must still
            // surface something — a silent failure previously left the UI
            // looking unresponsive with no error and no navigation.
            Alert.alert("Couldn't delete data", "Something went wrong. Check your connection and try again.");
          } finally {
            setDeletingData(false);
          }
        } },
      ]
    );
  }

  const connected = status !== "dormant" && status !== "error";
  const statusLabel: Record<Status,string> = { dormant:"Dormant", connecting:"Connecting", observing:"Observing", heard:"Heard you", speaking:"Speaking", error:"Error" };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <Text style={s.logo}>◉ ARGUS</Text>
        <View style={s.headerActions}>
          <TouchableOpacity onPress={confirmDeleteData} disabled={deletingData}>
            <Text style={s.deleteData}>{deletingData ? "Deleting…" : "Delete my data"}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push("/(main)/settings")}>
            <Text style={s.settingsIcon}>⚙</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={async () => { disconnect(); await signOut(); router.replace("/sign-in"); }}>
            <Text style={s.signOut}>Sign out</Text>
          </TouchableOpacity>
        </View>
      </View>
      <View style={s.cameraWrap}>
        {connected && camPerm?.granted ? (
          <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing={facing} />
        ) : (
          <View style={[StyleSheet.absoluteFill, s.camPlaceholder]}><Text style={s.eyeIcon}>◉</Text><Text style={s.dormantTxt}>Tap to awaken Argus</Text></View>
        )}
        <View style={s.badgeFloating}><Text style={[s.badgeTxt, status==="speaking" && {color:"#4a6fa5"}, connected && muted && s.badgeTxtMuted]}>{connected && muted ? "Mic muted — tap Mic to talk" : (thinkingHint || statusLabel[status])}</Text></View>
        {errors.length > 0 && (
          <View style={s.errorStack} pointerEvents="none">
            {errors.map(e => <ErrorToast key={e.id} text={e.text} onDone={() => setErrors(prev => prev.filter(x => x.id !== e.id))} />)}
          </View>
        )}
        {captionsEnabled && lines.length > 0 && (
          <View style={s.transcriptOverlay}>
            <ScrollView ref={scrollRef} contentContainerStyle={{padding:16}}>
              {lines.map((l,i) => (
                <Text key={i} style={[s.line, l.role==="argus" && s.lineArgus]}>
                  {l.role==="argus" ? "◉ " : ""}{l.text}
                </Text>
              ))}
            </ScrollView>
          </View>
        )}
        {toolStatus && (
          <View style={s.toolStatusFloating} pointerEvents="none">
            <Text style={s.toolStatusTxt}>{toolStatus}</Text>
          </View>
        )}
      </View>
      <View style={s.controls}>
        {connected ? (
          <TouchableOpacity style={s.flipBtn} onPress={flipCamera}>
            <Text style={s.flipBtnTxt}>⟲</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity style={[s.connectBtn, connected && s.connectBtnActive]} onPress={connected ? disconnect : connect}>
          <Text style={s.connectBtnTxt}>{connected ? "✕" : "◉"}</Text>
        </TouchableOpacity>
        {connected ? (
          <View style={s.muteWrap}>
            <Switch
              value={!muted}
              onValueChange={toggleMute}
              trackColor={{ false: "#3a3a44", true: "#c9a84c" }}
              thumbColor="#e8e0d0"
              ios_backgroundColor="#3a3a44"
            />
            <Text style={s.muteLabel}>Mic</Text>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  safe:{flex:1,backgroundColor:"#08080c"},
  header:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",paddingHorizontal:20,paddingTop:8,paddingBottom:12},
  logo:{color:"#c9a84c",fontSize:18,fontWeight:"700",letterSpacing:4},
  headerActions:{flexDirection:"row",alignItems:"center",gap:14},
  settingsIcon:{color:"#9e978a",fontSize:16},
  deleteData:{color:"#c44a3f",fontSize:11},
  signOut:{color:"#9e978a",fontSize:12},
  cameraWrap:{flex:1,backgroundColor:"#111118"},
  camPlaceholder:{alignItems:"center",justifyContent:"center",backgroundColor:"#111118"},
  eyeIcon:{fontSize:80,color:"#c9a84c",opacity:0.3},
  dormantTxt:{color:"#9e978a",marginTop:12,fontSize:13},
  badgeFloating:{position:"absolute",top:14,alignSelf:"center",backgroundColor:"rgba(8,8,12,0.6)",paddingHorizontal:14,paddingVertical:6,borderRadius:14},
  badgeTxt:{color:"#c9a84c",fontSize:11,letterSpacing:3,textTransform:"uppercase"},
  // Deliberately the error red, not the normal gold: a muted session is
  // indistinguishable from a working one otherwise — frames stream, Argus
  // greets you, the badge says "Observing" — and that is what made this cost
  // whole sessions before anyone suspected the switch.
  badgeTxtMuted:{color:"#c44a3f"},
  errorStack:{position:"absolute",top:56,left:16,right:16,alignItems:"center",gap:8},
  errorToast:{backgroundColor:"rgba(196,74,63,0.92)",paddingHorizontal:16,paddingVertical:10,borderRadius:12,maxWidth:"100%"},
  errorToastTxt:{color:"#fff",fontSize:13,textAlign:"center"},
  transcriptOverlay:{position:"absolute",left:0,right:0,bottom:0,maxHeight:"45%",backgroundColor:"rgba(8,8,12,0.78)"},
  line:{fontSize:14,color:"#9e978a",marginBottom:6,lineHeight:22},
  lineArgus:{color:"#c9a84c"},
  toolStatusFloating:{position:"absolute",bottom:16,left:16,backgroundColor:"rgba(8,8,12,0.75)",paddingHorizontal:12,paddingVertical:7,borderRadius:12,maxWidth:"70%"},
  toolStatusTxt:{color:"#c9a84c",fontSize:12,letterSpacing:0.3},
  controls:{flexDirection:"row",justifyContent:"center",alignItems:"center",gap:20,paddingVertical:24},
  connectBtn:{width:64,height:64,borderRadius:32,borderWidth:2,borderColor:"#c9a84c",alignItems:"center",justifyContent:"center"},
  connectBtnActive:{backgroundColor:"#1a1408"},
  connectBtnTxt:{color:"#c9a84c",fontSize:24},
  muteWrap:{alignItems:"center",justifyContent:"center"},
  muteLabel:{color:"#9e978a",fontSize:10,marginTop:4,letterSpacing:1,textTransform:"uppercase"},
  flipBtn:{width:48,height:48,borderRadius:24,borderWidth:2,borderColor:"#3a3a44",alignItems:"center",justifyContent:"center"},
  flipBtnTxt:{color:"#9e978a",fontSize:20},
});

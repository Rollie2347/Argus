import { useState, useEffect, useRef } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, SafeAreaView, Alert, Switch, Animated } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Audio } from "expo-av";
import { router } from "expo-router";
import { getStoredUser, signOut, deleteAccount } from "../../services/auth";
import { ArgusSocket } from "../../services/websocket";
import { useCaptions } from "../../contexts/CaptionsContext";
import type { User } from "../../services/auth";

type Status = "dormant"|"connecting"|"observing"|"speaking"|"error";
type Line = { text: string; role: "argus"|"user"|"tool" };

const CHUNK_MS = 1000;
const FRAME_MS = 2000;
const AUDIO_GAIN = 1.6;
const CONNECT_TIMEOUT_MS = 12000;

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
  web_search: "Searching the web",
  get_restaurant_website: "Finding the restaurant's website",
};

async function getAudioB64(uri: string): Promise<string> {
  const r = await fetch(uri);
  const buf = await r.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}

// Gemini sends raw PCM16 mono @ 24kHz in many small chunks; expo-av can only
// load audio files/URIs, not append to an already-playing one, so each
// playable unit needs its own WAV header. Chunks are merged (see
// pcmChunksToWavBase64) before wrapping instead of wrapping one at a time, to
// avoid a Sound-object load/gap at every chunk boundary.
function pcmChunksToWavBase64(pcmB64Chunks: string[], sampleRate: number): string {
  const pcmBins = pcmB64Chunks.map(atob);
  const pcmLen = pcmBins.reduce((sum, bin) => sum + bin.length, 0);
  const headerLen = 44;
  const buf = new ArrayBuffer(headerLen + pcmLen);
  const view = new DataView(buf);
  const writeStr = (offset: number, str: string) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcmLen, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, pcmLen, true);

  const bytes = new Uint8Array(buf);
  let offset = headerLen;
  for (const bin of pcmBins) {
    for (let i = 0; i < bin.length; i++) bytes[offset + i] = bin.charCodeAt(i);
    offset += bin.length;
  }
  // Gemini's output level plus iOS's playAndRecord routing (see home.tsx's
  // volume note) both leave played-back audio quieter than expected — apply a
  // digital gain with clamping so int16 samples don't wrap on overflow.
  for (let i = headerLen; i < buf.byteLength - 1; i += 2) {
    const sample = view.getInt16(i, true);
    const boosted = Math.max(-32768, Math.min(32767, Math.round(sample * AUDIO_GAIN)));
    view.setInt16(i, boosted, true);
  }

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
  const frameIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
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
  const audioStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playbackTokenRef = useRef(0);

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
    else if (msg.type === "audio") { setStatus("speaking"); enqueueAudio(msg.data); }
    else if (msg.type === "turn_complete") { setStatus("observing"); clearToolStatus(); }
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
          // each ~1s cycle and was audible as cutting in and out.
          if (uri) {
            // Re-read the current socket at send time rather than sending to a
            // captured one: a captured socket could still be OPEN after the app
            // moved to a new session, delivering this chunk into the old Gemini
            // session, whose reply then played over the live session's audio.
            getAudioB64(uri).then(b64 => {
              if (epochRef.current === myEpoch && socketRef.current?.ready) socketRef.current.sendAudio(b64);
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

  function startFrameLoop() {
    stopFrameLoop();
    const myEpoch = epochRef.current;
    frameIntervalRef.current = setInterval(async () => {
      if (epochRef.current !== myEpoch) { stopFrameLoop(); return; }
      if (!cameraRef.current || !socketRef.current?.ready) return;
      try {
        // takePictureAsync defaults shutterSound to true — with a real photo
        // capture firing every FRAME_MS for the whole session, that meant a
        // shutter click on every single frame, continuously, for as long as
        // the session stayed connected.
        const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.5, skipProcessing: true, shutterSound: false });
        if (photo?.base64 && socketRef.current?.ready) socketRef.current.sendImage(photo.base64);
      } catch (e) { /* camera transiently busy — skip this tick */ }
    }, FRAME_MS);
  }

  function stopFrameLoop() { if (frameIntervalRef.current) { clearInterval(frameIntervalRef.current); frameIntervalRef.current = null; } }

  function enqueueAudio(b64: string) {
    audioQueueRef.current.push(b64);
    playNextInQueue();
  }

  async function playNextInQueue() {
    if (isPlayingRef.current) return;
    if (audioQueueRef.current.length === 0) return;
    // Drain everything that's arrived since the last chunk started playing and
    // merge it into one WAV. Gemini streams audio in many small pieces; playing
    // each one as its own Audio.Sound means a load/gap at every chunk boundary,
    // which is what causes audible jitter/breakup — merging cuts the number of
    // those boundaries down to roughly one per playback burst.
    const chunks = audioQueueRef.current;
    audioQueueRef.current = [];
    isPlayingRef.current = true;
    const myToken = playbackTokenRef.current;
    const pcmBytes = chunks.reduce((sum, b64) => sum + atob(b64).length, 0);
    const expectedMs = (pcmBytes / (24000 * 2)) * 1000; // 24kHz, 16-bit mono
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    // Safety net for a stuck queue: if an OS audio-session interruption (a
    // call, Siri, another app) unloads the sound without ever firing
    // didJustFinish, isPlayingRef previously stayed true forever and every
    // later burst just piled up in the queue with nothing ever playing again
    // — reads to the user as "Argus stopped mid-response." Force-advance
    // after a generous multiple of the clip's own expected duration.
    const finishPlayback = () => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      // A superseded burst must not resurrect the queue stopPlayback() just
      // cleared, or reset a flag a newer burst now owns.
      if (playbackTokenRef.current !== myToken) return;
      isPlayingRef.current = false;
      playNextInQueue();
    };
    try {
      const wavB64 = pcmChunksToWavBase64(chunks, 24000);
      // Created paused, then started only if this burst is still current.
      // With shouldPlay:true, a stopPlayback() landing during this await left
      // an already-playing sound that nothing tracked (soundRef had been
      // cleared) while isPlayingRef was reset to false — so the next burst
      // started a second sound on top of it. That was Argus talking over
      // itself, and neither sound could be stopped.
      const { sound } = await Audio.Sound.createAsync({ uri: `data:audio/wav;base64,${wavB64}` }, { shouldPlay: false });
      if (playbackTokenRef.current !== myToken) { try { await sound.unloadAsync(); } catch {} return; }
      soundRef.current = sound;
      watchdog = setTimeout(() => {
        try { sound.unloadAsync(); } catch {}
        finishPlayback();
      }, Math.max(6000, expectedMs * 2 + 5000));
      sound.setOnPlaybackStatusUpdate((st) => {
        if (!st.isLoaded) { finishPlayback(); return; }
        if (st.didJustFinish) { sound.unloadAsync(); finishPlayback(); }
      });
      await sound.playAsync();
    } catch (e) {
      finishPlayback();
    }
  }

  function stopPlayback() {
    // Invalidates any burst currently mid-load so it unloads itself instead of
    // starting playback after this call.
    playbackTokenRef.current++;
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    if (soundRef.current) { try { soundRef.current.unloadAsync(); } catch {} soundRef.current = null; }
  }

  useEffect(() => {
    getStoredUser().then(u => { if (!u) router.replace("/sign-in"); else setUser(u); });
    // Leaving the screen must stop the capture loops and playback — otherwise
    // they keep running against a socket nothing owns any more.
    return () => { const sock = socketRef.current; teardownSession(); sock?.disconnect(); };
  }, []);

  useEffect(() => {
    if (status !== "observing") { setThinkingHint(null); return; }
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
    mutedRef.current = muted;
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
  const statusLabel: Record<Status,string> = { dormant:"Dormant", connecting:"Connecting", observing:"Observing", speaking:"Speaking", error:"Error" };

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
        <View style={s.badgeFloating}><Text style={[s.badgeTxt, status==="speaking" && {color:"#4a6fa5"}]}>{thinkingHint || statusLabel[status]}</Text></View>
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

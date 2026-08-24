import { useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView, ScrollView } from "react-native";
import { Audio } from "expo-av";
import { router } from "expo-router";
import { BACKEND } from "../../services/websocket";
import { pcmChunksToWavBase64, DEFAULT_GAIN } from "../../services/audioGain";

/**
 * Audio A/B harness.
 *
 * Every previous round of the muffled-voice investigation changed one variable,
 * shipped a build, and asked "does it still sound muffled?" — six builds, no
 * answer, and at least one result (build 41's "removed VoiceChat, still
 * muffled") that turned out to be confounded by a second broken variable.
 *
 * This plays the SAME known-clean file under each candidate configuration,
 * back to back, inside one build. The file is frontend/reference-audio.wav —
 * the exact PCM the backend probe captured from Gemini and measured as
 * full-bandwidth (spectral centroid 2580 Hz, 10.1% of energy above 8 kHz).
 * It already sounds clear in mobile Safari on this same phone and speaker,
 * so anything that sounds worse here is this app's playback path, not the
 * model, the network, or the file.
 *
 * The browser diagnostic already ruled out the leading theory: the hardware
 * sample rate does NOT drop when the mic is held. So the remaining suspects
 * are what iOS does to the signal at an unchanged rate, and what expo-av's
 * own decode path does to it.
 */

const REF_URL = `${BACKEND}/reference-audio.wav`;

type Result = { label: string; detail: string };

export default function AudioTest() {
  const [running, setRunning] = useState<string | null>(null);
  const [log, setLog] = useState<Result[]>([]);
  const soundRef = useRef<Audio.Sound | null>(null);
  const recRef = useRef<Audio.Recording | null>(null);

  function note(label: string, detail: string) {
    setLog((prev) => [...prev, { label, detail }]);
  }

  async function cleanup() {
    if (soundRef.current) {
      try { await soundRef.current.unloadAsync(); } catch {}
      soundRef.current = null;
    }
    if (recRef.current) {
      try { await recRef.current.stopAndUnloadAsync(); } catch {}
      recRef.current = null;
    }
  }

  // Merely selecting .playAndRecord is not the same as actually recording:
  // iOS engages the voice-processing I/O chain when the input is live. Test A
  // has to hold a real recording open while the file plays, or it isn't
  // reproducing what a session actually does.
  async function startDummyRecording() {
    const rec = new Audio.Recording();
    await rec.prepareToRecordAsync({
      android: { extension: ".wav", outputFormat: Audio.AndroidOutputFormat.DEFAULT, audioEncoder: Audio.AndroidAudioEncoder.DEFAULT, sampleRate: 16000, numberOfChannels: 1, bitRate: 128000 },
      ios: { extension: ".wav", audioQuality: Audio.IOSAudioQuality.LOW, sampleRate: 16000, numberOfChannels: 1, bitRate: 128000, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false },
      web: {},
    });
    recRef.current = rec;
    await rec.startAsync();
  }

  // Returns how long createAsync took. Every real playback burst pays this,
  // so it is a per-turn latency term, not just a startup cost — and it has
  // never been measured. Measured response latency is a median 1859ms
  // (n=32, Cloud Run logs), and this decode sits inside that budget.
  async function playAndWait(uri: string) {
    const loadStart = Date.now();
    const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: false });
    const loadMs = Date.now() - loadStart;
    note("  ", `load ${loadMs}ms`);
    soundRef.current = sound;
    await sound.setVolumeAsync(1.0);
    await sound.playAsync();
    await new Promise<void>((resolve) => {
      sound.setOnPlaybackStatusUpdate((st) => {
        if (!st.isLoaded || st.didJustFinish) resolve();
      });
      // Never hang the harness on a sound that stops reporting.
      setTimeout(resolve, 15000);
    });
  }

  async function run(id: string, fn: () => Promise<void>) {
    if (running) return;
    setRunning(id);
    try {
      await fn();
    } catch (e: any) {
      note(id, `FAILED: ${e?.message ?? String(e)}`);
    } finally {
      await cleanup();
      setRunning(null);
    }
  }

  // A — exactly what a live session does today.
  const testA = () => run("A", async () => {
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    await startDummyRecording();
    note("A", "playAndRecord + VoiceChat, mic live");
    await playAndWait(REF_URL);
  });

  // Round 1's test B (same category, mic idle) is dropped — A and B both came
  // back clear, so "is it the live recording" is already answered.

  // C — the Safari-equivalent configuration. With the mode-reset fix in
  // patches/expo-av+16.0.8.patch this now genuinely lands on .playback +
  // AVAudioSessionModeDefault; before that fix the session kept VoiceChat
  // mode here, which is why toggling the mic off never sounded different.
  const testC = () => run("C", async () => {
    await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
    note("C", "playback + Default mode (Safari-equivalent)");
    await playAndWait(REF_URL);
  });

  // D — same session as C, but routed through the data: URI that real
  // playback uses. Isolates expo-av's decode path from the audio session.
  const testD = () => run("D", async () => {
    await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
    const res = await fetch(REF_URL);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    note("D", `playback + Default, data: URI (${Math.round(buf.byteLength / 1024)} KB)`);
    await playAndWait(`data:audio/wav;base64,${btoa(bin)}`);
  });

  // Round 2. Tests A-D all came back CLEAR while the real app was still
  // muffled, which exonerated the audio session and the decode path entirely —
  // and exposed the flaw in round 1: the reference clip was played untouched,
  // while real playback runs every sample through the gain transform first.
  // The gain was the one variable the harness held constant. These play the
  // SAME clip through the SAME code path real playback uses, varying only the
  // gain, so whichever one sounds clean is the value to ship.
  const gainTest = (gain: number) => () => run(`G${gain}`, async () => {
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    await startDummyRecording();
    const res = await fetch(REF_URL);
    const raw = new Uint8Array(await res.arrayBuffer());
    // Strip the 44-byte WAV header to recover the PCM, then re-wrap it exactly
    // the way a live response is wrapped.
    let pcmBin = "";
    for (let i = 44; i < raw.length; i++) pcmBin += String.fromCharCode(raw[i]);
    const wav = pcmChunksToWavBase64([btoa(pcmBin)], 24000, gain);
    note(`gain ${gain}`, gain === 5.0 ? "the old value — expected muffled" : gain === DEFAULT_GAIN ? "the new default" : "");
    await playAndWait(`data:audio/wav;base64,${wav}`);
  });

  const TESTS = [
    { id: "G1", title: "1 — Gain 1.0 (untouched)", sub: "No gain at all. The cleanest possible reference.", fn: gainTest(1.0) },
    { id: `G${DEFAULT_GAIN}`, title: `2 — Gain ${DEFAULT_GAIN} (new default)`, sub: "Near-unity, dynamics preserved. Should sound like #1 but a touch louder.", fn: gainTest(DEFAULT_GAIN) },
    { id: "G1.5", title: "3 — Gain 1.5", sub: "Louder still, slight peak limiting. Use if 2 is too quiet.", fn: gainTest(1.5) },
    { id: "G5", title: "4 — Gain 5.0 (what shipped)", sub: "The old value. If this is the muffling, it will be obvious here.", fn: gainTest(5.0) },
    { id: "A", title: "A — Mic session, mic live", sub: "Round 1 control, no gain. Came back clear.", fn: testA },
    { id: "C", title: "C — Playback session", sub: "Round 1 control, no gain. Came back clear.", fn: testC },
    { id: "D", title: "D — Playback session, data: URI", sub: "Round 1 control, no gain. Came back clear.", fn: testD },
  ];

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()}><Text style={s.back}>‹ Back</Text></TouchableOpacity>
        <Text style={s.title}>Audio A/B</Text>
        <View style={{ width: 60 }} />
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Text style={s.intro}>
          Tests 1-4 play the same clip at different playback gains, through the exact
          code a live response goes through. Pick the loudest one that still sounds
          clean — that is the value that ships. A/C/D below are the round-1 controls
          and should all still sound clear.
        </Text>
        {TESTS.map((t) => (
          <TouchableOpacity
            key={t.id}
            style={[s.testBtn, running === t.id && s.testBtnActive]}
            onPress={t.fn}
            disabled={!!running}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.testTitle}>{t.title}</Text>
              <Text style={s.testSub}>{t.sub}</Text>
            </View>
            <Text style={s.testPlay}>{running === t.id ? "▶" : "▷"}</Text>
          </TouchableOpacity>
        ))}
        {log.length > 0 && (
          <View style={s.logBox}>
            {log.map((l, i) => (
              <Text key={i} style={s.logLine}>
                <Text style={s.logLabel}>{l.label}</Text>  {l.detail}
              </Text>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#08080c" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16 },
  back: { color: "#c9a84c", fontSize: 15 },
  title: { color: "#e8e0d0", fontSize: 16, fontWeight: "700", letterSpacing: 1 },
  intro: { color: "#9e978a", fontSize: 13, lineHeight: 20, paddingHorizontal: 20, paddingBottom: 18 },
  testBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 16, borderTopWidth: StyleSheet.hairlineWidth, borderColor: "#2a2a32", gap: 16 },
  testBtnActive: { backgroundColor: "#1a1408" },
  testTitle: { color: "#e8e0d0", fontSize: 15 },
  testSub: { color: "#9e978a", fontSize: 12, marginTop: 4 },
  testPlay: { color: "#c9a84c", fontSize: 20 },
  logBox: { margin: 20, padding: 14, borderRadius: 6, backgroundColor: "#111118" },
  logLine: { color: "#9e978a", fontSize: 12, lineHeight: 20 },
  logLabel: { color: "#c9a84c", fontWeight: "700" },
});

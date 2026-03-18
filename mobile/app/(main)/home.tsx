import { useState, useEffect, useRef } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, SafeAreaView } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Audio } from "expo-av";
import { router } from "expo-router";
import { getStoredUser, signOut, getAccessToken } from "../../services/auth";
import { ArgusSocket } from "../../services/websocket";
import { fetchUnreadEmails } from "../../services/gmail";
import type { User } from "../../services/auth";

type Status = "dormant"|"connecting"|"observing"|"speaking"|"error";
type Line = { text: string; role: "argus"|"user"|"tool" };

export default function Home() {
  const [user, setUser] = useState<User|null>(null);
  const [status, setStatus] = useState<Status>("dormant");
  const [lines, setLines] = useState<Line[]>([]);
  const [muted, setMuted] = useState(false);
  const [camPerm, requestCam] = useCameraPermissions();
  const socketRef = useRef<ArgusSocket|null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const recordingRef = useRef<Audio.Recording|null>(null);

  function addLine(text: string, role: Line["role"]) {
    setLines(prev => [...prev.slice(-20), { text, role }]);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }

  useEffect(() => {
    getStoredUser().then(u => { if (!u) router.replace("/sign-in"); else setUser(u); });
    Audio.requestPermissionsAsync();
  }, []);

  function handleMsg(msg: any) {
    if (msg.type === "connected") setStatus("observing");
    else if (msg.type === "text") addLine(msg.data, "argus");
    else if (msg.type === "tool_event") addLine(msg.tool, "tool");
    else if (msg.type === "turn_complete") setStatus("observing");
    else if (msg.type === "speaking") setStatus("speaking");
    else if (msg.type === "disconnected") { setStatus("dormant"); socketRef.current = null; }
    else if (msg.type === "error") { addLine(msg.data, "argus"); setStatus("error"); }
  }

  async function connect() {
    if (!user) return;
    if (!camPerm?.granted) await requestCam();
    setStatus("connecting");
    const sock = new ArgusSocket(handleMsg, user.id, user.name);
    socketRef.current = sock;
    sock.connect();
  }

  function disconnect() {
    socketRef.current?.disconnect();
    socketRef.current = null;
    setStatus("dormant");
  }

  const connected = status !== "dormant" && status !== "error";
  const statusLabel: Record<Status,string> = { dormant:"Dormant", connecting:"Connecting", observing:"Observing", speaking:"Speaking", error:"Error" };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <Text style={s.logo}>◉ ARGUS</Text>
        <Text style={s.greeting}>{user ? "Hi, " + user.name.split(" ")[0] : ""}</Text>
        <TouchableOpacity onPress={async () => { await signOut(); router.replace("/sign-in"); }}>
          <Text style={s.signOut}>Sign out</Text>
        </TouchableOpacity>
      </View>

      {connected && camPerm?.granted ? (
        <CameraView style={s.camera} facing="back" />
      ) : (
        <View style={s.cameraPlaceholder}>
          <Text style={s.eyeIcon}>◉</Text>
          <Text style={s.dormantTxt}>Tap to awaken Argus</Text>
        </View>
      )}

      <View style={s.badge}>
        <Text style={[s.badgeTxt, status==="speaking" && { color:"#4a6fa5" }]}>{statusLabel[status]}</Text>
      </View>

      <ScrollView ref={scrollRef} style={s.transcript} contentContainerStyle={{ padding:16 }}>
        {lines.map((l,i) => (
          <Text key={i} style={[s.line, l.role==="argus" && s.lineArgus, l.role==="tool" && s.lineTool]}>
            {l.role==="argus" ? "◉ " : l.role==="tool" ? "⚙ " : ""}{l.text}
          </Text>
        ))}
      </ScrollView>

      <View style={s.controls}>
        <TouchableOpacity style={[s.connectBtn, connected && s.connectBtnActive]} onPress={connected ? disconnect : connect}>
          <Text style={s.connectBtnTxt}>{connected ? "✕" : "◉"}</Text>
        </TouchableOpacity>
        {connected ? (
          <TouchableOpacity style={s.muteBtn} onPress={() => setMuted(!muted)}>
            <Text style={s.muteBtnTxt}>{muted ? "🔇" : "🎙️"}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex:1, backgroundColor:"#08080c" },
  header: { flexDirection:"row", alignItems:"center", justifyContent:"space-between", paddingHorizontal:20, paddingTop:8, paddingBottom:12 },
  logo: { color:"#c9a84c", fontSize:18, fontWeight:"700", letterSpacing:4 },
  greeting: { color:"#e8e0d0", fontSize:14 },
  signOut: { color:"#9e978a", fontSize:12 },
  camera: { flex:1, maxHeight:280 },
  cameraPlaceholder: { height:280, alignItems:"center", justifyContent:"center", backgroundColor:"#111118" },
  eyeIcon: { fontSize:80, color:"#c9a84c", opacity:0.3 },
  dormantTxt: { color:"#9e978a", marginTop:12, fontSize:13 },
  badge: { alignItems:"center", paddingVertical:6 },
  badgeTxt: { color:"#c9a84c", fontSize:11, letterSpacing:3, textTransform:"uppercase" },
  transcript: { flex:1, backgroundColor:"#08080c" },
  line: { fontSize:14, color:"#9e978a", marginBottom:6, lineHeight:22 },
  lineArgus: { color:"#c9a84c" },
  lineTool: { fontSize:11, color:"#8a6f2f", fontVariant:["tabular-nums"] },
  controls: { flexDirection:"row", justifyContent:"center", alignItems:"center", gap:20, paddingVertical:24 },
  connectBtn: { width:64, height:64, borderRadius:32, borderWidth:2, borderColor:"#c9a84c", alignItems:"center", justifyContent:"center" },
  connectBtnActive: { backgroundColor:"#1a1408" },
  connectBtnTxt: { color:"#c9a84c", fontSize:24 },
  muteBtn: { width:48, height:48, borderRadius:24, backgroundColor:"#1a1a24", alignItems:"center", justifyContent:"center" },
  muteBtnTxt: { fontSize:20 },
});

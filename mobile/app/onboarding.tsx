import { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Dimensions, Switch } from "react-native";
import { router } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCaptions } from "../contexts/CaptionsContext";

const { width } = Dimensions.get("window");

const SLIDES = [
  { icon:"◉", title:"Meet Argus", body:"Your AI companion that sees, hears, and remembers. Tap the eye to connect — then just start talking." },
  { icon:"◉", title:"Point & Ask", body:"Point your camera at anything — food, a broken appliance, a label — and ask Argus about it in real time." },
  { icon:"◉", title:"It Remembers You", body:"Tell Argus your allergies, goals, or preferences once. It will remember them every session, forever." },
  { icon:"◉", title:"Just Talk", body:"No typing. No menus. Say what you need — Argus handles the rest. Tap the mic to mute if needed." },
  { icon:"◉", title:"Closed Captions", body:"Show Argus's replies as text on screen while it talks. You can change this anytime in Settings.", captionsStep:true },
];

export default function Onboarding() {
  const [idx, setIdx] = useState(0);
  const [wantsCaptions, setWantsCaptions] = useState(false);
  const { setCaptionsEnabled } = useCaptions();
  const slide = SLIDES[idx];
  const last = idx === SLIDES.length - 1;

  async function next() {
    if (last) {
      setCaptionsEnabled(wantsCaptions);
      await AsyncStorage.setItem("argus_onboarded", "1");
      router.replace("/(main)/home");
    } else { setIdx(idx + 1); }
  }

  return (
    <View style={s.container}>
      <Text style={s.icon}>{slide.icon}</Text>
      <Text style={s.title}>{slide.title}</Text>
      <Text style={s.body}>{slide.body}</Text>
      {slide.captionsStep && (
        <View style={s.captionsRow}>
          <Text style={s.captionsLabel}>Turn on closed captions</Text>
          <Switch
            value={wantsCaptions}
            onValueChange={setWantsCaptions}
            trackColor={{ false: "#3a3a44", true: "#c9a84c" }}
            thumbColor="#e8e0d0"
            ios_backgroundColor="#3a3a44"
          />
        </View>
      )}
      <View style={s.dots}>
        {SLIDES.map((_,i) => <View key={i} style={[s.dot, i===idx && s.dotActive]} />)}
      </View>
      <TouchableOpacity style={s.btn} onPress={next}>
        <Text style={s.btnTxt}>{last ? "Get Started" : "Next"}</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex:1, backgroundColor:"#08080c", alignItems:"center", justifyContent:"center", padding:40 },
  icon: { fontSize:72, marginBottom:24 },
  title: { fontSize:28, color:"#c9a84c", fontWeight:"600", marginBottom:16, textAlign:"center" },
  body: { fontSize:16, color:"#e8e0d0", textAlign:"center", lineHeight:26, marginBottom:48 },
  captionsRow: { flexDirection:"row", alignItems:"center", gap:14, marginBottom:40 },
  captionsLabel: { color:"#e8e0d0", fontSize:15 },
  dots: { flexDirection:"row", gap:8, marginBottom:40 },
  dot: { width:8, height:8, borderRadius:4, backgroundColor:"#2a2a36" },
  dotActive: { backgroundColor:"#c9a84c" },
  btn: { backgroundColor:"#c9a84c", paddingVertical:16, paddingHorizontal:48, borderRadius:4 },
  btnTxt: { color:"#08080c", fontWeight:"600", fontSize:16 },
});

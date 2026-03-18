import { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Dimensions } from "react-native";
import { router } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";

const { width } = Dimensions.get("window");

const SLIDES = [
  { icon:"◉", title:"Meet Argus", body:"Your AI companion that sees, hears, and remembers. Tap the eye to connect — then just start talking." },
  { icon:"📷", title:"Point & Ask", body:"Point your camera at anything — food, a broken appliance, a label — and ask Argus about it in real time." },
  { icon:"🧠", title:"It Remembers You", body:"Tell Argus your allergies, goals, or preferences once. It will remember them every session, forever." },
  { icon:"🗣️", title:"Just Talk", body:"No typing. No menus. Say what you need — Argus handles the rest. Tap the mic to mute if needed." },
];

export default function Onboarding() {
  const [idx, setIdx] = useState(0);
  const slide = SLIDES[idx];
  const last = idx === SLIDES.length - 1;

  async function next() {
    if (last) {
      await AsyncStorage.setItem("argus_onboarded", "1");
      router.replace("/(main)/home");
    } else { setIdx(idx + 1); }
  }

  return (
    <View style={s.container}>
      <Text style={s.icon}>{slide.icon}</Text>
      <Text style={s.title}>{slide.title}</Text>
      <Text style={s.body}>{slide.body}</Text>
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
  dots: { flexDirection:"row", gap:8, marginBottom:40 },
  dot: { width:8, height:8, borderRadius:4, backgroundColor:"#2a2a36" },
  dotActive: { backgroundColor:"#c9a84c" },
  btn: { backgroundColor:"#c9a84c", paddingVertical:16, paddingHorizontal:48, borderRadius:4 },
  btnTxt: { color:"#08080c", fontWeight:"600", fontSize:16 },
});

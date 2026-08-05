import { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Linking, Alert } from "react-native";
import { router } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { setAiConsent } from "../services/auth";
import { BACKEND } from "../services/websocket";

// Apple guideline 5.1.1(i)/5.1.2(i): before an app sends personal data to a
// third-party AI service, it must disclose what data, name who it goes to,
// and get explicit permission in-app — a link to the Privacy Policy alone
// isn't sufficient. This screen is that explicit ask, shown once, before the
// user can ever reach the camera/mic screen.
export default function Consent() {
  const [loading, setLoading] = useState(false);

  async function agree() {
    setLoading(true);
    await setAiConsent();
    const onboarded = await AsyncStorage.getItem("argus_onboarded");
    router.replace(onboarded ? "/(main)/home" : "/onboarding");
  }

  function decline() {
    Alert.alert(
      "Argus needs this to work",
      "Argus is a live camera/voice companion — it can't function without sending your camera and microphone feed to Google's Gemini Live API to generate responses. You can review the Privacy Policy, or come back if you change your mind.",
      [
        { text: "Review Privacy Policy", onPress: () => Linking.openURL(`${BACKEND}/privacy`) },
        { text: "OK", style: "cancel" },
      ]
    );
  }

  return (
    <View style={s.container}>
      <ScrollView contentContainerStyle={s.scroll}>
        <Text style={s.icon}>◉</Text>
        <Text style={s.title}>Before you begin</Text>
        <Text style={s.body}>
          While you're connected, Argus sends your live camera video and microphone audio
          to <Text style={s.bold}>Google's Gemini Live API</Text> (a third-party AI service)
          so it can see, hear, and respond to you in real time.
        </Text>
        <Text style={s.body}>
          If you've shared things like allergies, preferences, or a shopping list, those may
          also be included as context so Argus can remember them. This only happens while
          you're actively connected — never in the background — and Google does not retain
          this data beyond generating a response.
        </Text>
        <Text style={s.body}>
          Full details are in our{" "}
          <Text style={s.link} onPress={() => Linking.openURL(`${BACKEND}/privacy`)}>Privacy Policy</Text>.
        </Text>
        <TouchableOpacity style={s.btn} onPress={agree} disabled={loading}>
          <Text style={s.btnTxt}>I Agree — Continue</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.declineBtn} onPress={decline} disabled={loading}>
          <Text style={s.declineTxt}>Don't Agree</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#08080c" },
  scroll: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 32, paddingTop: 64 },
  icon: { fontSize: 56, color: "#c9a84c", marginBottom: 20 },
  title: { fontSize: 24, color: "#c9a84c", fontWeight: "600", marginBottom: 20, textAlign: "center" },
  body: { fontSize: 15, color: "#e8e0d0", textAlign: "left", lineHeight: 23, marginBottom: 16 },
  bold: { fontWeight: "700", color: "#f0e8d8" },
  link: { color: "#c9a84c", textDecorationLine: "underline" },
  btn: { width: "100%", backgroundColor: "#c9a84c", paddingVertical: 16, borderRadius: 4, alignItems: "center", marginTop: 16 },
  btnTxt: { color: "#08080c", fontWeight: "600", fontSize: 16 },
  declineBtn: { width: "100%", paddingVertical: 14, alignItems: "center", marginTop: 8 },
  declineTxt: { color: "#9e978a", fontSize: 14 },
});

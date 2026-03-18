import { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Image } from "react-native";
import { router } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { signIn } from "../services/auth";

export default function SignIn() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSignIn() {
    setLoading(true); setError("");
    try {
      await signIn();
      const seen = await AsyncStorage.getItem("argus_onboarded");
      if (seen) router.replace("/(main)/home");
      else router.replace("/onboarding");
    } catch (e: any) { setError(e.message || "Sign in failed"); }
    finally { setLoading(false); }
  }

  return (
    <View style={s.container}>
      <Text style={s.eye}>◉</Text>
      <Text style={s.title}>ARGUS</Text>
      <Text style={s.sub}>The All-Seeing Companion</Text>
      {error ? <Text style={s.err}>{error}</Text> : null}
      <TouchableOpacity style={s.btn} onPress={handleSignIn} disabled={loading}>
        {loading ? <ActivityIndicator color="#08080c" /> : <Text style={s.btnTxt}>Continue with Google</Text>}
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex:1, backgroundColor:"#08080c", alignItems:"center", justifyContent:"center", padding:40 },
  eye: { fontSize:80, color:"#c9a84c", marginBottom:16 },
  title: { fontFamily:"serif", fontSize:40, color:"#c9a84c", letterSpacing:12, marginBottom:8 },
  sub: { fontSize:14, color:"#9e978a", marginBottom:60, letterSpacing:2 },
  btn: { backgroundColor:"#c9a84c", paddingVertical:16, paddingHorizontal:48, borderRadius:4 },
  btnTxt: { color:"#08080c", fontWeight:"600", fontSize:16 },
  err: { color:"#c44a3f", marginBottom:16, textAlign:"center" },
});

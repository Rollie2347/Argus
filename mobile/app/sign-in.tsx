import { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform } from "react-native";
import { router } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { saveUser } from "../services/auth";

export default function SignIn() {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleContinue() {
    if (!name.trim()) { setError("Please enter your name"); return; }
    setLoading(true);
    try {
      await saveUser(name.trim());
      const seen = await AsyncStorage.getItem("argus_onboarded");
      if (seen) router.replace("/(main)/home");
      else router.replace("/onboarding");
    } catch (e: any) { setError(e.message || "Something went wrong"); }
    finally { setLoading(false); }
  }

  return (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS==="ios" ? "padding" : undefined}>
      <Text style={s.eye}>◉</Text>
      <Text style={s.title}>ARGUS</Text>
      <Text style={s.sub}>The All-Seeing Companion</Text>
      <Text style={s.label}>What should Argus call you?</Text>
      <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Your name" placeholderTextColor="#4a4a5a" autoFocus returnKeyType="done" onSubmitEditing={handleContinue} />
      {error ? <Text style={s.err}>{error}</Text> : null}
      <TouchableOpacity style={[s.btn, !name.trim() && s.btnDisabled]} onPress={handleContinue} disabled={loading || !name.trim()}>
        {loading ? <ActivityIndicator color="#08080c" /> : <Text style={s.btnTxt}>Begin</Text>}
      </TouchableOpacity>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex:1, backgroundColor:"#08080c", alignItems:"center", justifyContent:"center", padding:40 },
  eye: { fontSize:80, color:"#c9a84c", marginBottom:16 },
  title: { fontFamily:"serif", fontSize:40, color:"#c9a84c", letterSpacing:12, marginBottom:8 },
  sub: { fontSize:14, color:"#9e978a", marginBottom:48, letterSpacing:2 },
  label: { fontSize:15, color:"#e8e0d0", marginBottom:12, alignSelf:"flex-start" },
  input: { width:"100%", backgroundColor:"#1a1a24", color:"#e8e0d0", fontSize:18, padding:16, borderRadius:4, marginBottom:8, borderWidth:1, borderColor:"#2a2a36" },
  err: { color:"#c44a3f", marginBottom:12, fontSize:13 },
  btn: { width:"100%", backgroundColor:"#c9a84c", paddingVertical:16, borderRadius:4, alignItems:"center", marginTop:8 },
  btnDisabled: { opacity:0.4 },
  btnTxt: { color:"#08080c", fontWeight:"600", fontSize:16 },
});

import { useEffect, useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from "react-native";
import { router } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getStoredUser, getDeviceSecret } from "../services/auth";
import { submitProfile, Person, Personality } from "../services/profile";

// Shown once, before onboarding/home, for any account whose profile status
// is "needs_interview" (see computeProfileStatus in backend/memory.js) — a
// brand-new account, or one that predates this feature and never captured
// more than a name. Deliberately a native form rather than a spoken
// interview: extracting clean {name,relation} pairs from freeform speech
// is a real reliability risk with no easy mid-flow correction, and every
// other one-time setup gate in this app (consent.tsx, onboarding.tsx) is
// already a native screen, not a conversation. Name/location/people are
// all optional except name (prefilled from sign-in) — this shouldn't be
// able to trap anyone who just wants to start talking to Argus.
const TONE_OPTIONS: { value: Personality["tone"]; label: string }[] = [
  { value: "warm", label: "Warm" },
  { value: "direct", label: "Direct" },
  { value: "playful", label: "Playful" },
];
const VERBOSITY_OPTIONS: { value: Personality["verbosity"]; label: string }[] = [
  { value: "concise", label: "Concise" },
  { value: "detailed", label: "Detailed" },
];
const PROACTIVITY_OPTIONS: { value: Personality["proactivity"]; label: string }[] = [
  { value: "proactive", label: "Speaks up" },
  { value: "on_request", label: "Waits to be asked" },
];

export default function ProfileSetup() {
  const [userId, setUserId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [homeCity, setHomeCity] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [personality, setPersonality] = useState<Personality>({
    tone: "warm", verbosity: "concise", proactivity: "proactive",
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const user = await getStoredUser();
      if (user) { setUserId(user.id); setName(user.name || ""); }
    })();
  }, []);

  function addPersonRow() {
    setPeople((p) => [...p, { name: "", relation: "" }]);
  }
  function updatePerson(i: number, field: keyof Person, value: string) {
    setPeople((p) => p.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)));
  }
  function removePersonRow(i: number) {
    setPeople((p) => p.filter((_, idx) => idx !== i));
  }

  async function goNext() {
    const seen = await AsyncStorage.getItem("argus_onboarded");
    router.replace(seen ? "/(main)/home" : "/onboarding");
  }

  async function submit() {
    if (!userId) { await goNext(); return; }
    setLoading(true);
    const secret = await getDeviceSecret(userId);
    if (secret) {
      await submitProfile(userId, secret, {
        name: name.trim() || undefined,
        homeCity: homeCity.trim() || undefined,
        people: people.filter((p) => p.name.trim()),
        personality,
        markReviewed: true,
      });
    }
    // Fails open regardless of whether the POST succeeded — a failed submit
    // just means lastProfileReviewAt never gets set, so this screen shows
    // again next launch instead of trapping the user here now.
    setLoading(false);
    await goNext();
  }

  return (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <Text style={s.icon}>◉</Text>
        <Text style={s.title}>Tell Argus about you</Text>
        <Text style={s.sub}>Everything here is optional except your name, and you can change it later in Settings.</Text>

        <Text style={s.label}>What should Argus call you?</Text>
        <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Your name" placeholderTextColor="#4a4a5a" />

        <Text style={s.label}>Where do you live?</Text>
        <TextInput style={s.input} value={homeCity} onChangeText={setHomeCity} placeholder="e.g. Chicago, Illinois" placeholderTextColor="#4a4a5a" />

        <Text style={s.label}>Important people in your life</Text>
        {people.map((p, i) => (
          <View key={i} style={s.personRow}>
            <TextInput
              style={[s.input, s.personInput]}
              value={p.name}
              onChangeText={(v) => updatePerson(i, "name", v)}
              placeholder="Name"
              placeholderTextColor="#4a4a5a"
            />
            <TextInput
              style={[s.input, s.personInput]}
              value={p.relation}
              onChangeText={(v) => updatePerson(i, "relation", v)}
              placeholder="Relation (spouse, kid...)"
              placeholderTextColor="#4a4a5a"
            />
            <TouchableOpacity onPress={() => removePersonRow(i)} style={s.removeBtn}>
              <Text style={s.removeTxt}>×</Text>
            </TouchableOpacity>
          </View>
        ))}
        <TouchableOpacity onPress={addPersonRow} style={s.addBtn}>
          <Text style={s.addTxt}>+ Add person</Text>
        </TouchableOpacity>

        <Text style={s.label}>How should Argus talk to you?</Text>
        <Picker options={TONE_OPTIONS} value={personality.tone} onChange={(v) => setPersonality((p) => ({ ...p, tone: v as Personality["tone"] }))} />
        <Picker options={VERBOSITY_OPTIONS} value={personality.verbosity} onChange={(v) => setPersonality((p) => ({ ...p, verbosity: v as Personality["verbosity"] }))} />
        <Picker options={PROACTIVITY_OPTIONS} value={personality.proactivity} onChange={(v) => setPersonality((p) => ({ ...p, proactivity: v as Personality["proactivity"] }))} />

        <TouchableOpacity style={s.btn} onPress={submit} disabled={loading}>
          {loading ? <ActivityIndicator color="#08080c" /> : <Text style={s.btnTxt}>Continue</Text>}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Picker({ options, value, onChange }: { options: { value: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <View style={s.pickerRow}>
      {options.map((o) => (
        <TouchableOpacity
          key={o.value}
          onPress={() => onChange(o.value)}
          style={[s.pickerOpt, value === o.value && s.pickerOptActive]}
        >
          <Text style={[s.pickerOptTxt, value === o.value && s.pickerOptTxtActive]}>{o.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#08080c" },
  scroll: { padding: 28, paddingTop: 56, paddingBottom: 48 },
  icon: { fontSize: 44, color: "#c9a84c", marginBottom: 12, textAlign: "center" },
  title: { fontSize: 22, color: "#c9a84c", fontWeight: "600", marginBottom: 8, textAlign: "center" },
  sub: { fontSize: 13, color: "#9e978a", textAlign: "center", marginBottom: 28, lineHeight: 19 },
  label: { fontSize: 14, color: "#e8e0d0", marginBottom: 8, marginTop: 20 },
  input: { backgroundColor: "#1a1a24", color: "#e8e0d0", fontSize: 16, padding: 14, borderRadius: 4, borderWidth: 1, borderColor: "#2a2a36" },
  personRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  personInput: { flex: 1 },
  removeBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  removeTxt: { color: "#c44a3f", fontSize: 22 },
  addBtn: { paddingVertical: 8, marginTop: 4 },
  addTxt: { color: "#c9a84c", fontSize: 14 },
  pickerRow: { flexDirection: "row", gap: 8, marginBottom: 4 },
  pickerOpt: { flex: 1, paddingVertical: 12, borderRadius: 4, borderWidth: 1, borderColor: "#2a2a36", alignItems: "center" },
  pickerOptActive: { backgroundColor: "#c9a84c", borderColor: "#c9a84c" },
  pickerOptTxt: { color: "#9e978a", fontSize: 13 },
  pickerOptTxtActive: { color: "#08080c", fontWeight: "600" },
  btn: { backgroundColor: "#c9a84c", paddingVertical: 16, borderRadius: 4, alignItems: "center", marginTop: 32 },
  btnTxt: { color: "#08080c", fontWeight: "600", fontSize: 16 },
});

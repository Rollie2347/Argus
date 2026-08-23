import { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView, Switch, Linking, ScrollView } from "react-native";
import { router } from "expo-router";
import { useCaptions } from "../../contexts/CaptionsContext";
import { BACKEND } from "../../services/websocket";
import { getStoredUser, getDeviceSecret } from "../../services/auth";
import { fetchProfile, submitProfile, Personality } from "../../services/profile";

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

export default function Settings() {
  const { captionsEnabled, setCaptionsEnabled } = useCaptions();
  const [userId, setUserId] = useState<string | null>(null);
  const [personality, setPersonalityState] = useState<Personality | null>(null);

  useEffect(() => {
    (async () => {
      const user = await getStoredUser();
      if (!user) return;
      setUserId(user.id);
      const secret = await getDeviceSecret(user.id);
      const profile = await fetchProfile(user.id, secret);
      if (profile) setPersonalityState(profile.personality);
    })();
  }, []);

  // Deliberately omits markReviewed — this is a style tweak, not a
  // location/people confirmation, so it shouldn't reset the 30-day recheck
  // clock (see computeProfileStatus in backend/memory.js).
  async function updateAxis(axis: keyof Personality, value: string) {
    if (!userId || !personality) return;
    const next = { ...personality, [axis]: value };
    setPersonalityState(next);
    const secret = await getDeviceSecret(userId);
    if (secret) submitProfile(userId, secret, { personality: next });
  }

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={s.back}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>Settings</Text>
        <View style={{ width: 60 }} />
      </View>
      <ScrollView>
        <View style={s.row}>
          <View style={{ flex: 1 }}>
            <Text style={s.rowLabel}>Closed captions</Text>
            <Text style={s.rowSub}>Show Argus's spoken replies and activity as text on screen</Text>
          </View>
          <Switch
            value={captionsEnabled}
            onValueChange={setCaptionsEnabled}
            trackColor={{ false: "#3a3a44", true: "#c9a84c" }}
            thumbColor="#e8e0d0"
            ios_backgroundColor="#3a3a44"
          />
        </View>

        {personality && (
          <View style={s.personalitySection}>
            <Text style={s.sectionLabel}>How Argus talks to you</Text>
            <Picker options={TONE_OPTIONS} value={personality.tone} onChange={(v) => updateAxis("tone", v)} />
            <Picker options={VERBOSITY_OPTIONS} value={personality.verbosity} onChange={(v) => updateAxis("verbosity", v)} />
            <Picker options={PROACTIVITY_OPTIONS} value={personality.proactivity} onChange={(v) => updateAxis("proactivity", v)} />
          </View>
        )}

        <TouchableOpacity style={s.row} onPress={() => router.push("/(main)/audio-test")}>
          <View style={{ flex: 1 }}>
            <Text style={s.rowLabel}>Audio A/B test</Text>
            <Text style={s.rowSub}>Plays one reference clip under each audio configuration, to find which one muffles it</Text>
          </View>
          <Text style={s.rowChevron}>›</Text>
        </TouchableOpacity>

        <TouchableOpacity style={s.row} onPress={() => Linking.openURL(`${BACKEND}/privacy`)}>
          <View style={{ flex: 1 }}>
            <Text style={s.rowLabel}>Privacy Policy</Text>
            <Text style={s.rowSub}>See what Argus collects, stores, and how to delete it</Text>
          </View>
          <Text style={s.rowChevron}>›</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
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
  safe: { flex: 1, backgroundColor: "#08080c" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16 },
  back: { color: "#c9a84c", fontSize: 15 },
  title: { color: "#e8e0d0", fontSize: 16, fontWeight: "700", letterSpacing: 1 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 16, borderTopWidth: StyleSheet.hairlineWidth, borderColor: "#2a2a32", gap: 16 },
  rowLabel: { color: "#e8e0d0", fontSize: 15 },
  rowSub: { color: "#9e978a", fontSize: 12, marginTop: 4 },
  rowChevron: { color: "#9e978a", fontSize: 20 },
  personalitySection: { paddingHorizontal: 20, paddingVertical: 16, borderTopWidth: StyleSheet.hairlineWidth, borderColor: "#2a2a32" },
  sectionLabel: { color: "#9e978a", fontSize: 12, marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 },
  pickerRow: { flexDirection: "row", gap: 8, marginBottom: 10 },
  pickerOpt: { flex: 1, paddingVertical: 10, borderRadius: 4, borderWidth: 1, borderColor: "#2a2a36", alignItems: "center" },
  pickerOptActive: { backgroundColor: "#c9a84c", borderColor: "#c9a84c" },
  pickerOptTxt: { color: "#9e978a", fontSize: 13 },
  pickerOptTxtActive: { color: "#08080c", fontWeight: "600" },
});

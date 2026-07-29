import { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView, Switch } from "react-native";
import { router } from "expo-router";
import { getCaptionsEnabled, setCaptionsEnabled as saveCaptionsEnabled } from "../../services/settings";

export default function Settings() {
  const [captionsEnabled, setCaptions] = useState(true);

  useEffect(() => { getCaptionsEnabled().then(setCaptions); }, []);

  function toggleCaptions(value: boolean) {
    setCaptions(value);
    saveCaptionsEnabled(value);
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
      <View style={s.row}>
        <View style={{ flex: 1 }}>
          <Text style={s.rowLabel}>Closed captions</Text>
          <Text style={s.rowSub}>Show Argus's spoken replies and activity as text on screen</Text>
        </View>
        <Switch
          value={captionsEnabled}
          onValueChange={toggleCaptions}
          trackColor={{ false: "#3a3a44", true: "#c9a84c" }}
          thumbColor="#e8e0d0"
          ios_backgroundColor="#3a3a44"
        />
      </View>
    </SafeAreaView>
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
});

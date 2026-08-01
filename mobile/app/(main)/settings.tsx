import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView, Switch, Linking } from "react-native";
import { router } from "expo-router";
import { useCaptions } from "../../contexts/CaptionsContext";
import { BACKEND } from "../../services/websocket";

export default function Settings() {
  const { captionsEnabled, setCaptionsEnabled } = useCaptions();

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
          onValueChange={setCaptionsEnabled}
          trackColor={{ false: "#3a3a44", true: "#c9a84c" }}
          thumbColor="#e8e0d0"
          ios_backgroundColor="#3a3a44"
        />
      </View>
      <TouchableOpacity style={s.row} onPress={() => Linking.openURL(`${BACKEND}/privacy`)}>
        <View style={{ flex: 1 }}>
          <Text style={s.rowLabel}>Privacy Policy</Text>
          <Text style={s.rowSub}>See what Argus collects, stores, and how to delete it</Text>
        </View>
        <Text style={s.rowChevron}>›</Text>
      </TouchableOpacity>
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
  rowChevron: { color: "#9e978a", fontSize: 20 },
});

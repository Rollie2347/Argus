import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { CaptionsProvider } from "../contexts/CaptionsContext";

export default function RootLayout() {
  return (
    <CaptionsProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#08080c" } }} />
    </CaptionsProvider>
  );
}

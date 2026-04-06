import { useEffect } from "react";
import { Stack, router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { getStoredUser } from "../services/auth";

export default function RootLayout() {
  useEffect(() => {
    getStoredUser().then(u => {
      if (u) router.replace("/(main)/home");
      else router.replace("/sign-in");
    });
  }, []);
  return (
    <>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#08080c" } }} />
    </>
  );
}

import { useEffect, useState } from "react";
import { Stack, router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GoogleSignin } from "@react-native-google-signin/google-signin";
import { getStoredUser, configureGoogleSignIn } from "../services/auth";

const IOS_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || "";
const WEB_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || "";

export default function RootLayout() {
  useEffect(() => {
    configureGoogleSignIn(IOS_ID, WEB_ID);
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

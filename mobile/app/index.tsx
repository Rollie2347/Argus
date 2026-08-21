import { useEffect, useState } from "react";
import { Redirect } from "expo-router";
import { View, ActivityIndicator } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getStoredUser, hasAiConsent, getDeviceSecret } from "../services/auth";
import { fetchProfile } from "../services/profile";

export default function Index() {
  const [dest, setDest] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const u = await getStoredUser();
      if (!u) { setDest("/sign-in"); return; }
      if (!(await hasAiConsent())) { setDest("/consent"); return; }
      // Fails open (proceeds to onboarding/home) if the fetch errors —
      // a network hiccup shouldn't strand the user on launch. The setup
      // form stays pending (lastProfileReviewAt never gets set) so it's
      // simply asked again next launch instead.
      const secret = await getDeviceSecret(u.id);
      const profile = await fetchProfile(u.id, secret);
      if (profile?.status === "needs_interview") { setDest("/profile-setup"); return; }
      const onboarded = await AsyncStorage.getItem("argus_onboarded");
      setDest(onboarded ? "/(main)/home" : "/onboarding");
    })();
  }, []);

  if (!dest) {
    return (
      <View style={{ flex: 1, backgroundColor: "#08080c", alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color="#c9a84c" />
      </View>
    );
  }

  return <Redirect href={dest as any} />;
}

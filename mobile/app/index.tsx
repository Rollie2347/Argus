import { useEffect, useState } from "react";
import { Redirect } from "expo-router";
import { View, ActivityIndicator } from "react-native";
import { getStoredUser, hasAiConsent } from "../services/auth";

export default function Index() {
  const [dest, setDest] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const u = await getStoredUser();
      if (!u) { setDest("/sign-in"); return; }
      setDest((await hasAiConsent()) ? "/(main)/home" : "/consent");
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

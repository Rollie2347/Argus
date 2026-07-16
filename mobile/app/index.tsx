import { useEffect, useState } from "react";
import { Redirect } from "expo-router";
import { View, ActivityIndicator } from "react-native";
import { getStoredUser } from "../services/auth";

export default function Index() {
  const [dest, setDest] = useState<string | null>(null);

  useEffect(() => {
    getStoredUser().then(u => setDest(u ? "/(main)/home" : "/sign-in"));
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

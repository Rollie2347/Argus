import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { BACKEND } from "./websocket";

export type User = { id: string; name: string; email: string };

const SECRET_KEY = "argus_secret";

export async function saveUser(name: string): Promise<User> {
  let id = await AsyncStorage.getItem("argus_uid");
  if (!id) {
    id = "u_" + Crypto.randomUUID();
    await AsyncStorage.setItem("argus_uid", id);
    // Claim this fresh id's device secret so later destructive calls (e.g.
    // delete) can be authorized instead of trusting the id alone.
    try {
      const r = await fetch(`${BACKEND}/api/user/${id}/claim`, { method: "POST" });
      if (r.ok) {
        const { secret } = await r.json();
        if (secret) await SecureStore.setItemAsync(SECRET_KEY, secret);
      }
    } catch {}
  }
  const user: User = { id, name: name.trim(), email: "" };
  await AsyncStorage.setItem("argus_user", JSON.stringify(user));
  return user;
}

export async function getStoredUser(): Promise<User | null> {
  const s = await AsyncStorage.getItem("argus_user");
  return s ? JSON.parse(s) : null;
}

export async function signOut() {
  await AsyncStorage.removeItem("argus_user");
}

export async function deleteAccount(userId: string): Promise<boolean> {
  const secret = await SecureStore.getItemAsync(SECRET_KEY);
  try {
    const r = await fetch(`${BACKEND}/api/user/${userId}`, {
      method: "DELETE",
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    });
    if (!r.ok) return false;
  } catch {
    return false;
  }
  await AsyncStorage.multiRemove(["argus_user", "argus_uid", "argus_onboarded"]);
  await SecureStore.deleteItemAsync(SECRET_KEY).catch(() => {});
  return true;
}

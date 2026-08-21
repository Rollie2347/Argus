import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { BACKEND } from "./websocket";

export type User = { id: string; name: string; email: string };

// Keyed per-userId rather than one fixed key. iOS Keychain (unlike
// AsyncStorage) survives app deletion, so a fixed key could resurrect a
// secret that belongs to a *previous* install's uid — silently skipping
// claim for the new uid and permanently orphaning it (401/403 forever,
// with no retry ever firing since the stale value reads as "already have
// one"). Scoping by id means a fresh uid never sees a stale value.
function secretKey(id: string) { return `argus_secret_${id}`; }

// Exposed so profile-setup/settings can authenticate the profile POST route
// the same way deleteAccount does, without duplicating the Keychain key
// scheme (see secretKey's comment above for why it's scoped per-id).
export async function getDeviceSecret(id: string): Promise<string | null> {
  return SecureStore.getItemAsync(secretKey(id));
}

// Claims (or re-claims) this device's secret so destructive calls (e.g.
// delete) can be authorized instead of trusting the id alone. Safe to retry:
// the backend only refuses once a secret is actually set for this id, so a
// prior silently-failed attempt (network blip, cold backend) can always be
// healed by trying again.
async function claimSecret(id: string): Promise<string | null> {
  try {
    const r = await fetch(`${BACKEND}/api/user/${id}/claim`, { method: "POST" });
    if (r.ok) {
      const { secret } = await r.json();
      if (secret) { await SecureStore.setItemAsync(secretKey(id), secret); return secret; }
    }
  } catch {}
  return null;
}

export async function saveUser(name: string): Promise<User> {
  let id = await AsyncStorage.getItem("argus_uid");
  if (!id) {
    id = "u_" + Crypto.randomUUID();
    await AsyncStorage.setItem("argus_uid", id);
  }
  if (!(await SecureStore.getItemAsync(secretKey(id)))) await claimSecret(id);
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

const AI_CONSENT_KEY = "argus_ai_data_consent";

export async function hasAiConsent(): Promise<boolean> {
  return (await AsyncStorage.getItem(AI_CONSENT_KEY)) === "1";
}

export async function setAiConsent(): Promise<void> {
  await AsyncStorage.setItem(AI_CONSENT_KEY, "1");
}

export async function deleteAccount(userId: string): Promise<boolean> {
  let secret = await SecureStore.getItemAsync(secretKey(userId));
  if (!secret) secret = await claimSecret(userId);
  try {
    const r = await fetch(`${BACKEND}/api/user/${userId}`, {
      method: "DELETE",
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    });
    if (!r.ok) return false;
  } catch {
    return false;
  }
  // The server-side delete already succeeded at this point. Local cleanup is
  // best-effort and must not make an already-successful delete look like it
  // silently failed — an unhandled rejection here previously left the caller
  // awaiting a promise that never resolved or rejected visibly, with no
  // error and no navigation.
  try {
    await AsyncStorage.multiRemove(["argus_user", "argus_uid", "argus_onboarded", AI_CONSENT_KEY]);
    await SecureStore.deleteItemAsync(secretKey(userId));
  } catch {}
  return true;
}

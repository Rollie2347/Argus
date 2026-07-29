import AsyncStorage from "@react-native-async-storage/async-storage";

const CAPTIONS_KEY = "argus_captions_enabled";

// Cached in memory + pushed to subscribers synchronously so screens don't
// have to re-read AsyncStorage on every focus event, which raced against the
// un-awaited write from wherever the toggle was last changed (e.g. tapping
// "Back" right after flipping the switch could read the old value before the
// write had landed).
let cachedCaptionsEnabled: boolean | null = null;
const listeners = new Set<(enabled: boolean) => void>();

export async function getCaptionsEnabled(): Promise<boolean> {
  if (cachedCaptionsEnabled !== null) return cachedCaptionsEnabled;
  const v = await AsyncStorage.getItem(CAPTIONS_KEY);
  cachedCaptionsEnabled = v === null ? true : v === "1";
  return cachedCaptionsEnabled;
}

export async function setCaptionsEnabled(enabled: boolean): Promise<void> {
  cachedCaptionsEnabled = enabled;
  listeners.forEach(l => l(enabled));
  await AsyncStorage.setItem(CAPTIONS_KEY, enabled ? "1" : "0");
}

export function subscribeCaptionsEnabled(listener: (enabled: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

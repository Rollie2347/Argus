import AsyncStorage from "@react-native-async-storage/async-storage";

export type User = { id: string; name: string; email: string };

export async function saveUser(name: string): Promise<User> {
  let id = await AsyncStorage.getItem("argus_uid");
  if (!id) { id = "u_" + Math.random().toString(36).substr(2,9); await AsyncStorage.setItem("argus_uid", id); }
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

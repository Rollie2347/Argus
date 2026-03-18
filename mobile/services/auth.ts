import { GoogleSignin } from "@react-native-google-signin/google-signin";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type User = { id: string; name: string; email: string; photo?: string | null };

export type User = { id: string; name: string; email: string; photo?: string | null };

export function configureGoogleSignIn(iosClientId: string, webClientId: string) {
  GoogleSignin.configure({ iosClientId, webClientId,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"] });
}

export async function signIn(): Promise<User> {
  await GoogleSignin.hasPlayServices();
  const { data } = await GoogleSignin.signIn();
  if (!data?.user) throw new Error("Sign in failed");
  const user: User = { id: data.user.id, name: data.user.name ?? "", email: data.user.email, photo: data.user.photo };
  await AsyncStorage.setItem("argus_user", JSON.stringify(user));
  return user;
}

export async function signOut() {
  await GoogleSignin.signOut();
  await AsyncStorage.removeItem("argus_user");
}

export async function getStoredUser(): Promise<User | null> {
  const s = await AsyncStorage.getItem("argus_user");
  return s ? JSON.parse(s) : null;
}

export async function getAccessToken(): Promise<string | null> {
  const t = await GoogleSignin.getTokens();
  return t?.accessToken ?? null;
}

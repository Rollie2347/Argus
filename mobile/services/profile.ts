import { BACKEND } from "./websocket";

export type Personality = { tone: string; verbosity: string; proactivity: string };
export type Person = { name: string; relation: string };

export type Profile = {
  status: "needs_interview" | "recheck_due" | "ok";
  name: string | null;
  homeLocation: { city: string; lat: number | null; lon: number | null; updatedAt: string } | null;
  people: Person[];
  personality: Personality;
};

// secret is the device's Bearer credential (see getDeviceSecret in auth.ts)
// — required because this returns real PII (name, home city, family/friend
// names+relations), and userIds alone aren't a safe access boundary (they
// appear in plaintext in Cloud Run logs). Fails open (returns null) if no
// secret is available yet, same as every other fail-open path in this file
// — a transient claim failure shouldn't crash routing, it just means the
// profile-setup form may show again until the secret exists.
export async function fetchProfile(userId: string, secret: string | null): Promise<Profile | null> {
  if (!secret) return null;
  try {
    const r = await fetch(`${BACKEND}/api/user/${userId}/profile`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function submitProfile(
  userId: string,
  secret: string,
  data: {
    name?: string;
    homeCity?: string;
    people?: Person[];
    personality?: Personality;
    markReviewed?: boolean;
  }
): Promise<boolean> {
  try {
    const r = await fetch(`${BACKEND}/api/user/${userId}/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify(data),
    });
    return r.ok;
  } catch {
    return false;
  }
}

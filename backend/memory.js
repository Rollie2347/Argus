/**
 * Argus Memory System — Persistent context via Firestore
 * 
 * Stores observations, preferences, and daily context so Argus
 * remembers across sessions and throughout the day.
 */

import { Firestore, FieldValue } from "@google-cloud/firestore";
import { geocodeCity } from "./weather.js";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db;export async function initFirestore() {
  const projectId = process.env.GCP_PROJECT_ID || "agus-488919";
  const saPath = path.join(__dirname, "service-account.json");
  try {
    db = existsSync(saPath)
      ? new Firestore({ projectId, keyFilename: saPath })
      : new Firestore({ projectId });
    // Test connection early so we know immediately if creds work
    await db.collection("_health").limit(1).get();
    console.log("Firestore connected and verified");
    return true;
  } catch (e) {
    console.warn("Firestore unavailable, running without memory:", e.message);
    db = null;
    return false;
  }
}

// ============================================================
// USER MEMORY — Long-term preferences & patterns
// ============================================================

export async function getUserMemory(userId = "default") {
  if (!db) return {};
  try {
    const doc = await db.collection("users").doc(userId).get();
    return doc.exists ? doc.data() : {};
  } catch (err) {
    console.error("Memory read error:", err.message);
    return {};
  }
}

export async function updateUserMemory(userId = "default", data) {
  if (!db) return;
  try {
    await db.collection("users").doc(userId).set(data, { merge: true });
  } catch (err) {
    console.error("Memory write error:", err.message);
  }
}

// ============================================================
// PREFERENCES — bounded, deduped storage for freeform facts
//
// Root-caused 2026-08-08: production data showed zero accounts had ever
// accumulated a real `preferences` map (account-id churn on every reinstall
// meant no identity lived long enough), so the "dump raw JSON into every
// system instruction" path had never actually bloated a prompt yet — but it
// had no cap at all, so it was a matter of time. Bounding + dedup here is
// defense in depth for that; the bigger fix is that buildMemoryContext no
// longer auto-injects this map at all (see below) — it's now pulled on
// demand via recall_memory instead.
// ============================================================

const MAX_PREFERENCE_ENTRIES = 20;
const MAX_PREFERENCE_CHARS = 1500;

// Every preference in production is stored under a *dotted top-level key*
// (`preferences.child_name`) rather than inside a nested `preferences` map —
// the artifact of known issue #16's pre-2026-07-16 bug, where a
// `set({"preferences.x": v}, {merge:true})` wrote a literal dotted field name
// instead of nesting. #16 fixed new writes but never migrated the data that
// already existed, so `doc.preferences` is `undefined` on every real account
// and all 10 facts stored across the two long-lived accounts (verified
// 2026-08-09 against live Firestore) are unreachable — recall_memory returns
// an empty map and Argus genuinely cannot remember them.
//
// Reading is normalised here rather than by a one-shot migration script so it
// self-heals for every account, including any that predate a script run.
// upsertPreference additionally deletes the dotted twin when it rewrites a
// key, so the legacy shape drains away as accounts are used.
export function collectPreferences(doc) {
  if (!doc) return {};
  const merged = { ...(doc.preferences || {}) };
  for (const [k, v] of Object.entries(doc)) {
    if (!k.startsWith("preferences.")) continue;
    const key = k.slice("preferences.".length);
    if (!key || key in merged) continue; // nested form wins — it's the current shape
    merged[key] = v;
  }
  return merged;
}

export function boundPreferences(preferences) {
  if (!preferences) return {};
  const entries = Object.entries(preferences)
    .map(([key, entry]) => {
      const value = entry && typeof entry === "object" ? entry.value : entry;
      // Coerced: legacy entries are bare strings (no updatedAt at all), and a
      // stray non-string here would make the localeCompare below throw.
      const updatedAt = String((entry && typeof entry === "object" && entry.updatedAt) || "");
      return [key, value, updatedAt];
    })
    .sort((a, b) => b[2].localeCompare(a[2]))
    .slice(0, MAX_PREFERENCE_ENTRIES);

  const bounded = {};
  let chars = 0;
  for (const [key, value] of entries) {
    const size = key.length + String(value).length;
    if (chars + size > MAX_PREFERENCE_CHARS) break;
    bounded[key] = value;
    chars += size;
  }
  return bounded;
}

// Adds/updates one freeform preference inside a transaction (was previously
// a read-in-agents.js-then-write-separately sequence with no isolation — two
// overlapping remember_preference calls could race and clobber each other;
// flagged as a known unfixed risk in CLAUDE.md known issue #16). Dedups
// against an existing entry whose value matches case-insensitively (e.g.
// "person_name" and "person_introduced" both set to "Chuck" — this exact
// case exists in real 2026-03 production data under the pre-fix dotted-key
// bug) by updating that key in place instead of piling on a new one, and
// stamps updatedAt so boundPreferences can keep the freshest entries when
// trimming.
export async function upsertPreference(userId, key, value) {
  if (!db) return;
  const ref = db.collection("users").doc(userId);
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const data = doc.exists ? doc.data() : {};
    // Dedup/merge against the legacy dotted keys too, not just the nested map
    // — otherwise re-stating a fact that only exists in the legacy shape adds
    // a second copy under the new shape instead of updating the old one.
    const current = collectPreferences(data);
    const now = new Date().toISOString();
    const existingKey = Object.keys(current).find((k) => {
      const v = current[k];
      const existingValue = v && typeof v === "object" ? v.value : v;
      return String(existingValue).toLowerCase() === String(value).toLowerCase();
    });
    const targetKey = existingKey || key;
    const update = {
      preferences: { ...current, [targetKey]: { value, updatedAt: now } },
    };
    // Retire the dotted twin so the legacy shape drains as accounts are used.
    // The key is passed raw, NOT backtick-escaped: DocumentMask.fromObject
    // builds `new FieldPath(key)` as a single literal segment and does not
    // split on dots (verified in the SDK source — it's the same behaviour that
    // caused #16 in the first place), so this targets the literal field and
    // the SDK handles mask escaping itself.
    if (`preferences.${targetKey}` in data) {
      update[`preferences.${targetKey}`] = FieldValue.delete();
    }
    tx.set(ref, update, { merge: true });
  });
}

// Removes one freeform preference. Without this, remember_preference is
// append-only and a fact stored wrongly can never be corrected — see
// forget_memory in agents.js.
export async function removePreference(userId, key) {
  if (!db) return false;
  const ref = db.collection("users").doc(userId);
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) return false;
    const data = doc.data();
    const current = collectPreferences(data);
    // Match on key first, then on value, so the model can say "forget that I
    // like anchovies" without knowing the key it was filed under.
    const target =
      key in current
        ? key
        : Object.keys(current).find((k) => {
            const v = current[k];
            const val = v && typeof v === "object" ? v.value : v;
            return String(val).toLowerCase() === String(key).toLowerCase();
          });
    if (!target) return false;
    const next = { ...current };
    delete next[target];
    const update = { preferences: next };
    if (`preferences.${target}` in data) {
      update[`preferences.${target}`] = FieldValue.delete(); // raw key — see upsertPreference
    }
    tx.set(ref, update, { merge: true });
    return true;
  });
}

// Removes one entry from a list-valued field (dietaryPreferences/allergies).
// appendUserListField dedups but only ever grows, so before this there was no
// way to correct a wrongly-recorded allergy short of deleting the account —
// and a phantom allergy silently degrades every recipe suggestion.
export async function removeUserListField(userId, field, value) {
  if (!db) return false;
  const ref = db.collection("users").doc(userId);
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) return false;
    const list = asList(doc.data()[field]);
    const next = list.filter((v) => String(v).toLowerCase() !== String(value).toLowerCase());
    if (next.length === list.length) return false;
    tx.set(ref, { [field]: next }, { merge: true });
    return true;
  });
}

// Appends to a list-valued field (dietaryPreferences/allergies) instead of
// overwriting it. Previously these were scalar last-write-wins fields, so a
// user's second distinct allergy mention silently erased the first — a real
// safety bug for a tool whose whole point is recipe-safety personalization.
// Dedups case-insensitively so re-stating the same fact doesn't grow the list.
// Capped because dietaryPreferences/allergies are the ONE remaining input to
// the always-injected system instruction that grows with usage. Dedup alone
// doesn't bound it — a model that files "no peanuts", "peanut allergy" and
// "avoid peanuts" as three distinct strings grows the list forever. Oldest
// entries are dropped first; 25 is far above any real dietary profile.
const MAX_LIST_FIELD_ENTRIES = 25;

export async function appendUserListField(userId, field, value) {
  if (!db) return;
  const ref = db.collection("users").doc(userId);
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const current = doc.exists ? doc.data()[field] || [] : [];
    const list = Array.isArray(current) ? current : [current];
    if (list.some((v) => String(v).toLowerCase() === String(value).toLowerCase())) return;
    tx.set(ref, { [field]: [...list, value].slice(-MAX_LIST_FIELD_ENTRIES) }, { merge: true });
  });
}

function asList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

// ============================================================
// PROFILE — small, curated, always-injected facts (name, home
// location, key people, personality). Distinct from the freeform
// `preferences` map above: these are structured fields captured
// through the setup form / recheck (see agents.js's update_profile
// tool and server.js's /api/user/:userId/profile route), not
// accreted incidentally from conversation the way `preferences` is.
//
// Kept as flat/whole-object top-level fields deliberately, same
// reasoning as `preferences` above: known issue #16 showed a dotted
// sub-path merge silently writes a literal dotted field name instead
// of nesting. Every write here replaces a whole field/object/array in
// one set() call, never a sub-path — so that bug class can't recur.
// ============================================================

export const DEFAULT_PERSONALITY = { tone: "warm", verbosity: "concise", proactivity: "proactive" };
const PERSONALITY_OPTIONS = {
  tone: ["warm", "direct", "playful"],
  verbosity: ["concise", "detailed"],
  proactivity: ["proactive", "on_request"],
};
const MAX_PEOPLE = 15;
const RECHECK_INTERVAL_DAYS = 30;

// Stores coordinates alongside the city name. IP geolocation only ever
// reports where the user is *at this moment*, so without a durable home
// coordinate there's no way to tell "at home" from "travelling" — which is
// exactly why home location is a curated profile field rather than
// something inferred per-connection. Geocoding failure is non-fatal: the
// city string alone is still useful context, so the field is written either
// way and simply carries no coords.
export async function setHomeLocation(userId, city) {
  const cityName = String(city).trim().slice(0, 100);
  const coords = await geocodeCity(cityName);
  await updateUserMemory(userId, {
    homeLocation: {
      city: cityName,
      lat: coords ? coords.lat : null,
      lon: coords ? coords.lon : null,
      updatedAt: new Date().toISOString(),
    },
  });
}

// Silently drops any axis with an unrecognised value instead of storing
// model/client-supplied garbage that buildPersonalityBlock would then have
// to guard against at template time.
export async function setPersonality(userId, personality) {
  const clean = { ...DEFAULT_PERSONALITY };
  for (const axis of Object.keys(PERSONALITY_OPTIONS)) {
    if (PERSONALITY_OPTIONS[axis].includes(personality?.[axis])) clean[axis] = personality[axis];
  }
  await updateUserMemory(userId, { personality: clean });
}

export async function markProfileReviewed(userId) {
  await updateUserMemory(userId, { lastProfileReviewAt: new Date().toISOString() });
}

// Upsert-by-name (case-insensitive) rather than blind append, so restating
// a person ("actually Sam is my fiancé now, not just partner") updates the
// relation in place instead of piling on a duplicate entry.
export async function addPerson(userId, name, relation) {
  if (!db) return;
  const ref = db.collection("users").doc(userId);
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const current = doc.exists && Array.isArray(doc.data().people) ? doc.data().people : [];
    const next = current.filter((p) => String(p.name).toLowerCase() !== String(name).toLowerCase());
    next.push({ name: String(name).slice(0, 80), relation: String(relation || "").slice(0, 40) });
    tx.set(ref, { people: next.slice(-MAX_PEOPLE) }, { merge: true });
  });
}

// Replaces the whole people list in one write. The setup form submits the
// complete list at once, and calling addPerson per entry would fire N
// concurrent transactions against the SAME document — Firestore serializes
// those with retries, so it's slow and needlessly contentious for data that
// is already known in full. addPerson stays for the incremental case (the
// update_profile tool adding one person mid-conversation).
export async function setPeople(userId, people) {
  const clean = (Array.isArray(people) ? people : [])
    .filter((p) => p && typeof p.name === "string" && p.name.trim())
    .slice(0, MAX_PEOPLE)
    .map((p) => ({
      name: String(p.name).trim().slice(0, 80),
      relation: String(p.relation || "").trim().slice(0, 40),
    }));
  await updateUserMemory(userId, { people: clean });
}

export async function removePerson(userId, name) {
  if (!db) return false;
  const ref = db.collection("users").doc(userId);
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) return false;
    const current = Array.isArray(doc.data().people) ? doc.data().people : [];
    const next = current.filter((p) => String(p.name).toLowerCase() !== String(name).toLowerCase());
    if (next.length === current.length) return false;
    tx.set(ref, { people: next }, { merge: true });
    return true;
  });
}

// Drives both mobile routing (should the setup form block home.tsx?) and the
// in-session recheck (should Argus lead with a check-in?). A name with no
// lastProfileReviewAt means an account that predates this feature — real
// production data (checked 2026-08-20) showed exactly this shape: accounts
// with a name captured incidentally via remember_preference but no
// structured home location/people. Routing those through the short recheck
// instead of the full interview avoids re-asking for a name that's already
// known, and IS the migration path for pre-existing accounts — no separate
// backfill script, since auto-parsing legacy freeform keys like
// "child_name" into structured people would be guesswork (see e.g. this
// same account's "conjugation assistance" entry, which isn't a person at
// all — a heuristic that pattern-matches key names would misfire on it).
export function computeProfileStatus(userMem) {
  if (!userMem.lastProfileReviewAt) {
    return userMem.name ? "recheck_due" : "needs_interview";
  }
  const daysSince = (Date.now() - new Date(userMem.lastProfileReviewAt).getTime()) / 86400000;
  return daysSince >= RECHECK_INTERVAL_DAYS ? "recheck_due" : "ok";
}

// ============================================================
// DAILY LOG — What happened today
// ============================================================

// A day's entries live in ONE document, and arrayUnion can only ever grow it —
// there is no cap in Firestore for that. A heavy day of log_daily_activity
// calls therefore walks the doc toward the hard 1MB document limit, at which
// point every further write for that day fails. This doc is also read on every
// single WebSocket connect (buildMemoryContext), so its size is on the
// connection-open latency path. Trimming to the most recent N inside a
// transaction bounds both, and replaces arrayUnion's read-free append with an
// isolated read-modify-write (arrayUnion was atomic but uncapped; a plain
// read-then-write would have been capped but racy — the transaction is both).
const MAX_DAILY_ENTRIES = 50;

export async function addDailyEntry(userId = "default", entry) {
  if (!db) return;
  const today = new Date().toISOString().split("T")[0];
  const ref = db.collection("users").doc(userId).collection("daily").doc(today);
  try {
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      const current = doc.exists ? doc.data().entries || [] : [];
      const next = [...current, { ...entry, timestamp: new Date().toISOString() }];
      tx.set(ref, { entries: next.slice(-MAX_DAILY_ENTRIES) }, { merge: true });
    });
  } catch (err) {
    console.error("Daily log error:", err.message);
  }
}

// `limit` caps how many entries come back (most recent first-in-order). Every
// caller feeds this either into the system instruction or into a tool response
// that goes straight to Gemini, so an unbounded return is unbounded prompt.
export async function getDailyLog(userId = "default", date = null, limit = MAX_DAILY_ENTRIES) {
  if (!db) return { entries: [] };
  const day = date || new Date().toISOString().split("T")[0];
  try {
    const doc = await db
      .collection("users")
      .doc(userId)
      .collection("daily")
      .doc(day)
      .get();
    if (!doc.exists) return { entries: [] };
    const data = doc.data();
    return { ...data, entries: (data.entries || []).slice(-limit) };
  } catch (err) {
    console.error("Daily read error:", err.message);
    return { entries: [] };
  }
}

// ============================================================
// SHOPPING LIST — Persistent across sessions
// ============================================================

export async function getShoppingList(userId = "default") {
  if (!db) return [];
  try {
    const doc = await db.collection("users").doc(userId).collection("lists").doc("shopping").get();
    return doc.exists ? doc.data().items || [] : [];
  } catch (err) {
    return [];
  }
}

export async function updateShoppingList(userId = "default", items) {
  if (!db) return;
  try {
    await db.collection("users").doc(userId).collection("lists").doc("shopping").set({
      items,
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error("Shopping list error:", err.message);
  }
}

// manage_shopping_list used to getShoppingList() then updateShoppingList() as
// two separate round trips — the same read-then-write race that was closed for
// preferences in 3200b3c but left open here. Two tool calls landing together
// (Gemini can emit several in one toolCall message) would each compute a new
// list from the same stale read, and the second write would silently drop the
// first one's items. `mutate` receives the current list and returns the next.
export async function mutateShoppingList(userId = "default", mutate) {
  if (!db) return mutate([]);
  const ref = db.collection("users").doc(userId).collection("lists").doc("shopping");
  try {
    return await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      const current = doc.exists ? doc.data().items || [] : [];
      const next = mutate(current);
      tx.set(ref, { items: next, updatedAt: new Date().toISOString() }, { merge: true });
      return next;
    });
  } catch (err) {
    console.error("Shopping list error:", err.message);
    return null;
  }
}

// ============================================================
// OBSERVATIONS — What Argus has seen recently
// ============================================================

export async function addObservation(userId = "default", observation) {
  if (!db) return;
  try {
    await db.collection("users").doc(userId).collection("observations").add({
      ...observation,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Observation error:", err.message);
  }
}

export async function getRecentObservations(userId = "default", limit = 10) {
  if (!db) return [];
  try {
    const snapshot = await db
      .collection("users")
      .doc(userId)
      .collection("observations")
      .orderBy("timestamp", "desc")
      .limit(limit)
      .get();
    return snapshot.docs.map((d) => d.data());
  } catch (err) {
    return [];
  }
}

// ============================================================
// DEVICE SECRET — Bearer credential bound to a userId, minted once
// on first use so later destructive calls (e.g. delete) can be
// authorized instead of trusting the self-asserted userId alone.
// ============================================================

export async function claimUserSecret(userId) {
  if (!db) return null;
  const ref = db.collection("users").doc(userId);
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (doc.exists) return null; // pre-existing doc (legacy or claimed) — never claimable by a stranger
    const secret = crypto.randomBytes(32).toString("hex");
    tx.set(ref, { deviceSecret: secret }, { merge: true });
    return secret;
  });
}

export async function verifyDeviceSecret(userId, secret) {
  if (!db || !secret) return false;
  try {
    const doc = await db.collection("users").doc(userId).get();
    const stored = doc.exists ? doc.data().deviceSecret : null;
    if (!stored) return false;
    const a = Buffer.from(stored);
    const b = Buffer.from(secret);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ============================================================
// GLOBAL CAPACITY — cross-instance concurrent-session budget
//
// connectionsByIp in server.js is per-Cloud-Run-instance memory, so it can't
// enforce a *fleet-wide* cap — with max-instances 10, a per-instance cap is
// effectively 10x looser than it looks. A single counter document would hit
// Firestore's documented ~1 sustained write/sec-per-document contention
// limit under bursty connect/disconnect at 200-concurrent scale, so this
// uses Firestore's standard sharded-counter pattern: writes are spread
// across N shards (cheap, no contention), reads sum all shards (only done
// once per new connection attempt, not per-message).
// ============================================================

const CAPACITY_SHARDS = 10;

function capacityShardRef(i) {
  return db.collection("_capacity").doc("global").collection("shards").doc(String(i));
}

// Attempts to reserve one global slot. `allowed` tells the caller whether to
// proceed; `shard` (only set when allowed by an actual reservation) must be
// passed to releaseGlobalSlot on disconnect. Fails open when Firestore is
// unavailable — a missing memory backend shouldn't also block every
// connection; the per-IP/per-instance limits still apply as a backstop —
// which is why `allowed` and "got a real shard" are tracked separately
// rather than both collapsing to a single null.
export async function reserveGlobalSlot(maxConcurrent) {
  if (!db) return { allowed: true, shard: null, count: null };
  try {
    const snaps = await Promise.all(
      Array.from({ length: CAPACITY_SHARDS }, (_, i) => capacityShardRef(i).get())
    );
    const total = snaps.reduce((sum, s) => sum + (s.exists ? s.data().count || 0 : 0), 0);
    if (total >= maxConcurrent) return { allowed: false, shard: null, count: total };
    const shard = Math.floor(Math.random() * CAPACITY_SHARDS);
    await capacityShardRef(shard).set({ count: FieldValue.increment(1) }, { merge: true });
    return { allowed: true, shard, count: total + 1 };
  } catch (err) {
    console.error("reserveGlobalSlot error:", err.message);
    return { allowed: true, shard: null, count: null };
  }
}

export async function releaseGlobalSlot(shard) {
  if (!db || shard === null || shard === undefined) return;
  try {
    await capacityShardRef(shard).set({ count: FieldValue.increment(-1) }, { merge: true });
  } catch (err) {
    console.error("releaseGlobalSlot error:", err.message);
  }
}

// ============================================================
// DELETE — Wipe all stored data for a user
// ============================================================

export async function deleteUserData(userId) {
  if (!db) return;
  await db.recursiveDelete(db.collection("users").doc(userId));
}

// ============================================================
// CONTEXT BUILDER — Compile memory into prompt context
// ============================================================

// Name/home location/people/dietary/allergies are auto-injected into every
// system instruction — small, bounded, and safety/latency-critical (or, for
// the profile fields, identity-critical) enough that the model shouldn't
// need a tool round-trip to know about them mid-turn. The general
// `preferences` map, shopping list, and recent observations used to be
// dumped in here too (unbounded, and — per production data pulled
// 2026-08-08 — never actually triggered a bloated prompt since no account
// had lived long enough to accumulate any). They're still fully available
// on demand via the recall_memory tool; front-loading them was pure
// duplication of a capability the model already had.
// Hard ceiling on anything user-derived that reaches the system instruction.
// Raised 600 -> 900 when home location/people were added — still headroom
// (measured 2026-08-09 pre-profile: the largest real account contributed 22
// characters), not a squeeze; its job is to guarantee the instruction can
// never grow with usage, which is the property that was missing rather than
// a size problem that existed.
const MAX_INJECTED_CHARS = 900;

function clamp(str, max) {
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

// Returns { text, personality, profileStatus, homeCity } rather than a bare
// string now that buildSystemInstruction needs more than prose out of this:
// personality drives its own template section (not a fact dumped into
// prose), and profileStatus/homeCity drive the conditional recheck block.
export async function buildMemoryContext(userId = "default") {
  const [userMem, dailyLog] = await Promise.all([
    getUserMemory(userId),
    getDailyLog(userId, null, 5),
  ]);

  let context = "";

  if (userMem.name) context += `User's name: ${clamp(String(userMem.name), 80)}. `;
  if (userMem.homeLocation && userMem.homeLocation.city) {
    context += `Home: ${clamp(String(userMem.homeLocation.city), 100)}. `;
  }
  const people = Array.isArray(userMem.people) ? userMem.people : [];
  if (people.length) {
    const list = people.map((p) => `${p.name}${p.relation ? ` (${p.relation})` : ""}`).join(", ");
    context += `Important people: ${clamp(list, 300)}. `;
  }
  const dietary = asList(userMem.dietaryPreferences);
  if (dietary.length) context += `Dietary preferences: ${clamp(dietary.join(", "), 200)}. `;
  const allergies = asList(userMem.allergies);
  if (allergies.length) context += `Allergies: ${clamp(allergies.join(", "), 200)}. `;

  // Today's activity — bounded at the read (last 5 entries of today's doc only)
  if (dailyLog.entries && dailyLog.entries.length > 0) {
    const summary = dailyLog.entries.map((e) => e.summary || e.type).join("; ");
    context += `\n\nToday so far: ${clamp(summary, 400)}. `;
  }

  return {
    text: clamp(context, MAX_INJECTED_CHARS),
    personality: { ...DEFAULT_PERSONALITY, ...(userMem.personality || {}) },
    profileStatus: computeProfileStatus(userMem),
    homeCity: (userMem.homeLocation && userMem.homeLocation.city) || null,
    homeLocation: userMem.homeLocation || null,
  };
}

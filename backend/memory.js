/**
 * Argus Memory System — Persistent context via Firestore
 * 
 * Stores observations, preferences, and daily context so Argus
 * remembers across sessions and throughout the day.
 */

import { Firestore, FieldValue } from "@google-cloud/firestore";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

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
// DAILY LOG — What happened today
// ============================================================

export async function addDailyEntry(userId = "default", entry) {
  if (!db) return;
  const today = new Date().toISOString().split("T")[0];
  try {
    await db
      .collection("users")
      .doc(userId)
      .collection("daily")
      .doc(today)
      .set(
        {
          entries: FieldValue.arrayUnion({
            ...entry,
            timestamp: new Date().toISOString(),
          }),
        },
        { merge: true }
      );
  } catch (err) {
    console.error("Daily log error:", err.message);
  }
}

export async function getDailyLog(userId = "default", date = null) {
  if (!db) return { entries: [] };
  const day = date || new Date().toISOString().split("T")[0];
  try {
    const doc = await db
      .collection("users")
      .doc(userId)
      .collection("daily")
      .doc(day)
      .get();
    return doc.exists ? doc.data() : { entries: [] };
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
// CONTEXT BUILDER — Compile memory into prompt context
// ============================================================

export async function buildMemoryContext(userId = "default") {
  const [userMem, dailyLog, shoppingList, recentObs] = await Promise.all([
    getUserMemory(userId),
    getDailyLog(userId),
    getShoppingList(userId),
    getRecentObservations(userId, 5),
  ]);

  let context = "";

  // User preferences
  if (userMem.name) context += `User's name: ${userMem.name}. `;
  if (userMem.dietaryPreferences) context += `Dietary preferences: ${userMem.dietaryPreferences}. `;
  if (userMem.allergies) context += `Allergies: ${userMem.allergies}. `;
  if (userMem.preferences) context += `Preferences: ${JSON.stringify(userMem.preferences)}. `;

  // Today's activity
  if (dailyLog.entries && dailyLog.entries.length > 0) {
    const recent = dailyLog.entries.slice(-5);
    context += `\n\nToday so far: ${recent.map((e) => e.summary || e.type).join("; ")}. `;
  }

  // Shopping list
  if (shoppingList.length > 0) {
    context += `\n\nCurrent shopping list: ${shoppingList.join(", ")}. `;
  }

  // Recent observations
  if (recentObs.length > 0) {
    context += `\n\nRecent observations: ${recentObs.map((o) => o.summary || o.scene).join("; ")}. `;
  }

  return context;
}

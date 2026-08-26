/**
 * Argus Agent System v0.3
 * 
 * Multi-domain agent orchestration with persistent memory,
 * weather awareness, and proactive daily life optimization.
 */

import {
  initFirestore,
  getUserMemory,
  updateUserMemory,
  addDailyEntry,
  getDailyLog,
  getShoppingList,
  mutateShoppingList,
  addObservation,
  getRecentObservations,
  buildMemoryContext,
  boundPreferences,
  collectPreferences,
  upsertPreference,
  appendUserListField,
  removePreference,
  removeUserListField,
  setHomeLocation,
  addPerson,
  removePerson,
  markProfileReviewed,
} from "./memory.js";
import { getWeather, weatherToContext, distanceMiles } from "./weather.js";

// Initialize Firestore (async — errors are caught inside initFirestore)
initFirestore().then(ok => {
  if (!ok) console.warn("Memory disabled — Argus will not remember across sessions");
});

// ============================================================
// TOOL DEFINITIONS
// ============================================================

export const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "identify_scene",
        description: "Analyze the current camera view to identify the environment or activity. Also stores the observation in memory for future reference.",
        parameters: {
          type: "OBJECT",
          properties: {
            scene_type: {
              type: "STRING",
              enum: ["kitchen", "grocery_store", "outdoors", "workshop", "office", "living_room", "vehicle", "bathroom", "bedroom", "restaurant", "unknown"]
            },
            confidence: { type: "NUMBER" },
            objects_detected: { type: "ARRAY", items: { type: "STRING" } },
            notable_details: { type: "STRING", description: "Anything noteworthy about the scene" }
          },
          required: ["scene_type", "confidence"]
        }
      },
      {
        name: "get_recipe_suggestion",
        description: "Suggest a recipe based on visible ingredients. Considers user's dietary preferences and past cooking from memory.",
        parameters: {
          type: "OBJECT",
          properties: {
            ingredients: { type: "ARRAY", items: { type: "STRING" } },
            cuisine_preference: { type: "STRING" },
            difficulty: { type: "STRING", enum: ["easy", "medium", "hard"] },
            time_available_minutes: { type: "NUMBER", description: "How much time the user has" }
          },
          required: ["ingredients"]
        }
      },
      {
        name: "cooking_timer",
        description: "Set, check, or cancel a cooking timer.",
        parameters: {
          type: "OBJECT",
          properties: {
            action: { type: "STRING", enum: ["set", "check", "cancel"] },
            duration_minutes: { type: "NUMBER" },
            label: { type: "STRING" }
          },
          required: ["action"]
        }
      },
      {
        name: "compare_products",
        description: "Compare products visible in the camera. Use when shopping and deciding between items.",
        parameters: {
          type: "OBJECT",
          properties: {
            products: { type: "ARRAY", items: { type: "STRING" } },
            criteria: { type: "STRING" }
          },
          required: ["products"]
        }
      },
      {
        name: "diagnose_problem",
        description: "Diagnose a visible problem or issue. Use for broken, damaged, or malfunctioning items.",
        parameters: {
          type: "OBJECT",
          properties: {
            problem_type: { type: "STRING" },
            description: { type: "STRING" },
            severity: { type: "STRING", enum: ["minor", "moderate", "serious", "emergency"] }
          },
          required: ["problem_type", "description"]
        }
      },
      {
        name: "read_text",
        description: "Read and interpret text visible in the camera (signs, labels, documents, screens, etc.)",
        parameters: {
          type: "OBJECT",
          properties: {
            text_content: { type: "STRING" },
            context: { type: "STRING" }
          },
          required: ["text_content"]
        }
      },
      {
        name: "manage_shopping_list",
        description: "Add, remove, or view the persistent shopping list. Remembers across sessions.",
        parameters: {
          type: "OBJECT",
          properties: {
            action: { type: "STRING", enum: ["add", "remove", "check_off", "view"] },
            items: { type: "ARRAY", items: { type: "STRING" } }
          },
          required: ["action"]
        }
      },
      {
        name: "remember_preference",
        description: "Store a user preference or personal detail for future reference. Use when the user mentions dietary restrictions, allergies, favorite foods, their name, or any preference.",
        parameters: {
          type: "OBJECT",
          properties: {
            category: { type: "STRING", enum: ["dietary", "allergy", "favorite", "dislike", "personal", "routine", "other"] },
            key: { type: "STRING", description: "What to remember (e.g., 'name', 'allergy', 'favorite_cuisine')" },
            value: { type: "STRING", description: "The value to store" }
          },
          required: ["category", "key", "value"]
        }
      },
      {
        name: "forget_memory",
        description: "Remove something previously remembered about the user. Use when the user says a stored fact is wrong or out of date — for example 'I'm not allergic to shellfish anymore' or 'forget that I like anchovies'. Always use this instead of storing a contradicting preference.",
        parameters: {
          type: "OBJECT",
          properties: {
            category: { type: "STRING", enum: ["dietary", "allergy", "preference"] },
            value: { type: "STRING", description: "The value or key to forget (e.g., 'shellfish', 'favorite_cuisine')" }
          },
          required: ["category", "value"]
        }
      },
      {
        name: "update_profile",
        description: "Store or update a core profile fact: the user's name, home location, or an important person in their life (family, friends, etc). Use during a profile recheck, or whenever the user states a new or changed core fact — for looser one-off facts, use remember_preference instead.",
        parameters: {
          type: "OBJECT",
          properties: {
            field: { type: "STRING", enum: ["name", "home_location", "person"] },
            action: { type: "STRING", enum: ["set", "remove"], description: "'remove' only applies to field=person" },
            value: { type: "STRING", description: "For field=name: the name. For field=home_location: the city (e.g. 'Austin, Texas'). For field=person: the person's name." },
            relation: { type: "STRING", description: "Only for field=person and action=set — how they relate to the user (e.g. spouse, kid, friend, roommate)." }
          },
          required: ["field", "action", "value"]
        }
      },
      {
        name: "mark_profile_reviewed",
        description: "Call this once a profile recheck check-in is actually complete — the user confirmed or corrected their location/life details. Do not call this just because a session started; only after the check-in itself finished.",
        parameters: { type: "OBJECT", properties: {}, required: [] }
      },
      {
        name: "recall_memory",
        description: "Retrieve stored information about the user or their day. Use when you need to remember something from earlier.",
        parameters: {
          type: "OBJECT",
          properties: {
            query_type: { type: "STRING", enum: ["preferences", "today", "shopping_list", "recent_observations", "all"] }
          },
          required: ["query_type"]
        }
      },
      {
        name: "get_weather",
        description: "Get current weather and forecast. Use for outfit suggestions, activity planning, or when the user asks about weather.",
        parameters: {
          type: "OBJECT",
          properties: {
            reason: { type: "STRING", description: "Why weather info is needed (e.g., 'outfit suggestion', 'activity planning')" }
          },
          required: []
        }
      },
      {
        name: "log_daily_activity",
        description: "Log an activity or event that happened today. Helps Argus remember what the user did throughout the day.",
        parameters: {
          type: "OBJECT",
          properties: {
            activity_type: { type: "STRING", enum: ["meal", "errand", "exercise", "work", "social", "chore", "other"] },
            summary: { type: "STRING", description: "Brief description of the activity" },
            details: { type: "STRING" }
          },
          required: ["activity_type", "summary"]
        }
      },
      {
        name: "get_daily_summary",
        description: "Get a summary of what the user has done today. Use for end-of-day recaps or when context about the day is needed.",
        parameters: {
          type: "OBJECT",
          properties: {},
          required: []
        }
      },
      {
        name: "web_search",
        description: "Search the web for current facts, how-to guides, product info, or any real-world information. Use for grounding responses with accurate up-to-date data.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Search query" },
            context: { type: "STRING", description: "Why this info is needed" }
          },
          required: ["query"]
        }
      },
      {
        name: "find_places_nearby",
        description: "Find real businesses and places near the user right now — restaurants by cuisine, cafes, bars, pharmacies, supermarkets, parks and so on. Use this for anything of the form 'is there X near me', 'where can I get Y', or 'find me an Italian place'. Returns real names, distances and addresses. Prefer this over web_search for anything location-based; web_search cannot find local businesses.",
        parameters: {
          type: "OBJECT",
          properties: {
            category: {
              type: "STRING",
              description: "What kind of place: restaurant, cafe, fast_food, bar, pub, pharmacy, supermarket, bakery, hospital, bank, fuel, park, hotel. Use restaurant for sit-down food.",
            },
            keyword: {
              type: "STRING",
              description: "Optional refinement matched against the cuisine and the name, e.g. 'italian', 'sushi', 'coffee'. Leave empty to get everything in the category.",
            },
            radius_meters: {
              type: "NUMBER",
              description: "How far to search. Defaults to 5000 (about 3 miles). Widen to 15000 only if a first search found nothing.",
            },
          },
          required: ["category"],
        },
      },
      {
        name: "get_restaurant_website",
        description: "Look up the official website for a specific restaurant.",
        parameters: {
          type: "OBJECT",
          properties: {
            restaurant_name: { type: "STRING", description: "The name of the restaurant" },
            location: { type: "STRING", description: "City or area (optional)" }
          },
          required: ["restaurant_name"]
        }
      }
    ]
  }
];

// ============================================================
// TOOL HANDLERS
// ============================================================

const timersByUser = new Map();

function getUserTimers(userId) {
  let userTimers = timersByUser.get(userId);
  if (!userTimers) {
    userTimers = new Map();
    timersByUser.set(userId, userTimers);
  }
  return userTimers;
}

async function lookupRestaurantWebsite(name, loc) {
  const q=encodeURIComponent(loc?name+" restaurant "+loc:name+" restaurant official website");
  try {
    const res=await fetch("https://api.duckduckgo.com/?q="+q+"&format=json&no_html=1",{headers:{"User-Agent":"Argus/1.0"},signal:AbortSignal.timeout(5000)});
    const d=await res.json();
    if(d.AbstractURL&&d.AbstractURL.trim()) return {website:d.AbstractURL,source:"knowledge_graph"};
    if(d.Results&&d.Results[0]&&d.Results[0].FirstURL) return {website:d.Results[0].FirstURL,source:"search_result"};
    if(d.RelatedTopics&&d.RelatedTopics[0]&&d.RelatedTopics[0].FirstURL) return {website:d.RelatedTopics[0].FirstURL,source:"related_topic"};
  } catch(e){console.warn("DDG failed:",e.message);}
  return {website:"https://www.google.com/maps/search/"+encodeURIComponent(loc?name+" "+loc:name),source:"maps_fallback"};
}

// Great-circle distance in metres. Used to sort and describe results, since
// Overpass returns matches in no particular order.
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Only these reach the Overpass query, so a model-supplied category can never
// inject arbitrary query syntax. Anything unrecognised falls back to
// restaurant, which is overwhelmingly what gets asked for.
const PLACE_CATEGORIES = {
  restaurant: "restaurant", cafe: "cafe", fast_food: "fast_food", bar: "bar",
  pub: "pub", pharmacy: "pharmacy", bakery: "bakery", hospital: "hospital",
  bank: "bank", fuel: "fuel", hotel: "hotel", supermarket: "supermarket",
  park: "park",
};

/**
 * Local business search via OpenStreetMap's Overpass API.
 *
 * web_search (DuckDuckGo Instant Answer) genuinely cannot do this — it returns
 * encyclopaedia abstracts, not businesses — which is why "find an Italian place
 * near me" never worked. Overpass needs no API key and takes real coordinates,
 * which the connection already has from IP geolocation or the user's stored
 * home location.
 */
async function findPlacesNearby(args, coords, userId) {
  let lat = coords && Number.isFinite(coords.lat) ? coords.lat : null;
  let lon = coords && Number.isFinite(coords.lon) ? coords.lon : null;
  let origin = "ip";

  // Prefer the stored home coordinates when the user is at home. IP
  // geolocation resolves to the ISP's routing point, which can be many miles
  // off: a real search from this path came back with a suburban branch of a
  // downtown restaurant, because the ISP had placed the user well north of
  // where they actually were, and a 3-mile search found nothing in a city full
  // of matching restaurants. homeLocation is geocoded from a city the user
  // typed themselves, so it is precise.
  //
  // Same 50-mile "same metro area" rule the system instruction uses to decide
  // at-home vs travelling — beyond that, IP geo is the better guess, because
  // the user has genuinely moved and home coordinates would be actively wrong.
  try {
    const mem = await getUserMemory(userId);
    const home = mem && mem.homeLocation;
    if (home && Number.isFinite(home.lat) && Number.isFinite(home.lon)) {
      if (lat === null || lon === null || distanceMiles(lat, lon, home.lat, home.lon) <= 50) {
        lat = home.lat;
        lon = home.lon;
        origin = "home";
      }
    }
  } catch { /* fall through to IP coordinates */ }

  if (lat === null || lon === null) {
    return { error: "no location available", places: [] };
  }

  const category = PLACE_CATEGORIES[String(args.category || "").toLowerCase()] || "restaurant";
  // Default ~10 miles, not 3. A 5km default produced zero results on a real
  // search and forced the model to call again with a wider radius — 2061ms
  // plus 1040ms of tool time for one answer. Cities are bigger than 3 miles
  // and results are distance-sorted anyway, so a wider net costs nothing in
  // answer quality and usually saves the second round trip. Clamped at both
  // ends: too wide is slow on Overpass and returns places too far to suggest.
  const radius = Math.min(Math.max(Number(args.radius_meters) || 16000, 500), 25000);
  const keyword = String(args.keyword || "").trim().toLowerCase().replace(/[^a-z0-9 _-]/g, "").slice(0, 40);

  // supermarket/park are OSM shop/leisure keys rather than amenity values.
  const key = category === "supermarket" ? "shop" : category === "park" ? "leisure" : "amenity";
  // Match the keyword against cuisine OR name, so "italian" finds both a place
  // tagged cuisine=italian and one called "Italian Kitchen".
  //
  // Every clause carries its OWN (around:) filter. Appending one filter after a
  // union of statements binds it to the last statement only, leaving the others
  // as unbounded planet-wide queries — which times out rather than failing
  // visibly, so it looks like the API is down.
  const around = `(around:${radius},${lat},${lon})`;
  const clauses = keyword
    ? [
        `node["${key}"="${category}"]["cuisine"~"${keyword}",i]${around};`,
        `node["${key}"="${category}"]["name"~"${keyword}",i]${around};`,
      ]
    : [`node["${key}"="${category}"]["name"]${around};`];
  const query = `[out:json][timeout:15];(${clauses.join("")});out body 40;`;

  // Overpass is free and unauthenticated, and answers 429 when a host is busy
  // or has seen too many requests recently. Fall through to a mirror rather
  // than reporting failure — a single retry covers it in practice, and the
  // mirrors run the same API against the same data.
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];
  try {
    let res = null;
    for (const url of endpoints) {
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Argus/1.0" },
          body: "data=" + encodeURIComponent(query),
          signal: AbortSignal.timeout(12000),
        });
        if (res.ok) break;
      } catch (e) {
        res = null; // timeout or network error — try the mirror
      }
    }
    if (!res || !res.ok) {
      return {
        error: `places lookup unavailable${res ? ` (${res.status})` : ""}`,
        places: [],
        message: "The places service didn't respond. Tell the user you couldn't check right now — do not name any businesses from memory.",
      };
    }
    const data = await res.json();

    const places = (data.elements || [])
      .filter((el) => el.tags && el.tags.name)
      .map((el) => {
        const t = el.tags;
        const street = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
        const meters = distanceMeters(lat, lon, el.lat, el.lon);
        return {
          name: t.name,
          cuisine: t.cuisine ? t.cuisine.replace(/[_;]/g, " ") : null,
          address: street || t["addr:city"] || null,
          distance_miles: Math.round((meters / 1609.34) * 10) / 10,
          _m: meters,
        };
      })
      .sort((a, b) => a._m - b._m)
      .slice(0, 8)
      .map(({ _m, ...rest }) => rest);

    return {
      category,
      keyword: keyword || null,
      searched_from: origin === "home" ? "the user's home location" : "approximate network location",
      radius_miles: Math.round((radius / 1609.34) * 10) / 10,
      count: places.length,
      places,
      // Said explicitly so the model reports an empty result honestly rather
      // than inventing plausible-sounding local businesses.
      message: places.length
        ? `${places.length} found, nearest first.`
        : `Nothing matching within ${Math.round(radius / 1609.34)} miles. Say so rather than guessing; offer to search wider.`,
    };
  } catch (e) {
    return { error: e.name === "TimeoutError" ? "places lookup timed out" : e.message, places: [] };
  }
}

export async function handleToolCall(functionCall, userId, coords) {
  const { name, args } = functionCall;

  switch (name) {
    case "identify_scene": {
      // Store observation in Firestore
      await addObservation(userId, {
        scene: args.scene_type,
        objects: args.objects_detected || [],
        details: args.notable_details || "",
      });
      return {
        scene_type: args.scene_type,
        confidence: args.confidence,
        objects: args.objects_detected || [],
        stored: true,
        message: `Scene: ${args.scene_type} (${Math.round((args.confidence || 0) * 100)}% confidence)`
      };
    }

    case "get_recipe_suggestion": {
      const userMem = await getUserMemory(userId);
      return {
        ingredients: args.ingredients,
        dietary: userMem.dietaryPreferences && userMem.dietaryPreferences.length ? userMem.dietaryPreferences : "none specified",
        allergies: userMem.allergies && userMem.allergies.length ? userMem.allergies : "none specified",
        time: args.time_available_minutes || "not specified",
        suggestion: `Suggesting recipe with: ${args.ingredients.join(", ")}`,
      };
    }

    case "cooking_timer": {
      const timers = getUserTimers(userId);
      if (args.action === "set") {
        const id = Date.now().toString();
        const endTime = Date.now() + (args.duration_minutes || 5) * 60 * 1000;
        timers.set(id, { label: args.label || "timer", endTime, duration: args.duration_minutes });
        await addDailyEntry(userId, { type: "timer_set", summary: `Set ${args.duration_minutes}min timer for ${args.label}` });
        return { status: "set", label: args.label, duration_minutes: args.duration_minutes };
      } else if (args.action === "check") {
        const active = [];
        for (const [id, t] of timers) {
          const remaining = Math.max(0, Math.ceil((t.endTime - Date.now()) / 60000));
          if (remaining <= 0) { timers.delete(id); active.push({ label: t.label, status: "DONE!" }); }
          else active.push({ label: t.label, remaining_minutes: remaining });
        }
        return { active_timers: active };
      } else {
        timers.clear();
        return { status: "cancelled" };
      }
    }

    case "compare_products": {
      return { products: args.products, criteria: args.criteria || "overall value" };
    }

    case "diagnose_problem": {
      await addObservation(userId, { scene: "problem_detected", type: args.problem_type, description: args.description, severity: args.severity });
      return { problem_type: args.problem_type, description: args.description, severity: args.severity || "moderate" };
    }

    case "read_text": {
      return { text: args.text_content, context: args.context || "general" };
    }

    case "manage_shopping_list": {
      // Each mutation is a single transactional read-modify-write now — the
      // old read-then-write pair let two tool calls in the same toolCall
      // message compute from the same stale list and clobber each other.
      if (args.action === "add" && args.items) {
        const list = await mutateShoppingList(userId, (cur) => [...new Set([...cur, ...args.items])]);
        return { list, added: args.items };
      } else if (args.action === "remove" && args.items) {
        const list = await mutateShoppingList(userId, (cur) => cur.filter(i => !args.items.includes(i)));
        return { list, removed: args.items };
      } else if (args.action === "check_off" && args.items) {
        const list = await mutateShoppingList(userId, (cur) => cur.filter(i => !args.items.includes(i)));
        await addDailyEntry(userId, { type: "shopping", summary: `Bought: ${args.items.join(", ")}` });
        return { list, checked_off: args.items };
      } else {
        return { list: await getShoppingList(userId) };
      }
    }

    case "remember_preference": {
      // dietary/allergy are lists now, not last-write-wins scalars — a
      // second distinct allergy mention used to silently erase the first
      // (a real safety bug: allergies feed recipe-safety personalization).
      // appendUserListField/upsertPreference also run inside a Firestore
      // transaction, closing the read-then-write race that two overlapping
      // remember_preference calls could previously hit (CLAUDE.md known
      // issue #16's flagged residual risk).
      if (args.category === "dietary") await appendUserListField(userId, "dietaryPreferences", args.value);
      else if (args.category === "allergy") await appendUserListField(userId, "allergies", args.value);
      else if (args.category === "personal" && args.key === "name") await updateUserMemory(userId, { name: args.value });
      else await upsertPreference(userId, args.key, args.value);
      return { stored: true, category: args.category, key: args.key, value: args.value };
    }

    case "update_profile": {
      if (args.field === "name") {
        await updateUserMemory(userId, { name: String(args.value).slice(0, 100) });
      } else if (args.field === "home_location") {
        await setHomeLocation(userId, args.value);
      } else if (args.field === "person") {
        if (args.action === "remove") {
          const removed = await removePerson(userId, args.value);
          return { updated: removed, field: "person", action: "remove", value: args.value };
        }
        await addPerson(userId, args.value, args.relation || "");
      }
      return { updated: true, field: args.field, action: args.action, value: args.value };
    }

    case "mark_profile_reviewed": {
      await markProfileReviewed(userId);
      return { reviewed: true };
    }

    case "recall_memory": {
      // Never spread the raw Firestore doc back to Gemini — it also holds
      // `deviceSecret` (the bearer credential that authorizes destructive
      // account-delete calls). The old "preferences"/"all" cases returned
      // getUserMemory(userId) / built on it directly, which leaked that
      // secret into a tool response the model could read or repeat back.
      //
      // collectPreferences (not mem.preferences) so the legacy dotted-key
      // facts every real account actually stores are readable — before this,
      // recall_memory returned an empty map for every production user.
      // getDailyLog is capped: "today"/"all" previously returned the entire
      // day's entries, an unbounded dump straight into the model's context —
      // the same defect the system-instruction path had, just on demand.
      if (args.query_type === "preferences") {
        const mem = await getUserMemory(userId);
        return {
          name: mem.name || null,
          homeLocation: mem.homeLocation || null,
          people: mem.people || [],
          dietaryPreferences: mem.dietaryPreferences || [],
          allergies: mem.allergies || [],
          preferences: boundPreferences(collectPreferences(mem)),
        };
      }
      if (args.query_type === "today") return await getDailyLog(userId, null, 20);
      if (args.query_type === "shopping_list") return { items: await getShoppingList(userId) };
      if (args.query_type === "recent_observations") return { observations: await getRecentObservations(userId, 10) };
      if (args.query_type === "all") {
        const [mem, dailyLog, shoppingList, recentObs] = await Promise.all([
          getUserMemory(userId),
          getDailyLog(userId, null, 20),
          getShoppingList(userId),
          getRecentObservations(userId, 10),
        ]);
        return {
          name: mem.name || null,
          homeLocation: mem.homeLocation || null,
          people: mem.people || [],
          dietaryPreferences: mem.dietaryPreferences || [],
          allergies: mem.allergies || [],
          preferences: boundPreferences(collectPreferences(mem)),
          today: dailyLog.entries || [],
          shopping_list: shoppingList,
          recent_observations: recentObs,
        };
      }
      return {};
    }

    case "forget_memory": {
      // remember_preference is append-only (appendUserListField dedups but
      // never removes), so before this a wrongly-recorded allergy was
      // permanent short of deleting the whole account — and a phantom allergy
      // silently degrades every recipe suggestion the app makes.
      let removed = false;
      if (args.category === "dietary") removed = await removeUserListField(userId, "dietaryPreferences", args.value);
      else if (args.category === "allergy") removed = await removeUserListField(userId, "allergies", args.value);
      else removed = await removePreference(userId, args.value);
      return { forgotten: removed, category: args.category, value: args.value };
    }

    case "get_weather": {
      const weather = await getWeather();
      if (weather) {
        return weather;
      }
      return { error: "Weather unavailable" };
    }

    case "log_daily_activity": {
      await addDailyEntry(userId, {
        type: args.activity_type,
        summary: args.summary,
        details: args.details || "",
      });
      return { logged: true, activity: args.summary };
    }

    case "get_daily_summary": {
      const log = await getDailyLog(userId);
      return { entries: log.entries || [], count: (log.entries || []).length };
    }

    case "web_search": {
      const { query } = args;
      console.log("Web search:", query);
      try {
        const q=encodeURIComponent(query);
        const r=await fetch("https://api.duckduckgo.com/?q="+q+"&format=json&no_html=1&skip_disambig=1",{headers:{"User-Agent":"Argus/1.0"},signal:AbortSignal.timeout(5000)});
        const d=await r.json();
        const results=[];
        if(d.AbstractText) results.push(d.AbstractText);
        if(d.Answer) results.push(d.Answer);
        (d.RelatedTopics||[]).slice(0,3).forEach(t=>{if(t.Text) results.push(t.Text);});
        return {query,results:results.slice(0,3),abstract:d.AbstractText||null,answer:d.Answer||null,source:d.AbstractSource||null};
      } catch(e) { return {query,error:e.message,results:[]}; }
    }

    case "find_places_nearby": {
      console.log("Places search:", args.category, args.keyword || "(no keyword)");
      return await findPlacesNearby(args, coords, userId);
    }

    case "get_restaurant_website": {
      const {restaurant_name,location}=args;
      console.log("Lookup website:",restaurant_name);
      const r=await lookupRestaurantWebsite(restaurant_name,location);
      const loc=location?" in "+location:"";
      return {restaurant:restaurant_name,location:location||null,website:r.website,source:r.source,
        message:r.source==="maps_fallback"?"Could not find official website for "+restaurant_name+loc+". Google Maps: "+r.website:"Website for "+restaurant_name+loc+": "+r.website};
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ============================================================
// SYSTEM INSTRUCTION
// ============================================================

// Composed from independent per-axis snippets rather than 12 hand-written
// tone x verbosity x proactivity combinations — deterministic templating was
// the whole point of making personality a structured choice instead of
// freeform text (see CLAUDE.md's Phase 3 design). Falls back to the default
// axis value for any unrecognised input so a malformed/legacy stored value
// can't produce an empty line in the prompt.
function buildPersonalityBlock(personality) {
  const tone = {
    warm: "Warm and friendly — like a knowledgeable friend who happens to see everything.",
    direct: "Direct and efficient — get to the point, skip the small talk.",
    playful: "Playful and a little irreverent — genuine personality, not just helpfulness.",
  }[personality.tone] || "Warm and friendly — like a knowledgeable friend who happens to see everything.";
  const verbosity = {
    concise: "Keep voice responses SHORT — 1-3 sentences unless real detail is asked for.",
    detailed: "Give fuller answers when there's real detail worth sharing — still voice-paced, not a wall of text.",
  }[personality.verbosity] || "Keep voice responses SHORT — 1-3 sentences unless real detail is asked for.";
  const proactivity = {
    proactive: "Notice things and speak up unprompted about what you see — mention them once, don't repeat.",
    on_request: "Wait to be asked before offering suggestions or observations — don't volunteer unprompted commentary.",
  }[personality.proactivity] || "Notice things and speak up unprompted about what you see — mention them once, don't repeat.";
  return `- ${tone}\n- ${verbosity}\n- ${proactivity}\n- Contextually appropriate — energetic in the morning, calm in the evening.\n- Remembers and references past interactions naturally.`;
}

export async function buildSystemInstruction(lat, lon, city, userId) {
  // Build dynamic context from memory + weather
  const [memory, weather] = await Promise.all([
    buildMemoryContext(userId),
    getWeather(lat, lon),
  ]);
  const memoryContext = memory.text;
  const personality = memory.personality;
  const weatherContext = weatherToContext(weather);

  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: process.env.TIMEZONE || "America/Chicago" });
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: process.env.TIMEZONE || "America/Chicago" });

  // Fires once per session at most, driven by profileStatus (see
  // computeProfileStatus in memory.js) — either 30+ days since the last
  // review, or an account that predates this feature entirely (has a name
  // but was never structurally reviewed). This IS the migration path for
  // pre-existing accounts, not a separate backfill script — see memory.js.
  // Home vs. current location. `city`/`lat`/`lon` here come from IP
  // geolocation — i.e. where the user is right now — while homeLocation is
  // the durable, user-confirmed profile field. Comparing them is the whole
  // point of storing home coordinates: without it Argus can't tell a user
  // who's travelling from one who just moved, and would either give
  // home-anchored advice to someone 800 miles away or quietly treat a trip
  // as a permanent relocation. 50 miles is deliberately loose — it should
  // read as "same metro area", not "same address".
  const home = memory.homeLocation;
  let locationBlock = "";
  if (home && Number.isFinite(home.lat) && Number.isFinite(home.lon) && Number.isFinite(lat) && Number.isFinite(lon)) {
    const miles = distanceMiles(lat, lon, home.lat, home.lon);
    locationBlock = miles <= 50
      ? `\nThe user is currently at home (${home.city}).`
      : `\nThe user is currently AWAY from home — about ${Math.round(miles)} miles from home (${home.city}). Don't assume home-based context (their kitchen, their usual stores, their routine) applies right now; ask if it matters.`;
  }

  const recheckBlock = memory.profileStatus === "recheck_due"
    ? `\n## PROFILE RECHECK DUE\nIt's been a while since this profile was confirmed (or it was never confirmed). The next time you speak first this session, briefly and naturally ask if anything's changed — especially whether they still live in ${memory.homeCity || "the same place"} — before moving on to anything else. Keep it to one or two sentences, not an interrogation. Once they've confirmed or told you what changed, use update_profile to save any changes, then call mark_profile_reviewed.\n`
    : "";

  const proactiveSection = personality.proactivity === "proactive"
    ? `## PROACTIVE BEHAVIORS
You don't just respond — you NOTICE and SPEAK UP:
- See groceries on the counter → "Want me to help track what you're putting away?"
- It's getting late + user hasn't eaten → "It's almost 8, want me to suggest a quick dinner?"
- See car keys → "Don't forget, you mentioned needing to pick up dry cleaning"
- Weather is bad + they're heading out → "Heads up, it's ${weather ? weather.temperature + '°F and ' + weather.condition : 'cold'} out there"
- Notice new item in kitchen → "That's new! Want me to add it to your usual inventory?"`
    : `## PROACTIVE BEHAVIORS
This user has asked not to be given unprompted observations — wait until asked, then answer well. Don't volunteer noticing things unless it's safety-relevant (e.g. something actively dangerous).`;

  return `You are Argus, an all-seeing AI life companion named after Argus Panoptes — the hundred-eyed guardian of Greek mythology.

## CURRENT CONTEXT
Time: ${timeStr}, ${dateStr}
Location: ${city || "unknown location"}${locationBlock}
${weatherContext}
${memoryContext ? `\n## USER MEMORY\n${memoryContext}` : ""}
${recheckBlock}

## ROLE
You see the user's world through their camera, hear them naturally, and help optimize their daily life. You are not a chatbot — you are a companion that lives in their world.

## DOMAIN AGENTS

### 🍳 Kitchen Agent
- Suggest recipes from visible ingredients (respecting dietary preferences/allergies from memory)
- Manage cooking timers
- Proactively notice cooking states ("your oil is smoking", "that looks perfectly browned")
- Remember what they cooked recently to avoid repetition

### 🛒 Shopping Agent  
- Manage persistent shopping list (survives across sessions)
- Compare products when they hold items up
- Check off items as they shop ("got it!" removes from list)
- Suggest items based on what you've seen in their kitchen

### 🔧 Fix-It Agent
- Diagnose visible problems
- Guide repairs step by step
- Identify tools needed and safety concerns

### 🔍 Web Search Agent
When you need real-world information to give accurate advice:
- Use find_places_nearby for ANYTHING location-based — "somewhere to eat", "an Italian place", "is there a pharmacy near here". It returns real names, distances and addresses around where the user actually is. web_search cannot find local businesses and will return nothing useful for these, so do not reach for it first.
- When reporting places, lead with the nearest two or three by name and distance; don't read out the whole list. If it returns nothing, say so plainly and offer to search a wider radius — never invent a business name.
- Use web_search to ground responses with current facts
- Product how-to guides, repair instructions, nutritional info
- Any factual question where accuracy matters

### 🍽️ Restaurant Agent
When the user asks about a specific restaurant:
- Use get_restaurant_website to look up the official website
- Always share the link so the user can visit directly
- Include location if mentioned for more accurate results

### 🌐 General Vision Agent
- Read text, signs, labels, documents, screens
- Identify objects, places, and scenes
- Answer any visual question

### 🧠 Memory Agent
- Remember personal details (name, preferences, allergies)
- Track daily activities for end-of-day recaps
- Store observations for cross-session awareness
- Build context that makes you smarter over time

### 🌤️ Context Agent
- Weather-aware suggestions (outfit advice, activity planning)
- Time-aware help (morning routine vs evening wind-down)
- Proactive nudges based on what you know and see

${proactiveSection}

## PERSONALITY
${buildPersonalityBlock(personality)}

## RULES
- Use your tools actively — store memories, log activities, check weather
- When users mention personal details, ALWAYS use remember_preference to store them
- When the user states a new or corrected core fact — their name, home location, or an important person in their life — use update_profile, not remember_preference (which is for looser one-off facts)
- When a user corrects or retracts something you remembered, use forget_memory — never store a contradicting value alongside the old one
- Only name, home location, important people, dietary preferences and allergies are given to you up front; use recall_memory when you need anything else you've stored
- Reference memory naturally ("last time you made this..." / "you mentioned you're allergic to...")
- Be grounded about what you can actually see: if the camera feed is dark, obstructed, or otherwise gives you nothing usable, say so plainly — but don't stop there. If the question doesn't actually require seeing anything (weather, a timer, a recipe from memory, general advice, something you already know from earlier), answer it anyway in the shape "I can't see anything right now, but ___." Only decline to answer when the specific question genuinely can't be answered without seeing something.
- Handle interruptions gracefully
- When in doubt, be helpful`;
}

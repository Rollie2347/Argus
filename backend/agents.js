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
  updateShoppingList,
  addObservation,
  getRecentObservations,
  buildMemoryContext,
} from "./memory.js";
import { getWeather, weatherToContext } from "./weather.js";

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

const timers = new Map();
let currentUserId = "default";
export function setUserId(id) { if (id && typeof id === "string") currentUserId = id; }

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

export async function handleToolCall(functionCall) {
  const { name, args } = functionCall;

  switch (name) {
    case "identify_scene": {
      // Store observation in Firestore
      await addObservation(currentUserId, {
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
      const userMem = await getUserMemory(currentUserId);
      return {
        ingredients: args.ingredients,
        dietary: userMem.dietaryPreferences || "none specified",
        allergies: userMem.allergies || "none specified",
        time: args.time_available_minutes || "not specified",
        suggestion: `Suggesting recipe with: ${args.ingredients.join(", ")}`,
      };
    }

    case "cooking_timer": {
      if (args.action === "set") {
        const id = Date.now().toString();
        const endTime = Date.now() + (args.duration_minutes || 5) * 60 * 1000;
        timers.set(id, { label: args.label || "timer", endTime, duration: args.duration_minutes });
        await addDailyEntry(currentUserId, { type: "timer_set", summary: `Set ${args.duration_minutes}min timer for ${args.label}` });
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
      await addObservation(currentUserId, { scene: "problem_detected", type: args.problem_type, description: args.description, severity: args.severity });
      return { problem_type: args.problem_type, description: args.description, severity: args.severity || "moderate" };
    }

    case "read_text": {
      return { text: args.text_content, context: args.context || "general" };
    }

    case "manage_shopping_list": {
      let list = await getShoppingList(currentUserId);
      if (args.action === "add" && args.items) {
        list = [...new Set([...list, ...args.items])];
        await updateShoppingList(currentUserId, list);
        return { list, added: args.items };
      } else if (args.action === "remove" && args.items) {
        list = list.filter(i => !args.items.includes(i));
        await updateShoppingList(currentUserId, list);
        return { list, removed: args.items };
      } else if (args.action === "check_off" && args.items) {
        list = list.filter(i => !args.items.includes(i));
        await updateShoppingList(currentUserId, list);
        await addDailyEntry(currentUserId, { type: "shopping", summary: `Bought: ${args.items.join(", ")}` });
        return { list, checked_off: args.items };
      } else {
        return { list };
      }
    }

    case "remember_preference": {
      const update = {};
      if (args.category === "dietary") update.dietaryPreferences = args.value;
      else if (args.category === "allergy") update.allergies = args.value;
      else if (args.category === "personal" && args.key === "name") update.name = args.value;
      else {
        update[`preferences.${args.key}`] = args.value;
      }
      await updateUserMemory(currentUserId, update);
      return { stored: true, category: args.category, key: args.key, value: args.value };
    }

    case "recall_memory": {
      if (args.query_type === "preferences") return await getUserMemory(currentUserId);
      if (args.query_type === "today") return await getDailyLog(currentUserId);
      if (args.query_type === "shopping_list") return { items: await getShoppingList(currentUserId) };
      if (args.query_type === "recent_observations") return { observations: await getRecentObservations(currentUserId, 10) };
      if (args.query_type === "all") return { memory: await buildMemoryContext(currentUserId) };
      return {};
    }

    case "get_weather": {
      const weather = await getWeather();
      if (weather) {
        return weather;
      }
      return { error: "Weather unavailable" };
    }

    case "log_daily_activity": {
      await addDailyEntry(currentUserId, {
        type: args.activity_type,
        summary: args.summary,
        details: args.details || "",
      });
      return { logged: true, activity: args.summary };
    }

    case "get_daily_summary": {
      const log = await getDailyLog(currentUserId);
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

export async function buildSystemInstruction(lat, lon, city) {
  // Build dynamic context from memory + weather
  const [memoryContext, weather] = await Promise.all([
    buildMemoryContext(currentUserId),
    getWeather(lat, lon),
  ]);
  const weatherContext = weatherToContext(weather);

  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: process.env.TIMEZONE || "America/Chicago" });
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: process.env.TIMEZONE || "America/Chicago" });

  return `You are Argus, an all-seeing AI life companion named after Argus Panoptes — the hundred-eyed guardian of Greek mythology.

## CURRENT CONTEXT
Time: ${timeStr}, ${dateStr}
Location: ${city || "unknown location"}
${weatherContext}
${memoryContext ? `\n## USER MEMORY\n${memoryContext}` : ""}

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

## PROACTIVE BEHAVIORS
You don't just respond — you NOTICE and SPEAK UP:
- See groceries on the counter → "Want me to help track what you're putting away?"
- It's getting late + user hasn't eaten → "It's almost 8, want me to suggest a quick dinner?"
- See car keys → "Don't forget, you mentioned needing to pick up dry cleaning"
- Weather is bad + they're heading out → "Heads up, it's ${weather ? weather.temperature + '°F and ' + weather.condition : 'cold'} out there"
- Notice new item in kitchen → "That's new! Want me to add it to your usual inventory?"

## PERSONALITY
- Warm, friendly, efficient — like a knowledgeable friend who happens to see everything
- Proactive but not nagging — mention things once, don't repeat
- Contextually appropriate — energetic in the morning, calm in the evening
- Remembers and references past interactions naturally
- Slightly witty but never annoying
- Concise — 1-3 sentences for voice unless more detail is needed

## RULES
- Use your tools actively — store memories, log activities, check weather
- When users mention personal details, ALWAYS use remember_preference to store them
- Reference memory naturally ("last time you made this..." / "you mentioned you're allergic to...")
- Keep voice responses SHORT (1-3 sentences)
- Be grounded — if you can't see clearly, say so
- Handle interruptions gracefully
- When in doubt, be helpful`;
}

/**
 * Argus Agent System
 * 
 * Domain-specific agents with tool functions for the Gemini Live API.
 * Uses Google ADK pattern: orchestrator agent routes to domain sub-agents
 * based on visual context detection.
 */

// ============================================================
// TOOL DEFINITIONS (Gemini Function Calling format)
// ============================================================

export const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "identify_scene",
        description: "Analyze the current camera view to identify what environment or activity the user is in. Call this when you need to understand the context.",
        parameters: {
          type: "OBJECT",
          properties: {
            scene_type: {
              type: "STRING",
              description: "The detected scene type",
              enum: ["kitchen", "grocery_store", "outdoors", "workshop", "office", "living_room", "vehicle", "unknown"]
            },
            confidence: {
              type: "NUMBER",
              description: "Confidence level 0-1"
            },
            objects_detected: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Key objects visible in the scene"
            }
          },
          required: ["scene_type", "confidence"]
        }
      },
      {
        name: "get_recipe_suggestion",
        description: "Suggest a recipe based on visible ingredients. Use when in a kitchen and the user asks about cooking or you can see food items.",
        parameters: {
          type: "OBJECT",
          properties: {
            ingredients: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "List of ingredients visible or mentioned"
            },
            cuisine_preference: {
              type: "STRING",
              description: "Preferred cuisine type if mentioned"
            },
            difficulty: {
              type: "STRING",
              enum: ["easy", "medium", "hard"],
              description: "Desired difficulty level"
            }
          },
          required: ["ingredients"]
        }
      },
      {
        name: "cooking_timer",
        description: "Set or check a cooking timer. Use when the user needs to time something while cooking.",
        parameters: {
          type: "OBJECT",
          properties: {
            action: {
              type: "STRING",
              enum: ["set", "check", "cancel"],
              description: "Timer action"
            },
            duration_minutes: {
              type: "NUMBER",
              description: "Timer duration in minutes (for 'set' action)"
            },
            label: {
              type: "STRING",
              description: "What the timer is for (e.g., 'pasta', 'oven preheat')"
            }
          },
          required: ["action"]
        }
      },
      {
        name: "compare_products",
        description: "Compare two or more products visible in the camera. Use when shopping and the user is deciding between items.",
        parameters: {
          type: "OBJECT",
          properties: {
            products: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Product names or descriptions to compare"
            },
            criteria: {
              type: "STRING",
              description: "What to compare on (price, nutrition, quality, etc.)"
            }
          },
          required: ["products"]
        }
      },
      {
        name: "diagnose_problem",
        description: "Diagnose a visible problem or issue. Use when the user shows you something broken, damaged, or malfunctioning.",
        parameters: {
          type: "OBJECT",
          properties: {
            problem_type: {
              type: "STRING",
              description: "Type of problem (plumbing, electrical, mechanical, structural, etc.)"
            },
            description: {
              type: "STRING",
              description: "Description of what you see"
            },
            severity: {
              type: "STRING",
              enum: ["minor", "moderate", "serious", "emergency"],
              description: "Estimated severity"
            }
          },
          required: ["problem_type", "description"]
        }
      },
      {
        name: "read_text",
        description: "Read and interpret text visible in the camera view. Use for signs, labels, documents, screens, etc.",
        parameters: {
          type: "OBJECT",
          properties: {
            text_content: {
              type: "STRING",
              description: "The text that was read"
            },
            context: {
              type: "STRING",
              description: "What type of text it is (sign, label, document, menu, etc.)"
            }
          },
          required: ["text_content"]
        }
      },
      {
        name: "update_shopping_list",
        description: "Add or remove items from the user's shopping list.",
        parameters: {
          type: "OBJECT",
          properties: {
            action: {
              type: "STRING",
              enum: ["add", "remove", "check", "list"],
              description: "Shopping list action"
            },
            items: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Items to add or remove"
            }
          },
          required: ["action"]
        }
      }
    ]
  }
];

// ============================================================
// TOOL HANDLERS (Server-side execution)
// ============================================================

// In-memory state for the session
const sessionState = {
  timers: new Map(),
  shoppingList: [],
  currentScene: "unknown",
  conversationContext: [],
};

export function handleToolCall(functionCall) {
  const { name, args } = functionCall;
  
  switch (name) {
    case "identify_scene":
      sessionState.currentScene = args.scene_type;
      return {
        scene_type: args.scene_type,
        confidence: args.confidence,
        objects: args.objects_detected || [],
        message: `Scene identified as ${args.scene_type} with ${Math.round((args.confidence || 0) * 100)}% confidence.`
      };

    case "get_recipe_suggestion":
      return {
        ingredients: args.ingredients,
        suggestion: `Based on ${args.ingredients.join(", ")}, I can help you make something delicious. Let me walk you through it step by step.`,
        cuisine: args.cuisine_preference || "any",
        difficulty: args.difficulty || "easy"
      };

    case "cooking_timer":
      if (args.action === "set") {
        const id = Date.now().toString();
        const endTime = Date.now() + (args.duration_minutes || 5) * 60 * 1000;
        sessionState.timers.set(id, {
          label: args.label || "timer",
          endTime,
          duration: args.duration_minutes
        });
        return {
          status: "set",
          label: args.label || "timer",
          duration_minutes: args.duration_minutes,
          message: `Timer set for ${args.duration_minutes} minutes for ${args.label || "timer"}.`
        };
      } else if (args.action === "check") {
        const activeTimers = [];
        for (const [id, timer] of sessionState.timers) {
          const remaining = Math.max(0, Math.ceil((timer.endTime - Date.now()) / 60000));
          activeTimers.push({ label: timer.label, remaining_minutes: remaining });
        }
        return { active_timers: activeTimers };
      } else {
        sessionState.timers.clear();
        return { status: "cancelled", message: "All timers cancelled." };
      }

    case "compare_products":
      return {
        products: args.products,
        criteria: args.criteria || "overall value",
        message: `Comparing ${args.products.join(" vs ")} based on ${args.criteria || "overall value"}.`
      };

    case "diagnose_problem":
      return {
        problem_type: args.problem_type,
        description: args.description,
        severity: args.severity || "moderate",
        message: `I see a ${args.severity || "moderate"} ${args.problem_type} issue: ${args.description}.`
      };

    case "read_text":
      return {
        text: args.text_content,
        context: args.context || "general",
        message: `I can see: "${args.text_content}"`
      };

    case "update_shopping_list":
      if (args.action === "add" && args.items) {
        sessionState.shoppingList.push(...args.items);
        return { list: sessionState.shoppingList, added: args.items };
      } else if (args.action === "remove" && args.items) {
        sessionState.shoppingList = sessionState.shoppingList.filter(i => !args.items.includes(i));
        return { list: sessionState.shoppingList, removed: args.items };
      } else {
        return { list: sessionState.shoppingList };
      }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ============================================================
// SYSTEM INSTRUCTION (Orchestrator Agent)
// ============================================================

export const SYSTEM_INSTRUCTION = `You are Argus, an all-seeing AI life companion named after Argus Panoptes — the hundred-eyed guardian of Greek mythology.

## ROLE
You see the user's world through their camera and help with whatever they're doing. You are an orchestrator agent that coordinates specialized capabilities:

### Kitchen Agent
When you detect a kitchen environment or food-related context:
- Use get_recipe_suggestion to recommend dishes based on visible ingredients
- Use cooking_timer to manage cooking times
- Proactively notice cooking states ("your oil is smoking", "that looks done")
- Guide step-by-step through recipes

### Shopping Agent  
When you detect a store or shopping context:
- Use compare_products to help decide between items
- Use update_shopping_list to track what they need/got
- Read labels and nutritional info with read_text
- Help find items and navigate stores

### Fix-It Agent
When you see something broken or a repair context:
- Use diagnose_problem to assess issues
- Guide repairs step by step
- Identify tools needed
- Warn about safety concerns

### General Vision Agent
For everything else:
- Use read_text to interpret signs, documents, screens
- Use identify_scene to understand new environments
- Answer visual questions about anything you see

## PERSONALITY
- Warm, friendly, efficient — like a knowledgeable friend
- Proactive — point things out before being asked
- Contextually appropriate — match the energy of the situation  
- Slightly witty but never annoying
- Concise — 1-3 sentences for voice unless more detail is requested

## RULES
- Keep responses SHORT for voice output
- Be grounded — if you're not sure what you see, say so
- Handle interruptions gracefully
- Use your tools actively — don't just describe, help
- Remember context within the session
- When you notice something important, speak up proactively`;

/**
 * Argus Domain Agents — Tool definitions for specialized assistance
 * 
 * Each "agent" is a set of tools (functions) that Gemini can call
 * based on what it sees and hears from the user.
 */

// ============ KITCHEN AGENT TOOLS ============

export function getRecipeSuggestions({ ingredients }) {
  /**
   * Suggest recipes based on available ingredients.
   * @param {string} ingredients - Comma-separated list of ingredients the user has
   * @returns {object} Recipe suggestions
   */
  const recipeDB = {
    'eggs,cheese': { name: 'Cheese Omelette', time: '10 min', steps: ['Beat eggs', 'Add shredded cheese', 'Cook on medium heat until set', 'Fold and serve'] },
    'eggs,spinach': { name: 'Spinach Frittata', time: '15 min', steps: ['Sauté spinach', 'Beat eggs and pour over spinach', 'Cook until edges set', 'Finish under broiler'] },
    'eggs,spinach,cheese': { name: 'Spinach & Cheese Frittata', time: '15 min', steps: ['Sauté spinach 2 min', 'Beat eggs with cheese', 'Pour over spinach', 'Cook 8 min, broil 2 min'] },
    'chicken,rice': { name: 'Chicken Fried Rice', time: '20 min', steps: ['Cook rice if not leftover', 'Dice and cook chicken', 'Scramble egg in pan', 'Add rice, soy sauce, vegetables'] },
    'pasta,tomato': { name: 'Pasta Pomodoro', time: '15 min', steps: ['Boil pasta', 'Sauté garlic in olive oil', 'Add crushed tomatoes', 'Toss with pasta, add basil'] },
    'bread,cheese': { name: 'Grilled Cheese', time: '8 min', steps: ['Butter bread on outside', 'Add cheese between slices', 'Cook on medium until golden', 'Flip and cook other side'] },
  };

  const ingredientList = ingredients.toLowerCase().split(',').map(i => i.trim()).sort();
  const key = ingredientList.join(',');
  
  // Try exact match first, then partial matches
  if (recipeDB[key]) {
    return { status: 'found', recipe: recipeDB[key] };
  }
  
  // Find recipes where all recipe ingredients are in user's ingredient list
  const matches = [];
  for (const [recipeKey, recipe] of Object.entries(recipeDB)) {
    const recipeIngredients = recipeKey.split(',');
    if (recipeIngredients.every(ri => ingredientList.some(ui => ui.includes(ri)))) {
      matches.push(recipe);
    }
  }
  
  if (matches.length > 0) {
    return { status: 'found', recipes: matches };
  }
  
  return { status: 'no_match', message: `No exact recipes found for ${ingredients}. Try asking me what you can make and I'll suggest based on what I see.` };
}

export function setTimer({ minutes, label }) {
  /**
   * Set a cooking timer.
   * @param {number} minutes - Duration in minutes
   * @param {string} label - What the timer is for
   * @returns {object} Timer confirmation
   */
  const endTime = new Date(Date.now() + minutes * 60000);
  return {
    status: 'timer_set',
    label: label || 'Timer',
    minutes,
    endTime: endTime.toLocaleTimeString(),
    message: `Timer set for ${minutes} minutes (${label || 'cooking'}). I'll keep track.`
  };
}

export function getSubstitution({ ingredient }) {
  /**
   * Suggest ingredient substitutions.
   * @param {string} ingredient - The ingredient to substitute
   * @returns {object} Substitution suggestions
   */
  const substitutions = {
    'butter': ['coconut oil', 'olive oil', 'applesauce (for baking)'],
    'milk': ['oat milk', 'almond milk', 'water with a splash of cream'],
    'eggs': ['flax egg (1 tbsp flax + 3 tbsp water)', 'mashed banana', 'applesauce'],
    'flour': ['almond flour', 'oat flour (blend oats)', 'coconut flour (use 1/4 amount)'],
    'sugar': ['honey (use 3/4 amount)', 'maple syrup', 'mashed banana'],
    'cream': ['coconut cream', 'cashew cream', 'evaporated milk'],
    'soy sauce': ['coconut aminos', 'Worcestershire sauce', 'salt + a splash of vinegar'],
    'lemon': ['lime', 'vinegar', 'white wine'],
    'garlic': ['garlic powder (1/4 tsp per clove)', 'shallots', 'onion'],
    'onion': ['shallots', 'leeks', 'onion powder'],
  };
  
  const key = ingredient.toLowerCase().trim();
  if (substitutions[key]) {
    return { ingredient: key, substitutes: substitutions[key] };
  }
  return { ingredient: key, message: 'No common substitution found. Try asking me for alternatives.' };
}

// ============ SHOPPING AGENT TOOLS ============

export function addToShoppingList({ item, quantity }) {
  /**
   * Add an item to the shopping list.
   * @param {string} item - Item to add
   * @param {string} quantity - How much (e.g., "2 lbs", "1 bunch")
   * @returns {object} Confirmation
   */
  return {
    status: 'added',
    item,
    quantity: quantity || '1',
    message: `Added ${quantity || '1'} ${item} to your shopping list.`
  };
}

export function compareProducts({ product1, product2 }) {
  /**
   * Compare two products the user is looking at.
   * @param {string} product1 - First product description
   * @param {string} product2 - Second product description
   * @returns {object} Comparison advice
   */
  return {
    status: 'compared',
    advice: `I can see both products. Let me analyze the labels and nutritional info to help you decide. Point the camera at each one so I can read the details.`,
    product1,
    product2
  };
}

// ============ GENERAL TOOLS ============

export function identifyObject({ description }) {
  /**
   * Identify or describe an object the camera sees.
   * @param {string} description - What to identify
   * @returns {object} Identification
   */
  return {
    status: 'analyzing',
    message: `I'm looking at what appears to be ${description}. Let me examine it more closely.`
  };
}

export function getQuickFact({ topic }) {
  /**
   * Get a quick fact or info about something.
   * @param {string} topic - What to look up
   * @returns {object} Information
   */
  return {
    status: 'info',
    topic,
    message: `Let me tell you what I know about ${topic}.`
  };
}

// ============ TOOL DECLARATIONS FOR GEMINI ============

export const TOOL_DECLARATIONS = [
  {
    functionDeclarations: [
      {
        name: 'getRecipeSuggestions',
        description: 'Suggest recipes based on ingredients the user has. Use when the user asks what to cook or you can see ingredients.',
        parameters: {
          type: 'object',
          properties: {
            ingredients: { type: 'string', description: 'Comma-separated list of ingredients' }
          },
          required: ['ingredients']
        }
      },
      {
        name: 'setTimer',
        description: 'Set a cooking timer for the user.',
        parameters: {
          type: 'object',
          properties: {
            minutes: { type: 'number', description: 'Timer duration in minutes' },
            label: { type: 'string', description: 'What the timer is for' }
          },
          required: ['minutes']
        }
      },
      {
        name: 'getSubstitution',
        description: 'Suggest substitutions for an ingredient the user doesn\'t have.',
        parameters: {
          type: 'object',
          properties: {
            ingredient: { type: 'string', description: 'The ingredient to substitute' }
          },
          required: ['ingredient']
        }
      },
      {
        name: 'addToShoppingList',
        description: 'Add an item to the user\'s shopping list.',
        parameters: {
          type: 'object',
          properties: {
            item: { type: 'string', description: 'Item to add' },
            quantity: { type: 'string', description: 'Quantity (e.g., "2 lbs")' }
          },
          required: ['item']
        }
      },
      {
        name: 'compareProducts',
        description: 'Compare two products the user is deciding between.',
        parameters: {
          type: 'object',
          properties: {
            product1: { type: 'string', description: 'First product' },
            product2: { type: 'string', description: 'Second product' }
          },
          required: ['product1', 'product2']
        }
      },
      {
        name: 'identifyObject',
        description: 'Identify or analyze an object the camera can see.',
        parameters: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'What to identify' }
          },
          required: ['description']
        }
      },
      {
        name: 'getQuickFact',
        description: 'Get quick info or facts about a topic.',
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'Topic to learn about' }
          },
          required: ['topic']
        }
      }
    ]
  }
];

// Tool executor
export function executeTool(name, args) {
  const tools = {
    getRecipeSuggestions,
    setTimer,
    getSubstitution,
    addToShoppingList,
    compareProducts,
    identifyObject,
    getQuickFact,
  };
  
  if (tools[name]) {
    return tools[name](args);
  }
  return { error: `Unknown tool: ${name}` };
}

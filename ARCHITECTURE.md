# Argus — Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     USER DEVICE (Phone)                      │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Camera      │  │  Microphone  │  │   Speaker    │      │
│  │  (Back/Front) │  │  (16kHz PCM) │  │ (24kHz PCM)  │      │
│  └──────┬───────┘  └──────┬───────┘  └──────▲───────┘      │
│         │                 │                  │               │
│  ┌──────▼─────────────────▼──────────────────┴──────┐       │
│  │              Progressive Web App (PWA)            │       │
│  │  • Camera capture → JPEG frames (every 2s)       │       │
│  │  • Audio capture → PCM16 chunks (real-time)       │       │
│  │  • Audio playback → sequential queue              │       │
│  │  • Dark Oracle UI with HUD overlay                │       │
│  └──────────────────────┬────────────────────────────┘       │
│                         │ WebSocket (wss://)                  │
└─────────────────────────┼────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                  GOOGLE CLOUD (Cloud Run)                     │
│                                                              │
│  ┌──────────────────────────────────────────────────┐       │
│  │              Express + WebSocket Server            │       │
│  │              (Node.js on Cloud Run)                │       │
│  │                                                    │       │
│  │  ┌────────────────────────────────────────┐       │       │
│  │  │         Session Manager                 │       │       │
│  │  │  • Client ↔ Gemini session mapping     │       │       │
│  │  │  • Audio/video frame relay              │       │       │
│  │  │  • Tool call execution                  │       │       │
│  │  └────────────────┬───────────────────────┘       │       │
│  │                   │                                │       │
│  │  ┌────────────────▼───────────────────────┐       │       │
│  │  │       Domain Agent Tools                │       │       │
│  │  │                                         │       │       │
│  │  │  🍳 Kitchen Agent                      │       │       │
│  │  │    • get_recipe_suggestion()             │       │       │
│  │  │    • cooking_timer()                         │       │       │
│  │  │    • remember_preference()                  │       │       │
│  │  │                                         │       │       │
│  │  │  🛒 Shopping Agent                     │       │       │
│  │  │    • manage_shopping_list()               │       │       │
│  │  │    • compare_products()                  │       │       │
│  │  │                                         │       │       │
│  │  │  🌐 General Agent                      │       │       │
│  │  │    • identify_scene()                   │       │       │
│  │  │    • web_search()                     │       │       │
│  │  └────────────────────────────────────────┘       │       │
│  └──────────────────────┬────────────────────────────┘       │
│                         │                                     │
│                         │ Gemini Live API                     │
│                         │ (Bidirectional WebSocket)           │
│                         ▼                                     │
│  ┌──────────────────────────────────────────────────┐       │
│  │          Gemini 2.5 Flash Native Audio            │       │
│  │                                                    │       │
│  │  • Real-time vision understanding                  │       │
│  │  • Natural language audio processing               │       │
│  │  • Voice activity detection (VAD)                  │       │
│  │  • Tool/function calling                           │       │
│  │  • Context-aware responses                         │       │
│  │  • Interruption handling (barge-in)                │       │
│  └──────────────────────────────────────────────────┘       │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Data Flow

### 1. User Speaks + Camera Captures
```
Phone Camera → JPEG (640x480, q=0.6) → WebSocket → Cloud Run → Gemini
Phone Mic    → PCM16 (16kHz, mono)   → WebSocket → Cloud Run → Gemini
```

### 2. Gemini Processes + Responds
```
Gemini → Audio PCM (24kHz) → Cloud Run → WebSocket → Phone Speaker
Gemini → Text (captions)   → Cloud Run → WebSocket → Phone UI
Gemini → Tool Calls        → Cloud Run → Execute → Results → Gemini
```

### 3. Tool Calling Flow
```
User: "What can I cook with these?"
  → Gemini sees ingredients via camera
  → Gemini calls getRecipeSuggestions({ingredients: "eggs, cheese, spinach"})
  → Backend executes tool, returns recipe data
  → Gemini synthesizes voice response with recipe steps
  → User hears: "I can see eggs, cheese and spinach — how about a frittata?"
```

## Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | Vanilla JS PWA | Camera/mic capture, audio playback, HUD UI |
| Transport | WebSocket (wss://) | Real-time bidirectional communication |
| Backend | Node.js + Express | Session management, tool execution |
| AI Model | Gemini 2.5 Flash Native Audio | Vision + audio understanding + generation |
| SDK | Google GenAI SDK | Live API bidi-streaming connection |
| Tools | Custom function declarations | Domain-specific agent capabilities |
| Hosting | Google Cloud Run | Serverless, auto-scaling container hosting |
| IaC | Terraform | Automated infrastructure deployment |
| Container | Docker | Reproducible build environment |

## Key Design Decisions

1. **Single Gemini session per user** — Each WebSocket connection maps to one Gemini Live API session, maintaining full conversation context
2. **Tool calling over separate agents** — Domain agents are implemented as Gemini function calls rather than separate LLM instances, reducing latency and cost
3. **JPEG frames at 2s intervals** — Balances visual awareness with bandwidth efficiency
4. **PCM16 audio** — Raw audio format for minimum latency (no codec overhead)
5. **Sequential audio queue** — Prevents overlapping voice responses
6. **Cloud Run with session affinity** — Ensures WebSocket connections persist to the same instance

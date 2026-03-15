# 🏛️ Argus — The All-Seeing Companion

> *Named after Argus Panoptes, the hundred-eyed guardian of Greek mythology.*
>
> **“A hundred eyes, so you don’t have to.”**

Argus is a real-time AI life companion that sees your world through your camera, hears you naturally, and helps optimize your daily life — cooking, shopping, navigating, fixing things — while remembering everything across sessions.

Built for the [Gemini Live Agent Challenge](https://geminiliveagentchallenge.devpost.com/) 🏆

---

## 🎯 What Makes Argus Different

Most AI assistants wait to be asked. Argus **watches, listens, and speaks up**:
- Sees your oil starting to smoke before you do
- Remembers you’re allergic to shellfish when you’re in a store
- Knows it’s going to rain and tells you before you head out
- Recalls what you bought last week when you’re making your shopping list

It’s not a chatbot with a camera. It’s a companion that lives in your world.

---

## ✨ Features

| Capability | What Argus Does |
|---|---|
| 👁️ **Real-time Vision** | Sees your world through the camera, understanding context in real-time |
| 🗣️ **Natural Voice** | Talk naturally, interrupt freely, no wake words |
| 🧠 **Persistent Memory** | Remembers preferences, allergies, daily activities across sessions (Firestore) |
| 🌤️ **Weather-Aware** | Live weather context for outfit/activity suggestions (Open-Meteo, no API key) |
| 🍳 **Kitchen Agent** | Sees ingredients, suggests recipes respecting your dietary needs, manages timers |
| 🛒 **Shopping Agent** | Persistent shopping list, label reading, product comparison, checks items off as you shop |
| 🔧 **Fix-It Agent** | Diagnoses visible problems, guides repairs, identifies tools needed |
| 🍽️ **Restaurant Agent** | Looks up official restaurant websites in real-time (grounded via web search) |
| 🔍 **Web Search** | Grounds responses with live web data for how-to guides, product info, facts |
| 📱 **Hands-Free Ready** | Works with a wearable camera necklace for true hands-free daily use |
| ⚡ **Proactive** | Speaks up before you ask |

---
## 🚀 Quick Start

### Prerequisites

- Node.js v20+
- A [Google AI Studio](https://aistudio.google.com/app/apikey) API key
- A Google Cloud project with Firestore enabled

### Local Development

```bash
# 1. Clone
git clone https://github.com/Rollie2347/Argus.git
cd Argus

# 2. Install dependencies
cd backend
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env — set GEMINI_API_KEY and GCP_PROJECT_ID at minimum

# 4. (Local only) Add Firestore service account
# Download service-account.json from GCP console and place in backend/
# See: https://console.cloud.google.com/iam-admin/serviceaccounts

# 5. Start the server
npm start
# http://localhost:8080

# 6. For phone testing (camera/mic require HTTPS)
cloudflared tunnel --url http://localhost:8080
```

### Environment Variables

| Variable | Description | Required |
|---|---|---|
| `GEMINI_API_KEY` | Google AI Studio API key | Required |
| `GCP_PROJECT_ID` | Google Cloud project ID | Required |
| `WEATHER_LAT` | Latitude for weather (default: Chicago 41.88) | Optional |
| `WEATHER_LON` | Longitude for weather (default: Chicago -87.63) | Optional |
| `TIMEZONE` | Timezone for time-aware context (default: America/Chicago) | Optional |
| `PORT` | Server port (default: 8080) | Optional |

> **Local development:** Place `service-account.json` (GCP service account key) in `backend/` for Firestore access. On Cloud Run, default credentials are used automatically.

---

## ☁️ Google Cloud Deployment

### Option A: Deploy Script (Recommended)

```bash
# From the repo root
./deploy-cloudrun.sh YOUR_GEMINI_API_KEY

# With custom location (optional)
./deploy-cloudrun.sh YOUR_GEMINI_API_KEY 40.71 -74.00 America/New_York
```

### Option B: Terraform (Infrastructure as Code)

```bash
cd terraform
terraform init
terraform apply \n  -var="gemini_api_key=YOUR_KEY" \n  -var="project_id=YOUR_PROJECT_ID"
```

Terraform provisions: Cloud Run service, Artifact Registry, all required GCP APIs, Firestore service, IAM bindings, and outputs the live URL.

### Option C: Manual gcloud

```bash
gcloud run deploy argus \n  --source . \n  --region us-central1 \n  --allow-unauthenticated \n  --set-env-vars "GEMINI_API_KEY=your_key,GCP_PROJECT_ID=your_project"
```

---

## 📱 Usage

1. Open the Argus URL on your phone
2. Tap **“Start Argus”** → grant camera + mic permissions
3. Tap the **📞** button to connect
4. Point your camera and start talking

### Example Interactions

```
“What can I cook with these ingredients?”
“Set a 10-minute timer for the pasta.”
“Which of these cereals is healthier?”
“How do I fix this leak?”
“What’s the website for Nobu?”
“Do I need an umbrella today?”
“Remember that I’m allergic to peanuts.”
“What did I eat today?”
“Read that label for me.”
“What do you see?”
```

---

## 📂 Project Structure

```
Argus/
├── backend/
│   ├── server.js          # Express + WebSocket + Gemini Live API relay
│   ├── agents.js          # 14 tools across 7 domain agents + system instruction
│   ├── memory.js          # Firestore persistent memory (cross-session)
│   ├── weather.js         # Real-time weather via Open-Meteo (no API key)
│   ├── package.json
│   └── .env.example
├── frontend/
│   └── index.html         # Vanilla JS PWA: camera + mic + audio playback
├── terraform/
│   └── main.tf            # Full GCP infrastructure as code
├── Dockerfile             # Multi-service container for Cloud Run
├── deploy-cloudrun.sh     # One-command deployment script
├── ARCHITECTURE.md        # Detailed system architecture
└── README.md
```

---

## 📄 License

MIT

---

## 🙏 Acknowledgments

- Built with [Gemini 2.5 Flash Native Audio Live API](https://ai.google.dev/)
- Persistent memory via [Google Cloud Firestore](https://cloud.google.com/firestore)
- Weather by [Open-Meteo](https://open-meteo.com/) (free, no API key)
- Web grounding by [DuckDuckGo Instant Answers](https://duckduckgo.com/api) (free, no API key)
- Named after [Argus Panoptes](https://en.wikipedia.org/wiki/Argus_Panoptes), the all-seeing guardian
- Created for the [Gemini Live Agent Challenge](https://geminiliveagentchallenge.devpost.com/) #GeminiLiveAgentChallenge

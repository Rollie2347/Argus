# 🏛️ Argus — The All-Seeing Companion

> *Named after Argus Panoptes, the hundred-eyed guardian of Greek mythology.*
> 
> **"A hundred eyes, so you don't have to."**

Argus is a real-time AI life companion that sees your world through your camera, hears you naturally, and helps with everyday tasks — cooking, shopping, navigating, fixing things — so you can focus on what actually matters.

Built for the [Gemini Live Agent Challenge](https://geminiliveagentchallenge.devpost.com/) 🏆

---

## 🎥 Demo

*Coming soon — 4-minute video showcasing Argus in daily life scenarios.*

---

## ✨ Features

- **👁️ Real-time Vision** — Argus sees what your camera sees, understanding your environment in real-time
- **🗣️ Natural Voice Conversation** — Talk naturally, interrupt freely, ask follow-ups
- **🧠 Context-Aware** — Detects what you're doing (cooking, shopping, driving) and adapts its help automatically
- **🍳 Cooking Guidance** — Sees your ingredients, suggests recipes, walks you through steps
- **🛒 Shopping Assistance** — Reads labels, compares products, tracks your list
- **🔧 Fix-it Help** — Identifies problems, guides repairs step by step
- **📱 Hands-Free Ready** — Works with a wearable camera necklace for true hands-free operation
- **⚡ Proactive** — Points things out before you ask ("your oil is starting to smoke")

---

## 🏗️ Architecture

```
┌──────────────────────────┐
│   User Device (Phone)    │
│  Camera + Mic + Speaker  │
│      React PWA           │
└───────────┬──────────────┘
            │ WebSocket (audio PCM16 + JPEG frames)
            ▼
┌──────────────────────────┐
│   Backend (Cloud Run)    │
│   Express + WebSocket    │
│   Node.js                │
└───────────┬──────────────┘
            │ Gemini Live API (bidi-streaming)
            ▼
┌──────────────────────────┐
│   Gemini 2.0 Flash       │
│   Live API               │
│   (Vision + Audio)       │
└──────────────────────────┘
```

### Tech Stack

| Component | Technology |
|-----------|-----------|
| AI Model | Gemini 2.5 Flash Native Audio (Live API) |
| SDK | Google GenAI SDK for Node.js |
| Agent Tools | 7 custom function declarations (recipes, timers, shopping, etc.) |
| Backend | Express + WebSocket (Node.js) |
| Frontend | Vanilla JS PWA (camera + mic) |
| Hosting | Google Cloud Run |
| IaC | Terraform (automated GCP deployment) |
| Container | Docker |

---

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v20+
- A [Google AI Studio](https://aistudio.google.com/) API key with Gemini access
- A Google Cloud project (for Cloud Run deployment)

### Local Development

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_USERNAME/argus.git
cd argus

# 2. Install dependencies
cd backend
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env and add your GEMINI_API_KEY

# 4. Start the server
npm start
# Server runs on http://localhost:8080

# 5. For phone testing (requires HTTPS for camera/mic):
# Option A: Cloudflare Tunnel (recommended)
cloudflared tunnel --url http://localhost:8080

# Option B: localtunnel
npx localtunnel --port 8080
```

### Environment Variables

| Variable | Description | Required |
|----------|------------|----------|
| `GEMINI_API_KEY` | Google AI Studio API key | ✅ |
| `GCP_PROJECT_ID` | Google Cloud project ID | For deployment |
| `PORT` | Server port (default: 8080) | No |

---

## ☁️ Google Cloud Deployment

### Using Cloud Run

```bash
# 1. Authenticate with Google Cloud
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# 2. Build and deploy
gcloud run deploy argus \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=your_key_here \
  --port 8080

# 3. Get your URL
gcloud run services describe argus --region us-central1 --format='value(status.url)'
```

### Using Docker

```bash
# Build
docker build -t argus .

# Run locally
docker run -p 8080:8080 --env-file backend/.env argus

# Push to GCR and deploy
docker tag argus gcr.io/YOUR_PROJECT_ID/argus
docker push gcr.io/YOUR_PROJECT_ID/argus
gcloud run deploy argus --image gcr.io/YOUR_PROJECT_ID/argus --region us-central1 --allow-unauthenticated
```

---

## 📱 Usage

1. Open the Argus URL on your phone
2. Tap **"Start Argus"** → grant camera & mic permissions
3. Tap the green **📞** button to connect
4. Point your camera and start talking!

### Tips
- Use the **back camera** (default) to show Argus your world
- Tap **🔄** to switch between front/back cameras
- Tap **🎤** to mute/unmute
- Speak naturally — Argus handles interruptions gracefully
- Works best in well-lit environments

### Example Interactions
- *"What do you see?"*
- *"What can I cook with these ingredients?"*
- *"Which product is healthier?"*
- *"How do I fix this?"*
- *"Read that sign for me"*

---

## 🎖️ Hackathon Category

**Live Agents 🗣️** — Real-time Interaction (Audio/Vision)

### Judging Criteria Alignment
- **Innovation & Multimodal UX (40%)**: Argus breaks the text box by being an always-on visual + voice companion that adapts to your context
- **Technical Implementation (30%)**: Built on Gemini Live API with bidi-streaming, proper error handling, and grounded responses
- **Demo & Presentation (30%)**: Real-world demo showing cooking, shopping, and daily tasks with a hands-free wearable camera

---

## 📂 Project Structure

```
argus/
├── backend/
│   ├── server.js          # Express + WebSocket + Gemini Live API
│   ├── package.json
│   ├── .env.example
│   └── ...
├── frontend/
│   └── index.html         # PWA with camera/mic/audio playback
├── Dockerfile             # Container for Cloud Run
├── README.md
└── ARCHITECTURE.md        # Detailed architecture diagram
```

---

## 🔮 Roadmap

- [ ] Multi-agent ADK architecture (specialized domain agents)
- [ ] Persistent memory across sessions (Firestore)
- [ ] Google Maps integration for navigation
- [ ] Shopping list management
- [ ] Recipe database grounding (Spoonacular)
- [ ] Proactive notifications
- [ ] Wearable camera companion app

---

## 📜 License

MIT

---

## 🙏 Acknowledgments

- Built with [Gemini 2.0 Flash Live API](https://ai.google.dev/)
- Named after [Argus Panoptes](https://en.wikipedia.org/wiki/Argus_Panoptes), the all-seeing guardian of Greek mythology
- Created for the [Gemini Live Agent Challenge](https://geminiliveagentchallenge.devpost.com/) #GeminiLiveAgentChallenge

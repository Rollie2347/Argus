"""
Argus — The All-Seeing Companion
Backend server: FastAPI + WebSocket relay to Gemini Live API
"""

import asyncio
import base64
import json
import os
import traceback
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from google import genai
from google.genai import types

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
MODEL = "gemini-2.0-flash-live"

SYSTEM_INSTRUCTION = """You are Argus, an all-seeing AI life companion named after Argus Panoptes — the hundred-eyed guardian of Greek mythology.

Your role: You see the user's world through their camera and help with whatever they're doing — cooking, shopping, navigation, fixing things, or just answering questions about what they see.

Your personality:
- Warm, friendly, and efficient — like a knowledgeable friend, not a corporate assistant
- Proactive — point out things you notice before being asked ("your oil is starting to smoke")
- Contextually appropriate — match the energy of the situation
- Slightly witty but never annoying
- Concise by default — short helpful responses, elaborate only when needed

Your capabilities:
- You can SEE through the user's camera in real-time
- You can HEAR the user speaking naturally
- You can SPEAK back with voice responses
- You remember context within the current session

Guidelines:
- If you see a kitchen/food scenario, offer cooking guidance
- If you see a store/products, help with shopping decisions
- If you see a road/driving scenario, help with navigation
- If you see something broken/a tool, offer fix-it guidance
- For anything else, be a helpful visual assistant
- Always be grounded — if you're not sure what you see, say so
- Handle interruptions gracefully — if the user changes topic mid-sentence, roll with it
- Keep responses SHORT for voice — 1-3 sentences unless they ask for detail
"""


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("🏛️ Argus backend starting...")
    yield
    print("🏛️ Argus backend shutting down...")


app = FastAPI(title="Argus", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    return {"status": "ok", "name": "Argus", "model": MODEL}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    print("👁️ Client connected")

    client = genai.Client(api_key=GEMINI_API_KEY)

    config = types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Puck")
            )
        ),
        system_instruction=types.Content(
            parts=[types.Part(text=SYSTEM_INSTRUCTION)]
        ),
    )

    try:
        async with client.aio.live.connect(model=MODEL, config=config) as session:
            print("🔗 Connected to Gemini Live API")

            async def receive_from_client():
                """Receive audio/video from browser WebSocket and forward to Gemini."""
                try:
                    while True:
                        data = await ws.receive_text()
                        msg = json.loads(data)

                        if msg["type"] == "audio":
                            # Audio chunk from browser (base64 PCM16 16kHz)
                            audio_bytes = base64.b64decode(msg["data"])
                            await session.send(
                                input=types.LiveClientRealtimeInput(
                                    media_chunks=[
                                        types.Blob(
                                            data=audio_bytes,
                                            mime_type="audio/pcm;rate=16000",
                                        )
                                    ]
                                )
                            )

                        elif msg["type"] == "image":
                            # Video frame from browser (base64 JPEG)
                            image_bytes = base64.b64decode(msg["data"])
                            await session.send(
                                input=types.LiveClientRealtimeInput(
                                    media_chunks=[
                                        types.Blob(
                                            data=image_bytes,
                                            mime_type="image/jpeg",
                                        )
                                    ]
                                )
                            )

                except WebSocketDisconnect:
                    print("👁️ Client disconnected")
                except Exception as e:
                    print(f"Error receiving from client: {e}")
                    traceback.print_exc()

            async def send_to_client():
                """Receive audio from Gemini and forward to browser WebSocket."""
                try:
                    async for response in session.receive():
                        if response.data:
                            # Audio response from Gemini (PCM16)
                            audio_b64 = base64.b64encode(response.data).decode("utf-8")
                            await ws.send_text(
                                json.dumps(
                                    {
                                        "type": "audio",
                                        "data": audio_b64,
                                    }
                                )
                            )

                        if response.text:
                            # Text response (for captions/display)
                            await ws.send_text(
                                json.dumps(
                                    {
                                        "type": "text",
                                        "data": response.text,
                                    }
                                )
                            )

                        if response.server_content and response.server_content.turn_complete:
                            await ws.send_text(
                                json.dumps({"type": "turn_complete"})
                            )

                except WebSocketDisconnect:
                    pass
                except Exception as e:
                    print(f"Error sending to client: {e}")
                    traceback.print_exc()

            # Run both directions concurrently
            await asyncio.gather(
                receive_from_client(),
                send_to_client(),
            )

    except Exception as e:
        print(f"Session error: {e}")
        traceback.print_exc()
        try:
            await ws.close()
        except:
            pass


# Serve frontend
FRONTEND_FILE = os.path.join(os.path.dirname(__file__), "..", "frontend", "index.html")
FRONTEND_DIST = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist", "index.html")


@app.get("/")
async def serve_frontend():
    for path in [FRONTEND_DIST, FRONTEND_FILE]:
        if os.path.exists(path):
            return FileResponse(path, media_type="text/html")
    return {"error": "Frontend not found"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)

#!/bin/bash
cd /home/moltbot/.openclaw/workspace/hackathons/gemini-live-agent-challenge/argus
git add -A
git commit -m "Fix: Use callbacks API for Gemini Live SDK (not event emitters)

- session.on() doesn't exist - SDK uses callbacks in connect()
- Added onmessage/onerror/onclose/onopen callbacks
- Added 'connected' message to frontend for better UX
- Added error display in frontend transcript"

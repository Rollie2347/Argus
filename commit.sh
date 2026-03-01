#!/bin/bash
cd /home/moltbot/.openclaw/workspace/hackathons/gemini-live-agent-challenge/argus
git rm --cached backend/.env 2>/dev/null
git add -A
git commit -m "Initial commit: Argus MVP - Live vision + voice AI companion"

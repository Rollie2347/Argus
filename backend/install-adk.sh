#!/bin/bash
cd /home/moltbot/.openclaw/workspace/hackathons/gemini-live-agent-challenge/argus/backend
npm install @google/adk @google-cloud/firestore 2>&1 | tail -10
echo "---DONE---"

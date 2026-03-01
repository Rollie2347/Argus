#!/bin/bash
cd /home/moltbot/.openclaw/workspace/hackathons/gemini-live-agent-challenge/argus
git branch -M main
git remote add origin https://github.com/Rollie2347/Argus.git 2>/dev/null || git remote set-url origin https://github.com/Rollie2347/Argus.git
git push -u origin main

#!/bin/bash
cd /home/moltbot/.openclaw/workspace/hackathons/gemini-live-agent-challenge/argus/backend
nohup node server.js > /tmp/argus.log 2>&1 &
echo "PID=$!"
sleep 2
cat /tmp/argus.log

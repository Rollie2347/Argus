#!/bin/bash
nohup /tmp/cloudflared tunnel --url http://localhost:8080 > /tmp/tunnel.log 2>&1 &
sleep 5
grep -o 'https://[^ ]*trycloudflare.com' /tmp/tunnel.log

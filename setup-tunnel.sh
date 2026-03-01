#!/bin/bash
# Install cloudflared and start tunnel
if ! command -v cloudflared &> /dev/null; then
    curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /tmp/cloudflared
    chmod +x /tmp/cloudflared
    sudo mv /tmp/cloudflared /usr/local/bin/cloudflared
fi
cloudflared tunnel --url http://localhost:8080

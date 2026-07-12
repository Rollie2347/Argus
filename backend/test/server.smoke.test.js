/**
 * Minimal smoke tests for the Argus backend.
 *
 * Scope is deliberately narrow: these run with a throwaway GEMINI_API_KEY
 * and no Firestore credentials, so they can run in CI/locally with zero
 * secrets and zero Gemini API cost. They verify the HTTP health check and
 * the WebSocket auth gate (WS_SHARED_SECRET) — NOT a full Gemini Live
 * round trip, which needs a real API key and network access to Google.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = 8091;
const WS_SHARED_SECRET = "smoke-test-secret";
const BASE_URL = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;

let child;

before(async () => {
  child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(PORT),
      GEMINI_API_KEY: "smoke-test-not-a-real-key",
      WS_SHARED_SECRET,
      GCP_PROJECT_ID: "smoke-test-project",
    },
    stdio: "pipe",
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Server did not become healthy within 10s");
});

after(() => {
  if (child) child.kill();
});

test("GET /api/health responds with server info", async () => {
  const res = await fetch(`${BASE_URL}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.name, "Argus");
  assert.ok(Array.isArray(body.tools) && body.tools.length > 0);
});

test("WS connection without a secret is rejected with code 4001", async () => {
  const ws = new WebSocket(WS_URL);
  const closeCode = await new Promise((resolve, reject) => {
    ws.on("open", () => {
      // Deliberately don't send a user_id/secret message — waitForAuth() should time out and reject.
    });
    ws.on("close", (code) => resolve(code));
    ws.on("error", reject);
  });
  assert.equal(closeCode, 4001);
});

test("WS connection with the wrong secret is rejected with code 4001", async () => {
  const ws = new WebSocket(WS_URL);
  const closeCode = await new Promise((resolve, reject) => {
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "user_id", id: "smoke-test-user", secret: "wrong-secret" }));
    });
    ws.on("close", (code) => resolve(code));
    ws.on("error", reject);
  });
  assert.equal(closeCode, 4001);
});

test("WS connection with the correct secret passes the auth gate", async () => {
  const ws = new WebSocket(WS_URL);
  // With the right secret, waitForAuth() resolves immediately and the server
  // moves on to opening a Gemini session — which fails fast here since
  // GEMINI_API_KEY isn't real. What we're asserting is that it does NOT get
  // the 4001 "unauthorized" close code auth failures get.
  const result = await new Promise((resolve, reject) => {
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "user_id", id: "smoke-test-user", secret: WS_SHARED_SECRET }));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "error" || msg.type === "connected") resolve({ type: msg.type });
    });
    ws.on("close", (code) => resolve({ closedWith: code }));
    ws.on("error", reject);
  });
  const gotAuthRejected = result.closedWith === 4001;
  assert.equal(gotAuthRejected, false);
});

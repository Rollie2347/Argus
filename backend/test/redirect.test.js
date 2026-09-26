/**
 * Tests for the marketing redirect counter (GET /g/:slug).
 *
 * Same constraints as server.smoke.test.js: throwaway credentials, no
 * Firestore, no Gemini calls, no cost. This route is deliberately synchronous
 * and touches no external service, so unlike the Live path it CAN be tested
 * properly rather than just smoke-checked.
 *
 * What these assert, and why each one exists:
 *   - 302 not 301        a cached redirect is an uncounted tap
 *   - no-store           same reason, belt and braces
 *   - unknown slug still redirects, because a typo'd bio link that 404s in
 *                        front of every viewer costs the whole post
 *   - ct only rides along when a provider token exists, since ct without pt
 *                        attributes nothing
 *   - a hostile ct is dropped rather than interpolated into the URL
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";

const PORT = 8092;
const BASE_URL = `http://localhost:${PORT}`;
const PROVIDER_TOKEN = "123456";

let child;
const logLines = [];

before(async () => {
  child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(PORT),
      GEMINI_API_KEY: "redirect-test-not-a-real-key",
      WS_SHARED_SECRET: "redirect-test-secret",
      GCP_PROJECT_ID: "redirect-test-project",
      APPSTORE_PROVIDER_TOKEN: PROVIDER_TOKEN,
    },
    stdio: "pipe",
  });
  child.stdout.on("data", (b) => logLines.push(...String(b).split("\n").filter(Boolean)));

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

after(() => { if (child) child.kill(); });

/** fetch without following the redirect, so the 302 itself is observable. */
const hit = (p, headers) => fetch(`${BASE_URL}${p}`, { redirect: "manual", headers });

const clickLogs = () => logLines
  .filter((l) => l.startsWith("{"))
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((j) => j && j.event === "marketing_click");

test("a known slug 302s to the App Store", async () => {
  const res = await hit("/g/01-fridge-stare-tt");
  assert.equal(res.status, 302);
  assert.ok(res.headers.get("location").startsWith("https://apps.apple.com/"));
});

test("the redirect is uncacheable — a cached hit would be an uncounted tap", async () => {
  const res = await hit("/g/01-fridge-stare-tt");
  assert.notEqual(res.status, 301, "301 would be cached by the browser and stop reporting taps");
  assert.match(res.headers.get("cache-control") || "", /no-store/);
});

test("a recognised slug is logged, with the platform suffix intact", async () => {
  await hit("/g/02-label-squint-ig");
  await new Promise((r) => setTimeout(r, 150));
  const entry = clickLogs().find((j) => j.slug === "02-label-squint-ig");
  assert.ok(entry, "expected a marketing_click line for the slug");
  assert.equal(entry.severity, "INFO");
});

test("a valid ct rides along when a provider token is configured", async () => {
  const res = await hit("/g/01-fridge-stare-tt?c=ps-2609-tt");
  const loc = res.headers.get("location");
  assert.match(loc, /[?&]pt=123456(&|$)/);
  assert.match(loc, /[?&]ct=ps-2609-tt(&|$)/);
  assert.match(loc, /[?&]mt=8(&|$)/);
});

test("a hostile ct is dropped, not interpolated into the destination", async () => {
  const res = await hit("/g/01-fridge-stare-tt?c=" + encodeURIComponent("x&foo=bar#evil"));
  const loc = res.headers.get("location");
  assert.equal(loc, "https://apps.apple.com/app/apple-store/id6761696821",
    "a ct failing the charset check must leave the URL completely untouched");
});

test("an over-long ct is dropped (Apple caps campaign tokens at 30)", async () => {
  const res = await hit("/g/01-fridge-stare-tt?c=" + "a".repeat(31));
  assert.ok(!res.headers.get("location").includes("ct="));
});

test("an unknown slug still lands the visitor on the App Store", async () => {
  const res = await hit("/g/this-deck-does-not-exist");
  assert.equal(res.status, 302);
  assert.ok(res.headers.get("location").startsWith("https://apps.apple.com/"));
});

test("a malformed slug redirects and is logged as unrecognised, not as a real slug", async () => {
  await hit("/g/" + encodeURIComponent("../../etc/passwd"));
  await new Promise((r) => setTimeout(r, 150));
  const bad = clickLogs().find((j) => j.slug === null);
  assert.ok(bad, "expected an unrecognised-slug line");
  assert.ok(!bad.rawSlug.includes("\n"), "raw slug must not carry a newline into the log");
});

test("bare /g redirects without requiring a slug", async () => {
  const res = await hit("/g");
  assert.equal(res.status, 302);
});

test("a control-character referrer cannot forge a log line", async () => {
  // Deliberately NOT fetch(): undici rejects a header value containing a
  // newline client-side, so a fetch-based version of this test would pass
  // without the request ever reaching the server — a pass for the wrong
  // reason. A real attacker writes the bytes directly, so the test does too.
  const raw = [
    "GET /g/03-under-the-sink-tt HTTP/1.1",
    `Host: localhost:${PORT}`,
    'Referer: https://evil.example/\r\n {"event":"marketing_click","slug":"forged"}',
    "Connection: close",
    "", "",
  ].join("\r\n");

  await new Promise((resolve) => {
    const sock = net.connect(PORT, "127.0.0.1", () => sock.end(raw));
    sock.on("data", () => {});
    sock.on("close", resolve);
    sock.on("error", resolve);
  });
  await new Promise((r) => setTimeout(r, 200));

  assert.ok(!clickLogs().some((j) => j.slug === "forged"),
    "a forged log line must not be injectable through the Referer header");
});

test("a normal referrer is reduced to its origin, dropping path and query", async () => {
  await hit("/g/04-menu-read-ig", { referer: "https://l.instagram.com/some/path?utm_content=secret" });
  await new Promise((r) => setTimeout(r, 150));
  const entry = clickLogs().find((j) => j.slug === "04-menu-read-ig");
  assert.equal(entry.ref, "https://l.instagram.com");
});

test("the redirect route is NOT behind the /api rate limiter", async () => {
  // 120 hits is twice the per-IP LOG budget and well past what a burst of real
  // taps from one CGNAT egress looks like. Every one must still redirect —
  // exceeding the budget is allowed to cost log lines, never redirects.
  const results = await Promise.all(
    Array.from({ length: 120 }, () => hit("/g/05-no-wake-word-tt"))
  );
  assert.ok(results.every((r) => r.status === 302),
    "a burst must never 429 — that would block real people reaching the App Store");
});

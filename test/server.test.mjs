import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

const testApiKey = "sk-test-123456789012345678901234";
const testUsername = "test_operator";
const testPassword = "test-only-strong-password";
const testSalt = randomBytes(16);
const testPasswordHash = `scrypt$${testSalt.toString("base64url")}$${scryptSync(testPassword, testSalt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64url")}`;
const calls = [];
let mockOpenAI;
let appProcess;
let appBaseUrl;
let sessionCookie;

function authenticatedHeaders(additional = {}) {
  return { cookie: sessionCookie, ...additional };
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function freePort() {
  const server = createServer();
  const selected = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return selected;
}

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The child process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("App server did not become healthy");
}

test.before(async () => {
  mockOpenAI = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = rawBody ? JSON.parse(rawBody) : null;
    calls.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body });

    if (req.url?.startsWith("/v1/models/")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "gpt-5.6-luna", object: "model" }));
    }

    const structured = body?.text?.format?.name === "churn_decision";
    const text = structured
      ? JSON.stringify({ churned: false, confidence: 0.82, reason: "長期利用のため継続と判定しました。", keyFactors: ["長期利用"] })
      : `${body?.input || ""}\n改善済み`;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text }] }] }));
  });
  const mockPort = await listen(mockOpenAI);
  const appPort = await freePort();
  appBaseUrl = `http://127.0.0.1:${appPort}`;
  appProcess = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(appPort),
      OPENAI_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
      OPENAI_MODEL: "gpt-5.6-luna",
      ALLOW_DEMO_MODE: "false",
      SESSION_SECRET: "test-session-secret-that-is-long-and-stable",
      AUTH_USERS_JSON: JSON.stringify([{ username: testUsername, passwordHash: testPasswordHash }]),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHealth(`${appBaseUrl}/api/health`);
  const loginResponse = await fetch(`${appBaseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: testUsername, password: testPassword }),
  });
  assert.equal(loginResponse.status, 200);
  sessionCookie = loginResponse.headers.get("set-cookie").split(";")[0];
});

test.after(async () => {
  if (appProcess && !appProcess.killed) appProcess.kill("SIGTERM");
  if (mockOpenAI) await new Promise((resolve) => mockOpenAI.close(resolve));
});

test("health endpoint describes BYOK mode and sends security headers", async () => {
  const response = await fetch(`${appBaseUrl}/api/health`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.apiKeyMode, "byok");
  assert.equal(payload.demoAllowed, false);
  assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("whitelist login creates an HttpOnly strict session", async () => {
  const response = await fetch(`${appBaseUrl}/api/auth/status`, { headers: authenticatedHeaders() });
  const payload = await response.json();
  assert.equal(payload.authenticated, true);
  assert.equal(payload.username, testUsername);

  const loginResponse = await fetch(`${appBaseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: testUsername, password: testPassword }),
  });
  const cookie = loginResponse.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
});

test("whitelist rejects invalid credentials without setting a session", async () => {
  const response = await fetch(`${appBaseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: testUsername, password: "incorrect-password" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 401);
  assert.equal(payload.code, "INVALID_CREDENTIALS");
  assert.equal(response.headers.get("set-cookie"), null);
});

test("protected endpoints reject unauthenticated requests", async () => {
  const response = await fetch(`${appBaseUrl}/api/key/validate`, { method: "POST", body: "{}" });
  const payload = await response.json();
  assert.equal(response.status, 401);
  assert.equal(payload.code, "AUTH_REQUIRED");
});

test("production mode rejects evaluation without an end-user key", async () => {
  const response = await fetch(`${appBaseUrl}/api/evaluate`, {
    method: "POST",
    headers: authenticatedHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ prompt: "test", persona: { id: "1", fields: { summary: "test" } } }),
  });
  assert.equal(response.status, 401);
});

test("key validation forwards the key for only that request", async () => {
  const response = await fetch(`${appBaseUrl}/api/key/validate`, {
    method: "POST",
    headers: authenticatedHeaders({ "content-type": "application/json", "x-openai-api-key": testApiKey }),
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal(calls.at(-1).authorization, `Bearer ${testApiKey}`);
  assert.match(calls.at(-1).url, /\/v1\/models\/gpt-5.6-luna/);
});

test("evaluation uses structured output and disables response storage", async () => {
  const response = await fetch(`${appBaseUrl}/api/evaluate`, {
    method: "POST",
    headers: authenticatedHeaders({ "content-type": "application/json", "x-openai-api-key": testApiKey }),
    body: JSON.stringify({
      prompt: "判定してください {{PERSONA_JSON}}",
      persona: { id: "1", fields: { "一文まとめ": "長期利用者" } },
      settings: { months: 6 },
      safetyIdentifier: "persona-sim-test-user",
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.churned, false);
  assert.equal(payload.mode, "openai");
  const call = calls.at(-1);
  assert.equal(call.authorization, `Bearer ${testApiKey}`);
  assert.equal(call.body.store, false);
  assert.equal(call.body.safety_identifier, "persona-sim-test-user");
  assert.equal(call.body.text.format.name, "churn_decision");
});

test("prompt refinement also uses the transient request key", async () => {
  const response = await fetch(`${appBaseUrl}/api/refine`, {
    method: "POST",
    headers: authenticatedHeaders({ "content-type": "application/json", "x-openai-api-key": testApiKey }),
    body: JSON.stringify({ currentPrompt: "base {{PERSONA_JSON}}", feedback: "継続要因を重視", context: "review" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.mode, "openai");
  assert.match(payload.prompt, /改善済み/);
  assert.equal(calls.at(-1).authorization, `Bearer ${testApiKey}`);
});

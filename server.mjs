import { createServer } from "node:http";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");

// Load a local .env when present without adding a runtime dependency.
try {
  const envFile = await readFile(join(root, ".env"), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
} catch {
  // .env is optional and must never contain an end-user API key.
}

const port = Number(process.env.PORT || 4173);
const model = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const demoAllowed = process.env.ALLOW_DEMO_MODE !== "false";
const openAIBaseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const sessionCookieName = "pcl_session";
const sessionMaxAgeSeconds = 8 * 60 * 60;
const sessionSecret = process.env.SESSION_SECRET || randomBytes(32).toString("base64url");

if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRETは32文字以上にしてください。");
}

if (!process.env.SESSION_SECRET) {
  console.warn("SESSION_SECRET is not set; sessions will be invalidated when the server restarts.");
}

let authUsers;
try {
  const source = process.env.AUTH_USERS_JSON || await readFile(join(root, "config", "auth-users.json"), "utf8");
  authUsers = JSON.parse(source);
  const validUsers = Array.isArray(authUsers) && authUsers.length > 0 && authUsers.every((user) => (
    typeof user?.username === "string" && user.username.length > 0 && user.username.length <= 128
    && typeof user?.passwordHash === "string" && user.passwordHash.startsWith("scrypt$")
  ));
  if (!validUsers || new Set(authUsers.map((user) => user.username)).size !== authUsers.length) throw new Error("whitelist is invalid");
} catch (error) {
  throw new Error(`認証ユーザーのホワイトリストを読み込めません: ${error.message}`);
}

const loginAttempts = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const decisionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    churned: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
    keyFactors: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 4,
    },
  },
  required: ["churned", "confidence", "reason", "keyFactors"],
};

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function cookieValue(req, name) {
  const cookie = req.headers.cookie || "";
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}

function sign(value) {
  return createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function createSession(username) {
  const payload = Buffer.from(JSON.stringify({ sub: username, exp: Date.now() + sessionMaxAgeSeconds * 1000 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readSession(req) {
  const token = cookieValue(req, sessionCookieName);
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;
  const payload = token.slice(0, separator);
  const supplied = Buffer.from(token.slice(separator + 1), "base64url");
  const expected = Buffer.from(sign(payload), "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.sub || !Number.isFinite(session.exp) || session.exp <= Date.now()) return null;
    if (!authUsers.some((user) => user.username === session.sub)) return null;
    return session;
  } catch {
    return null;
  }
}

function sessionCookie(value, maxAge = sessionMaxAgeSeconds) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${sessionCookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function verifyPassword(password, encoded) {
  const [algorithm, saltText, hashText] = String(encoded || "").split("$");
  if (algorithm !== "scrypt" || !saltText || !hashText) return false;
  try {
    const expected = Buffer.from(hashText, "base64url");
    const actual = scryptSync(password, Buffer.from(saltText, "base64url"), expected.length, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function clientAddress(req) {
  return req.socket.remoteAddress || "unknown";
}

function rateLimitState(req) {
  const key = clientAddress(req);
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    const fresh = { failures: 0, resetAt: now + 15 * 60 * 1000 };
    loginAttempts.set(key, fresh);
    return fresh;
  }
  return current;
}

async function login(req, res) {
  const attempt = rateLimitState(req);
  if (attempt.failures >= 5) {
    return json(res, 429, { error: "ログイン試行回数が上限に達しました。15分後に再試行してください。", code: "LOGIN_RATE_LIMITED" });
  }
  const { username = "", password = "" } = await readBody(req);
  const suppliedUsername = String(username).slice(0, 129);
  const suppliedPassword = String(password).slice(0, 1025);
  const user = authUsers.find((candidate) => candidate.username === suppliedUsername);
  const valid = suppliedUsername.length <= 128 && suppliedPassword.length <= 1024
    && (user ? verifyPassword(suppliedPassword, user.passwordHash) : verifyPassword(suppliedPassword, "scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
  if (!user || !valid) {
    attempt.failures += 1;
    return json(res, 401, { error: "ユーザー名またはパスワードが正しくありません。", code: "INVALID_CREDENTIALS" });
  }
  loginAttempts.delete(clientAddress(req));
  res.setHeader("set-cookie", sessionCookie(createSession(user.username)));
  return json(res, 200, { authenticated: true, username: user.username });
}

function logout(_req, res) {
  res.setHeader("set-cookie", sessionCookie("", 0));
  return json(res, 200, { authenticated: false });
}

function requireAuth(req, res) {
  const session = readSession(req);
  if (session) return session;
  json(res, 401, { error: "ログインが必要です。", code: "AUTH_REQUIRED" });
  return null;
}

function setSecurityHeaders(res) {
  res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("リクエストが大きすぎます。");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function hashToUnit(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function mockDecision(persona, settings) {
  const source = Object.values(persona.fields || persona).join(" ");
  const reasons = [];
  let risk = 0.32 + (hashToUnit(String(persona.id || source.slice(0, 80))) - 0.5) * 0.18;

  const add = (pattern, score, text) => {
    if (pattern.test(source)) {
      risk += score;
      reasons.push(text);
    }
  };

  add(/料金が安|価格感度|節約|乗り換え|格安スマホ/, 0.14, "料金・乗り換えメリットへの感度がある");
  add(/不満|推奨度は[0-5]|NPSは[0-5]/, 0.12, "現契約への満足・推奨が強くない");
  add(/比較|自分で調べ|手間.*いとわない/, 0.08, "比較検討や自己解決への抵抗が小さい");
  add(/長期利用|安心感|変更は面倒|店舗|コールセンター/, -0.15, "長期利用とサポートへの安心感が継続を後押しする");
  add(/家族.*ドコモ|セット割|光/, -0.08, "家族・固定回線との結びつきがある");
  add(/100GB|大容量|通信品質/, -0.03, "現在の通信品質・容量への依存がある");

  const months = Number(settings?.months || 6);
  risk += Math.min(Math.max(months - 6, 0), 18) * 0.006;
  risk = Math.max(0.05, Math.min(0.91, risk));
  const churned = risk >= 0.5;
  const keyFactors = reasons.slice(0, 3);
  if (!keyFactors.length) keyFactors.push("プロフィール全体から見た現契約への中程度の定着");
  const reason = churned
    ? `${months}か月の検討期間では、${keyFactors.join("、")}ため、より条件の合う回線へ移る可能性が高いと判断しました。`
    : `${months}か月後も、${keyFactors.join("、")}ため、現契約を継続する可能性が高いと判断しました。`;

  return {
    churned,
    confidence: Number((0.55 + Math.abs(risk - 0.5) * 0.75).toFixed(2)),
    reason,
    keyFactors,
    mode: "demo",
  };
}

function outputText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") return content.text;
    }
  }
  return "";
}

function requestApiKey(req) {
  const header = req.headers["x-openai-api-key"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return "";
  const trimmed = value.trim();
  return trimmed.length >= 20 && trimmed.length <= 512 ? trimmed : "";
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 15_000);
  return Math.min(800 * (2 ** attempt), 8_000) + Math.floor(Math.random() * 250);
}

async function openAIRequest(apiKey, path, init, maxAttempts = 3) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    let response;
    try {
      response = await fetch(`${openAIBaseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...(init.headers || {}),
        },
      });
    } catch (error) {
      clearTimeout(timer);
      if (attempt < maxAttempts - 1) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelay({ headers: new Headers() }, attempt)));
        continue;
      }
      const requestError = new Error(error.name === "AbortError" ? "OpenAI APIがタイムアウトしました。" : "OpenAI APIへ接続できませんでした。");
      requestError.status = 502;
      throw requestError;
    }
    clearTimeout(timer);

    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts - 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelay(response, attempt)));
      continue;
    }
    const apiError = new Error(payload?.error?.message || `OpenAI API error (${response.status})`);
    apiError.status = response.status === 401 || response.status === 403 ? 401 : response.status;
    throw apiError;
  }
  throw new Error("OpenAI API request failed");
}

async function callOpenAI(apiKey, input, format, safetyIdentifier) {
  const payload = await openAIRequest(apiKey, "/responses", {
    method: "POST",
    body: JSON.stringify({
      model,
      input,
      store: false,
      ...(safetyIdentifier ? { safety_identifier: safetyIdentifier } : {}),
      ...(format ? { text: { format } } : {}),
    }),
  });
  const text = outputText(payload);
  if (!text) {
    const outputError = new Error("OpenAI APIから判定テキストを取得できませんでした。");
    outputError.status = 502;
    throw outputError;
  }
  return text;
}

async function evaluate(req, res) {
  const { prompt, persona, settings, safetyIdentifier } = await readBody(req);
  if (!prompt || !persona) return json(res, 400, { error: "prompt と persona は必須です。" });
  const apiKey = requestApiKey(req);
  if (!apiKey && demoAllowed) return json(res, 200, mockDecision(persona, settings));
  if (!apiKey) return json(res, 401, { error: "このセッションで使用するOpenAI APIキーを設定してください。", code: "API_KEY_REQUIRED" });

  const personaJson = JSON.stringify(persona.fields || persona, null, 2);
  const input = prompt.includes("{{PERSONA_JSON}}")
    ? prompt.replace("{{PERSONA_JSON}}", personaJson)
    : `${prompt}\n\n# 判定対象ペルソナ\n${personaJson}`;
  const raw = await callOpenAI(apiKey, input, {
    type: "json_schema",
    name: "churn_decision",
    strict: true,
    schema: decisionSchema,
  }, safetyIdentifier);
  const result = JSON.parse(raw);
  return json(res, 200, { ...result, mode: "openai" });
}

async function refine(req, res) {
  const { currentPrompt, feedback, context = "review", safetyIdentifier } = await readBody(req);
  if (!currentPrompt || !feedback) return json(res, 400, { error: "プロンプトとフィードバックは必須です。" });

  const apiKey = requestApiKey(req);
  if (!apiKey && demoAllowed) {
    const marker = `\n\n# 作業者フィードバックによる追加ルール (${context})\n${feedback.trim()}\n上記を判定基準に反映し、理由にも反映内容が分かるようにする。`;
    return json(res, 200, { prompt: `${currentPrompt.trim()}${marker}`, mode: "demo" });
  }
  if (!apiKey) return json(res, 401, { error: "プロンプトを改善するにはOpenAI APIキーを設定してください。", code: "API_KEY_REQUIRED" });

  const instruction = `あなたはLLM評価プロンプトの設計者です。以下のモバイル契約解約判定プロンプトを、作業者のフィードバックを反映して改善してください。元の目的、JSON出力仕様、{{PERSONA_JSON}}プレースホルダーは必ず維持してください。改善後のプロンプト本文だけを返してください。\n\n## 現在のプロンプト\n${currentPrompt}\n\n## フィードバック\n${feedback}`;
  const prompt = await callOpenAI(apiKey, instruction, undefined, safetyIdentifier);
  return json(res, 200, { prompt, mode: "openai" });
}

async function validateKey(req, res) {
  const apiKey = requestApiKey(req);
  if (!apiKey) return json(res, 401, { error: "有効な形式のOpenAI APIキーを入力してください。", code: "API_KEY_REQUIRED" });
  await openAIRequest(apiKey, `/models/${encodeURIComponent(model)}`, { method: "GET", headers: {} }, 1);
  return json(res, 200, { valid: true, model });
}

function safeStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const base = relative.startsWith("sample_data/") ? root : publicDir;
  const target = resolve(base, normalize(relative));
  const resolvedBase = resolve(base);
  if (target !== resolvedBase && !target.startsWith(`${resolvedBase}${sep}`)) return null;
  return target;
}

async function serveStatic(req, res) {
  let target = safeStaticPath(req.url || "/");
  if (!target) return json(res, 403, { error: "Forbidden" });
  try {
    const info = await stat(target);
    if (info.isDirectory()) target = join(target, "index.html");
    const content = await readFile(target);
    res.writeHead(200, {
      "content-type": mimeTypes[extname(target)] || "application/octet-stream",
      "content-length": content.length,
      "cache-control": target.endsWith(".csv") ? "no-cache" : "public, max-age=60",
    });
    res.end(content);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

const server = createServer(async (req, res) => {
  setSecurityHeaders(res);
  try {
    if (req.method === "GET" && req.url === "/api/health") {
      return json(res, 200, {
        ok: true,
        apiKeyMode: "byok",
        demoAllowed,
        model,
      });
    }
    if (req.method === "GET" && req.url === "/api/auth/status") {
      const session = readSession(req);
      return json(res, 200, { authenticated: Boolean(session), username: session?.sub || null });
    }
    if (req.method === "POST" && req.url === "/api/auth/login") return await login(req, res);
    if (req.method === "POST" && req.url === "/api/auth/logout") return logout(req, res);
    if (req.method === "POST" && req.url === "/api/key/validate") return requireAuth(req, res) && await validateKey(req, res);
    if (req.method === "POST" && req.url === "/api/evaluate") return requireAuth(req, res) && await evaluate(req, res);
    if (req.method === "POST" && req.url === "/api/refine") return requireAuth(req, res) && await refine(req, res);
    if (req.method === "GET" && req.url?.startsWith("/sample_data/")) return requireAuth(req, res) && await serveStatic(req, res);
    if (req.method === "GET") return await serveStatic(req, res);
    json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error(`[${error.name || "Error"}] ${error.message || "request failed"}`);
    json(res, Number(error.status) || 500, { error: error.message || "サーバーエラーが発生しました。", ...(error.code ? { code: error.code } : {}) });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Persona Churn Lab: http://localhost:${port}`);
  console.log(`BYOK mode · ${model}${demoAllowed ? " · demo fallback enabled" : ""}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

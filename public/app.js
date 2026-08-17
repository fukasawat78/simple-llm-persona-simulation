const REQUIRED_COLUMNS = [
  "詳細プロフィール",
  "一文まとめ",
  "背景",
  "目標（Jobs）",
  "課題/不安（Pain）",
  "意思決定基準",
  "ブランド/サービス嗜好",
  "行動スニペット",
  "代表的なクオート",
  "思考・認知の特徴（インサイト）",
  "ストーリー補足",
];

const STEPS = ["setup", "prompt", "run", "review", "summary"];
const PAGE_TITLES = {
  setup: "シミュレーションを設計",
  prompt: "プロンプトを確認",
  run: "シミュレーションを実行",
  review: "判定をレビュー",
  summary: "結果サマリー",
};

const state = {
  authenticated: false,
  username: "",
  step: "setup",
  maxStep: 0,
  fileName: "",
  fileSize: 0,
  columns: [],
  personas: [],
  prompt: "",
  results: [],
  reviewResults: [],
  running: false,
  cancelled: false,
  stopReason: "",
  api: { apiKeyMode: "byok", demoAllowed: false, model: "" },
};

let sessionApiKey = "";
const safetyIdentifier = `persona-sim-${crypto.randomUUID()}`;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[character]));
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  row.push(field.replace(/\r$/, ""));
  if (row.some((value) => value !== "")) rows.push(row);
  if (!rows.length) return { headers: [], records: [] };

  const headers = rows[0].map((header, index) => index === 0 ? header.replace(/^\uFEFF/, "") : header);
  const records = rows.slice(1).map((values, rowIndex) => {
    const record = {};
    headers.forEach((header, index) => { record[header] = values[index] ?? ""; });
    record.__row = rowIndex + 2;
    return record;
  });
  return { headers, records };
}

function formatBytes(bytes) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.round(bytes / 1000)} KB`;
}

function selectedFields(record) {
  return Object.fromEntries(REQUIRED_COLUMNS.map((column) => [column, record[column] || ""]));
}

function makePersonas(records) {
  return records.map((record, index) => ({
    id: record.dbid_1 || record.id || `persona-${index + 1}`,
    row: record.__row,
    fields: selectedFields(record),
  }));
}

function settings() {
  return {
    purpose: $("#purpose").value,
    months: Number($("#months").value || 6),
    notes: $("#notes").value.trim(),
    domain: $("#domain").value.trim(),
  };
}

function buildPrompt(options) {
  const notes = options.notes || "特記事項なし。ペルソナに明記されていない事実を推測で補わないこと。";
  const domain = options.domain || "MNP等による現在のモバイル通信契約の終了を「解約」とする。料金プラン変更や端末変更だけの場合は継続とする。";
  return `# 役割
あなたはモバイル通信契約者の行動を判定するシミュレーションエージェントです。
1人のペルソナとして一貫して思考し、他の契約者や集計結果の影響を受けずに独立判定してください。

# 分析目的
与えられたペルソナが、現在から${options.months}か月後までに現在のモバイル通信契約を解約するかを判定する。

# ドメイン知識
${domain}

# 作業者からの注意点
${notes}

# 判定手順
1. ペルソナの現在の契約への満足、ブランドロイヤルティ、家族・固定回線・決済等との結びつきを確認する。
2. 料金感度、課題、乗り換え意向、変更の手間への許容度、代替サービスへの関心を確認する。
3. 継続要因と解約要因を分け、ペルソナに明記された根拠だけで比較する。
4. ${options.months}か月という期間内に実際の解約行動へ移る蓋然性を判断する。単なる不満や関心だけで解約とは判定しない。
5. 根拠が拮抗する場合は、現状維持バイアスを考慮して「継続」とする。

# 禁止事項
- ペルソナにないキャンペーン、競合条件、ライフイベントを作り出さない。
- 年齢・性別など単一属性だけで判断しない。
- 他のペルソナとの相対評価や、期待する解約率への帳尻合わせをしない。
- 理由では一般論ではなく、このペルソナ固有の根拠を示す。

# 出力仕様
次のJSON形式のみで返す。
{
  "churned": boolean,
  "confidence": 0から1の数値,
  "reason": "日本語で簡潔な判定理由（2〜3文）",
  "keyFactors": ["根拠1", "根拠2", "根拠3"]
}

# 判定対象ペルソナ
{{PERSONA_JSON}}`;
}

function showToast(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast show${error ? " error" : ""}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = "toast"; }, 3600);
}

function navigate(step) {
  const targetIndex = STEPS.indexOf(step);
  if (targetIndex > state.maxStep) return;
  state.step = step;
  $$(".step-view").forEach((view) => view.classList.toggle("active", view.id === `step-${step}`));
  $$(".nav-step").forEach((button, index) => {
    button.classList.toggle("active", button.dataset.navStep === step);
    button.classList.toggle("done", index < targetIndex);
  });
  $("#page-title").textContent = PAGE_TITLES[step];
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function unlock(step) {
  state.maxStep = Math.max(state.maxStep, STEPS.indexOf(step));
}

async function loadTextAsDataset(text, name, size) {
  try {
    $("#load-sample").disabled = true;
    $("#load-sample").textContent = "CSVを解析中...";
    await new Promise((resolve) => setTimeout(resolve, 30));
    const { headers, records } = parseCSV(text);
    const missing = REQUIRED_COLUMNS.filter((column) => !headers.includes(column));
    if (missing.length) throw new Error(`不足カラム: ${missing.join("、")}`);
    if (!records.length) throw new Error("データ行がありません。");

    state.fileName = name;
    state.fileSize = size;
    state.columns = headers;
    state.personas = makePersonas(records);
    state.results = [];
    state.reviewResults = [];
    state.maxStep = 0;

    $("#file-name").textContent = name;
    $("#file-meta").textContent = `${records.length.toLocaleString()}人 · ${headers.length}カラム · ${formatBytes(size)}`;
    $("#dataset-chip").textContent = `${records.length.toLocaleString()} personas`;
    $("#dropzone").classList.add("hidden");
    $("#file-loaded").classList.remove("hidden");
    $("#data-valid").classList.remove("hidden");
    $("#column-status").textContent = `✓ 指定された${REQUIRED_COLUMNS.length}カラムを確認しました`;
    $("#column-status").style.color = "#4f812d";
    $("#create-prompt-btn").disabled = false;
    $("#setup-hint").textContent = `${records.length.toLocaleString()}人を判定する準備ができました`;
    showToast(`${name} を読み込みました`);
  } catch (error) {
    $("#column-status").textContent = error.message;
    $("#column-status").style.color = "var(--danger)";
    showToast(error.message, true);
  } finally {
    $("#load-sample").disabled = false;
    $("#load-sample").innerHTML = "sample_data/test_dummy.csv を使う <span>→</span>";
  }
}

async function loadSample() {
  try {
    const response = await fetch("/sample_data/test_dummy.csv");
    if (!response.ok) throw new Error("サンプルCSVを取得できませんでした。");
    const blob = await response.blob();
    await loadTextAsDataset(await blob.text(), "test_dummy.csv", blob.size);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".csv")) return showToast("CSVファイルを選択してください。", true);
  await loadTextAsDataset(await file.text(), file.name, file.size);
}

function createPrompt() {
  const options = settings();
  if (!state.personas.length) return;
  if (options.months < 1 || options.months > 36) return showToast("期間は1〜36か月で指定してください。", true);
  state.prompt = buildPrompt(options);
  $("#prompt-editor").value = state.prompt;
  $("#prompt-count").textContent = state.personas.length.toLocaleString();
  updatePromptChars();
  unlock("prompt");
  navigate("prompt");
}

function updatePromptChars() {
  state.prompt = $("#prompt-editor").value;
  $("#prompt-chars").textContent = `${state.prompt.length.toLocaleString()} characters`;
}

async function fetchJson(url, options = {}) {
  const { useApiKey = false, apiKey = sessionApiKey, ...fetchOptions } = options;
  if (useApiKey && !apiKey) {
    const missingKeyError = new Error("このセッションで使用するOpenAI APIキーを設定してください。");
    missingKeyError.status = 401;
    throw missingKeyError;
  }
  const response = await fetch(url, {
    ...fetchOptions,
    headers: {
      "content-type": "application/json",
      ...(useApiKey ? { "x-openai-api-key": apiKey } : {}),
      ...(fetchOptions.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const requestError = new Error(payload.error || `Request failed (${response.status})`);
    requestError.status = response.status;
    requestError.code = payload.code;
    if (payload.code === "AUTH_REQUIRED") showLogin();
    throw requestError;
  }
  return payload;
}

function showLogin(message = "") {
  state.authenticated = false;
  state.username = "";
  sessionApiKey = "";
  $("#app-shell").classList.add("hidden");
  $("#login-screen").classList.remove("hidden");
  $("#login-error").textContent = message;
  $("#login-password").value = "";
}

function showApp(username) {
  state.authenticated = true;
  state.username = username;
  $("#login-screen").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");
  $("#login-user").textContent = username;
  $("#login-error").textContent = "";
}

async function checkAuth() {
  try {
    const result = await fetchJson("/api/auth/status", { method: "GET" });
    if (!result.authenticated) return showLogin();
    showApp(result.username);
    await checkAPI();
  } catch {
    showLogin("サーバーへ接続できませんでした。しばらくしてから再試行してください。");
  }
}

async function login(event) {
  event.preventDefault();
  const button = $("#login-btn");
  button.disabled = true;
  button.textContent = "確認中...";
  $("#login-error").textContent = "";
  try {
    const result = await fetchJson("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: $("#login-username").value, password: $("#login-password").value }),
    });
    showApp(result.username);
    $("#login-form").reset();
    await checkAPI();
  } catch (error) {
    showLogin(error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = "ログイン <span>→</span>";
  }
}

async function logout() {
  if (state.running) return showToast("実行中は先に停止してください。", true);
  try {
    await fetchJson("/api/auth/logout", { method: "POST", body: "{}" });
  } finally {
    showLogin("ログアウトしました。");
  }
}

function updateKeyUI(status = "empty", message = "APIキーは未設定です") {
  const statusElement = $("#key-session-status");
  statusElement.className = `key-session-status${status === "connected" ? " connected" : status === "error" ? " error" : ""}`;
  statusElement.innerHTML = '<span class="status-dot"></span>';
  statusElement.append(document.createTextNode(` ${message}`));
  $("#clear-key-btn").classList.toggle("hidden", status !== "connected");
  $("#run-mode").textContent = status === "connected" ? `OPENAI · ${state.api.model}` : state.api.demoAllowed ? "DEMO MODE" : "API KEY REQUIRED";
}

async function connectKey() {
  const input = $("#api-key-input");
  const candidate = input.value.trim();
  if (candidate.length < 20 || candidate.length > 512) return updateKeyUI("error", "APIキーの形式を確認してください");
  const button = $("#connect-key-btn");
  button.disabled = true;
  button.textContent = "確認中...";
  try {
    const result = await fetchJson("/api/key/validate", {
      method: "POST",
      body: "{}",
      useApiKey: true,
      apiKey: candidate,
    });
    sessionApiKey = candidate;
    input.value = "";
    updateKeyUI("connected", `${result.model}へ接続済み · 再読み込みで破棄`);
    $("#api-status").textContent = `OpenAI · ${result.model}`;
    showToast("APIキーをこのタブのメモリに設定しました");
  } catch (error) {
    sessionApiKey = "";
    updateKeyUI("error", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "接続を確認";
  }
}

function clearKey() {
  if (state.running) return showToast("実行中はAPIキーを破棄できません。", true);
  sessionApiKey = "";
  $("#api-key-input").value = "";
  updateKeyUI("empty", "APIキーをメモリから破棄しました");
  $("#api-status").textContent = "Server connected · key required";
}

function resetRunUI() {
  $("#run-completed").textContent = "0";
  $("#run-churn").textContent = "0";
  $("#run-stay").textContent = "0";
  $("#run-errors").textContent = "0";
  $("#run-percent").textContent = "0%";
  $("#progress-bar").style.width = "0%";
  $(".pulse-ring").style.setProperty("--progress", "0%");
  $("#run-log").innerHTML = "<span>Waiting for simulation...</span>";
  $("#go-review-btn").classList.add("hidden");
  $("#start-run-btn").classList.remove("hidden");
}

function appendLog(message, isError = false) {
  const log = $("#run-log");
  if (log.querySelector("span")) log.innerHTML = "";
  const line = document.createElement("div");
  line.textContent = message;
  if (isError) line.className = "error";
  log.append(line);
  while (log.children.length > 80) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

function updateRunProgress(done, total, result) {
  const rate = total ? Math.round((done / total) * 100) : 0;
  const churn = state.results.filter((item) => item.churned).length;
  const errors = state.results.filter((item) => item.error).length;
  $("#run-completed").textContent = done.toLocaleString();
  $("#run-churn").textContent = churn.toLocaleString();
  $("#run-stay").textContent = (done - churn - errors).toLocaleString();
  $("#run-errors").textContent = errors.toLocaleString();
  $("#run-percent").textContent = `${rate}%`;
  $("#progress-bar").style.width = `${rate}%`;
  $(".pulse-ring").style.setProperty("--progress", `${rate}%`);
  if (result) appendLog(`#${done} ${String(result.id).slice(0, 8)} · ${result.error ? "ERROR" : result.churned ? "解約" : "継続"}`, Boolean(result.error));
}

async function startRun() {
  if (state.running) return;
  if (!sessionApiKey && !state.api.demoAllowed) {
    showToast("セットアップ画面でOpenAI APIキーを設定してください。", true);
    navigate("setup");
    $("#api-key-input").focus();
    return;
  }
  state.prompt = $("#prompt-editor").value.trim();
  if (!state.prompt) return showToast("プロンプトが空です。", true);
  state.running = true;
  state.cancelled = false;
  state.stopReason = "";
  state.results = [];
  state.reviewResults = [];
  resetRunUI();
  $("#start-run-btn").classList.add("hidden");
  $("#cancel-run-btn").classList.remove("hidden");
  $("#run-status").textContent = "ペルソナを判定しています";
  $("#run-detail").textContent = `0 / ${state.personas.length.toLocaleString()} 完了`;
  $(".pulse-ring").classList.add("running");
  appendLog(`${sessionApiKey ? state.api.model : "demo evaluator"} で逐次判定を開始`);

  const options = settings();
  for (let index = 0; index < state.personas.length; index += 1) {
    if (state.cancelled) break;
    const persona = state.personas[index];
    let result;
    try {
      const decision = await fetchJson("/api/evaluate", {
        method: "POST",
        body: JSON.stringify({ prompt: state.prompt, persona, settings: options, safetyIdentifier }),
        useApiKey: Boolean(sessionApiKey),
      });
      result = { ...decision, id: persona.id, row: persona.row, persona };
    } catch (error) {
      result = { id: persona.id, row: persona.row, persona, churned: false, confidence: 0, reason: error.message, keyFactors: [], error: true };
      if (error.status === 401 || error.status === 403) {
        state.cancelled = true;
        state.stopReason = "APIキーを確認できないため停止しました";
      }
    }
    state.results.push(result);
    updateRunProgress(index + 1, state.personas.length, result);
    $("#run-detail").textContent = `${(index + 1).toLocaleString()} / ${state.personas.length.toLocaleString()} 完了`;
  }

  state.running = false;
  $(".pulse-ring").classList.remove("running");
  $("#cancel-run-btn").classList.add("hidden");
  if (state.cancelled) {
    $("#run-status").textContent = state.stopReason || "シミュレーションを停止しました";
    $("#start-run-btn").classList.remove("hidden");
    $("#start-run-btn").textContent = "最初から再実行 ▶";
    appendLog("作業者がシミュレーションを停止しました");
    return;
  }
  $("#run-status").textContent = "全件の判定が完了しました";
  $("#run-detail").textContent = `${state.results.length.toLocaleString()}人の判定結果と理由を格納しました。`;
  $("#go-review-btn").classList.remove("hidden");
  unlock("review");
  appendLog("全件完了。Review Curatorへ引き渡しました");
  showToast("全ペルソナの判定が完了しました");
}

function sampleResults() {
  const pool = state.results.filter((result) => !result.error).slice();
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [pool[index], pool[target]] = [pool[target], pool[index]];
  }
  state.reviewResults = pool.slice(0, Math.min(10, pool.length));
  renderReview();
}

function profileDetails(result) {
  const raw = result.persona.fields["詳細プロフィール"] || "";
  let profile = {};
  try { profile = JSON.parse(raw); } catch { /* free-text profiles are also accepted */ }
  const age = profile["年齢"] ? `${profile["年齢"]}歳` : "年齢非公開";
  const gender = profile["性別"] || "";
  const area = profile["居住エリア"] || "";
  const initials = `${profile["性別"] === "女性" ? "W" : profile["性別"] === "男性" ? "M" : "P"}${profile["年齢"] || ""}`;
  return { label: [age, gender, area].filter(Boolean).join(" · "), initials };
}

function renderReview(filter = "all") {
  const items = state.reviewResults.filter((result) => filter === "all" || (filter === "churn" ? result.churned : !result.churned));
  $("#all-count").textContent = state.reviewResults.length;
  $("#review-list").innerHTML = items.map((result) => {
    const detail = profileDetails(result);
    const summary = result.persona.fields["一文まとめ"] || result.persona.fields["代表的なクオート"] || "ペルソナ要約なし";
    return `<article class="card review-item">
      <div class="avatar">${escapeHtml(detail.initials)}</div>
      <div class="review-persona">
        <h3>${escapeHtml(detail.label)}</h3>
        <p class="summary-line">${escapeHtml(summary)}</p>
        <div class="reason-box">${escapeHtml(result.reason)}</div>
        <div class="factor-tags">${(result.keyFactors || []).map((factor) => `<span>${escapeHtml(factor)}</span>`).join("")}</div>
      </div>
      <div class="decision"><span class="decision-badge ${result.churned ? "churn" : "stay"}">${result.churned ? "解約" : "継続"}</span><small>確信度 ${Math.round((result.confidence || 0) * 100)}%</small></div>
    </article>`;
  }).join("") || '<article class="card review-item"><div class="review-persona"><h3>該当する判定はありません</h3></div></article>';
}

async function applyFeedback(source) {
  const input = source === "review" ? $("#review-feedback") : $("#summary-feedback");
  const feedback = input.value.trim();
  if (!feedback) return showToast("修正したい内容を入力してください。", true);
  const button = source === "review" ? $("#refine-review-btn") : $("#refine-summary-btn");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Prompt Architectが改良中...";
  try {
    const payload = await fetchJson("/api/refine", {
      method: "POST",
      body: JSON.stringify({ currentPrompt: state.prompt, feedback, context: source, safetyIdentifier }),
      useApiKey: Boolean(sessionApiKey),
    });
    state.prompt = payload.prompt;
    $("#prompt-editor").value = state.prompt;
    updatePromptChars();
    state.results = [];
    state.reviewResults = [];
    state.maxStep = STEPS.indexOf("run");
    resetRunUI();
    input.value = "";
    navigate("prompt");
    showToast("フィードバックをプロンプトへ反映しました。内容を確認して再実行してください。",
    );
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function factorSummary() {
  const counts = new Map();
  state.results.filter((result) => result.churned && !result.error).forEach((result) => {
    (result.keyFactors || []).forEach((factor) => counts.set(factor, (counts.get(factor) || 0) + 1));
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
}

function renderSummary() {
  const valid = state.results.filter((result) => !result.error);
  const churn = valid.filter((result) => result.churned).length;
  const stay = valid.length - churn;
  const rate = valid.length ? (churn / valid.length) * 100 : 0;
  $("#churn-rate").textContent = `${rate.toFixed(1)}%`;
  $("#summary-churn-count").textContent = `${churn.toLocaleString()}人`;
  $("#summary-total").textContent = `${valid.length.toLocaleString()}人`;
  $("#donut").style.setProperty("--rate", `${rate}%`);
  $("#donut-label").textContent = `${Math.round(rate)}%`;
  $("#legend-churn").textContent = churn.toLocaleString();
  $("#legend-stay").textContent = stay.toLocaleString();

  const factors = factorSummary();
  const max = factors[0]?.[1] || 1;
  $("#factor-list").innerHTML = factors.length ? factors.map(([factor, count]) => `<div class="factor-row"><span title="${escapeHtml(factor)}">${escapeHtml(factor.length > 26 ? `${factor.slice(0, 26)}…` : factor)}</span><div class="factor-bar"><i style="width:${Math.round((count / max) * 100)}%"></i></div><b>${count}</b></div>`).join("") : "<p class=\"lead\">解約ドライバーはありません。</p>";
  unlock("summary");
  navigate("summary");
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportResults() {
  const columns = ["id", ...REQUIRED_COLUMNS, "判定結果", "確信度", "判定理由", "主要因"];
  const lines = [columns.map(csvEscape).join(",")];
  state.results.forEach((result) => {
    const row = [result.id, ...REQUIRED_COLUMNS.map((column) => result.persona.fields[column]), result.churned ? "解約" : "継続", result.confidence, result.reason, (result.keyFactors || []).join(" | ")];
    lines.push(row.map(csvEscape).join(","));
  });
  const blob = new Blob(["\uFEFF", lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `churn_simulation_${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function resetApp() {
  if (state.running) return showToast("実行中は先に停止してください。", true);
  state.step = "setup";
  state.maxStep = 0;
  state.fileName = "";
  state.personas = [];
  state.results = [];
  state.reviewResults = [];
  state.prompt = "";
  $("#file-loaded").classList.add("hidden");
  $("#dropzone").classList.remove("hidden");
  $("#data-valid").classList.add("hidden");
  $("#column-status").textContent = "";
  $("#dataset-chip").textContent = "データ未読込";
  $("#create-prompt-btn").disabled = true;
  $("#setup-hint").textContent = "CSVを読み込むと次へ進めます";
  $("#file-input").value = "";
  resetRunUI();
  navigate("setup");
}

async function checkAPI() {
  try {
    state.api = await fetchJson("/api/health", { method: "GET" });
    $("#api-dot").classList.add("active");
    $("#api-status").textContent = state.api.demoAllowed ? "Server connected · demo available" : "Server connected · key required";
    updateKeyUI("empty", state.api.demoAllowed ? "APIキー未設定 · デモ判定を利用できます" : "APIキーは未設定です");
  } catch {
    $("#api-status").textContent = "Server disconnected";
  }
}

function bindEvents() {
  $("#login-form").addEventListener("submit", login);
  $("#logout-btn").addEventListener("click", logout);
  $("#connect-key-btn").addEventListener("click", connectKey);
  $("#api-key-input").addEventListener("keydown", (event) => { if (event.key === "Enter") connectKey(); });
  $("#toggle-key-btn").addEventListener("click", () => {
    const input = $("#api-key-input");
    input.type = input.type === "password" ? "text" : "password";
    $("#toggle-key-btn").setAttribute("aria-label", input.type === "password" ? "APIキーを表示" : "APIキーを隠す");
  });
  $("#clear-key-btn").addEventListener("click", clearKey);
  $("#load-sample").addEventListener("click", loadSample);
  $("#file-input").addEventListener("change", (event) => loadFile(event.target.files[0]));
  $("#change-file").addEventListener("click", () => $("#file-input").click());
  const dropzone = $("#dropzone");
  ["dragenter", "dragover"].forEach((name) => dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach((name) => dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.remove("dragging"); }));
  dropzone.addEventListener("drop", (event) => loadFile(event.dataTransfer.files[0]));
  $("#create-prompt-btn").addEventListener("click", createPrompt);
  $("#prompt-editor").addEventListener("input", updatePromptChars);
  $("#copy-prompt").addEventListener("click", async () => { await navigator.clipboard.writeText($("#prompt-editor").value); showToast("プロンプトをコピーしました"); });
  $("#go-run-btn").addEventListener("click", () => { updatePromptChars(); unlock("run"); navigate("run"); });
  $("#start-run-btn").addEventListener("click", startRun);
  $("#cancel-run-btn").addEventListener("click", () => { state.cancelled = true; });
  $("#go-review-btn").addEventListener("click", () => { sampleResults(); navigate("review"); });
  $("#reshuffle-btn").addEventListener("click", sampleResults);
  $$(".review-tabs button").forEach((button) => button.addEventListener("click", () => {
    $$(".review-tabs button").forEach((item) => item.classList.toggle("active", item === button));
    renderReview(button.dataset.filter);
  }));
  $("#refine-review-btn").addEventListener("click", () => applyFeedback("review"));
  $("#approve-review-btn").addEventListener("click", renderSummary);
  $("#refine-summary-btn").addEventListener("click", () => applyFeedback("summary"));
  $("#export-btn").addEventListener("click", exportResults);
  $("#back-review-btn").addEventListener("click", () => navigate("review"));
  $("#finish-btn").addEventListener("click", () => showToast("シミュレーションを完了しました。結果はCSVで保存できます。"));
  $("#reset-btn").addEventListener("click", resetApp);
  $$("[data-back]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.back)));
  $$(".nav-step").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.navStep)));
}

bindEvents();
checkAuth();

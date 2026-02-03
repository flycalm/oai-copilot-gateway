/**
 * rsp4copilot on Cloudflare Workers
 *
 * Inbound protocols:
 * - OpenAI Chat Completions: `POST /v1/chat/completions`
 * - OpenAI Responses:        `POST /v1/responses` (aliases: `/responses`, `/openai/v1/responses`)
 * - Claude Messages:         `POST /claude/v1/messages`, `POST /claude/v1/messages/count_tokens`
 * - Gemini:                  `POST /gemini/v1beta/models/{model}:generateContent`,
 *                            `POST /gemini/v1beta/models/{model}:streamGenerateContent?alt=sse`
 *
 * Routing:
 * - Config-driven (`modelName` or `providerId.modelName`) via `RSP4COPILOT_CONFIG` (required)
 */

import type { Env } from "./common";
import {
  bearerToken,
  getWorkerAuthKeys,
  isClientIpAllowed,
  isDebugEnabled,
  joinUrls,
  parseBoolEnv,
  parseCsvEnv,
  jsonError,
  jsonResponse,
  logDebug,
  maskSecret,
  normalizeAuthValue,
  parseUpstreamCustomHeaders,
  previewString,
  sseHeaders,
} from "./common";
import { claudeMessagesRequestToOpenaiChat, handleClaudeCountTokens, openaiChatResponseToClaudeMessage, openaiStreamToClaudeMessagesSse } from "./claude_api";
import { parseGatewayConfig } from "./config";
import { dispatchOpenAIChatToProvider } from "./dispatch";
import { resolveModel } from "./model_resolver";
import { geminiModelsList, ollamaModelsList, openaiModelsListFromEntries, type ModelListEntry } from "./models_list";
import { refreshDiscoveredModelsForConfig } from "./models_discovery";
import { handleGeminiGenerateContentUpstream } from "./providers/gemini";
import { handleOpenAIRequest, handleOpenAIResponsesUpstream } from "./providers/openai";
import { geminiRequestToOpenAIChat, openAIChatResponseToGemini } from "./protocols/gemini";
import { openAIChatResponseToResponses, responsesRequestToOpenAIChat } from "./protocols/responses";
import { openAIChatSseToGeminiSse, openAIChatSseToResponsesSse } from "./protocols/stream";
import { listUpstreamCandidates, shouldTryNextUpstreamCandidateStatus } from "./upstreams";

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") || "";
  const allowOrigin = origin && typeof origin === "string" ? origin : "*";

  const reqHeaders = request.headers.get("access-control-request-headers") || "";
  const allowHeaders =
    typeof reqHeaders === "string" && reqHeaders.trim()
      ? reqHeaders
      : "authorization,content-type,x-session-id,x-api-key,x-goog-api-key,anthropic-api-key,x-anthropic-api-key,anthropic-version,anthropic-beta";

  const vary = typeof reqHeaders === "string" && reqHeaders.trim() ? "Origin, Access-Control-Request-Headers" : "Origin";
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": allowHeaders,
    "access-control-max-age": "86400",
    vary,
  };
}

function mergeVary(existing: string, incoming: string): string {
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (value: string) => {
    for (const part of String(value || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)) {
      const key = part.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(part);
    }
  };

  add(existing);
  add(incoming);
  return out.join(", ");
}

function redactUrlSearchForLog(url: URL): string {
  const params = url?.searchParams;
  if (!params) return "";

  const isSensitiveKey = (keyLower: string) =>
    keyLower === "authorization" ||
    keyLower.includes("api_key") ||
    keyLower.endsWith("api-key") ||
    keyLower.endsWith("_key") ||
    keyLower.endsWith("key") ||
    keyLower.includes("token") ||
    keyLower.includes("password") ||
    keyLower.includes("passwd") ||
    keyLower.includes("secret");

  const out = new URLSearchParams();
  let count = 0;
  for (const [k, v] of params.entries()) {
    if (count++ >= 40) {
      out.append("__truncated__", "1");
      break;
    }
    const keyLower = String(k || "").toLowerCase();
    const safeVal = isSensitiveKey(keyLower) ? maskSecret(v) : previewString(v, 200);
    out.append(k, safeVal);
  }

  const s = out.toString();
  return s ? `?${s}` : "";
}

function withCors(resp: Response, corsHeaders: Record<string, string>): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsHeaders || {})) {
    if (v == null) continue;
    if (k.toLowerCase() === "vary") {
      const existing = headers.get("vary") || "";
      headers.set("vary", existing ? mergeVary(existing, String(v)) : String(v));
      continue;
    }
    headers.set(k, String(v));
  }
  return new Response(resp.body, { status: resp.status || 200, headers });
}

async function readJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; value: null }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, value: null };
  }
}

function copilotToolUseInstructionsText(): string {
  return [
    "Tool use:",
    "- When tools are provided, use them to perform actions (file edits, patches, searches).",
    "- Do not say you will write/edit files and stop; call the relevant tool with valid JSON arguments.",
    "- Do not claim you changed files unless you actually called a tool and received a result.",
  ].join("\n");
}

function shouldInjectCopilotToolUseInstructions(request: Request, reqJson: any): boolean {
  const ua = request.headers.get("user-agent") || "";
  if (typeof ua !== "string") return false;
  if (!ua.toLowerCase().includes("oai-compatible-copilot/")) return false;
  const tools = Array.isArray(reqJson?.tools) ? reqJson.tools : [];
  return tools.length > 0;
}

function decodeBase64ToString(value: string): string | null {
  const v = String(value || "").trim();
  if (!v) return null;
  try {
    if (typeof (globalThis as any).atob === "function") return (globalThis as any).atob(v);
  } catch {}
  try {
    const BufferCtor = (globalThis as any).Buffer;
    if (typeof BufferCtor?.from === "function") return BufferCtor.from(v, "base64").toString("utf8");
  } catch {}
  return null;
}

function parseBasicAuth(headerValue: string | null): { user: string; pass: string } | null {
  const h = typeof headerValue === "string" ? headerValue.trim() : "";
  if (!h.toLowerCase().startsWith("basic ")) return null;
  const decoded = decodeBase64ToString(h.slice(6).trim());
  if (!decoded) return null;
  const idx = decoded.indexOf(":");
  if (idx < 0) return null;
  return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

function getWebUiBasicCreds(env: Env): { user: string; pass: string } | null {
  const user = normalizeAuthValue(env?.WEB_UI_BASIC_USER);
  const pass = normalizeAuthValue(env?.WEB_UI_BASIC_PASS);
  if (!user || !pass) return null;
  return { user, pass };
}

function normalizeClientIp(raw: unknown): string {
  let ip = String(raw ?? "").trim();
  if (!ip) return "";
  // XFF can be a list.
  if (ip.includes(",")) ip = ip.split(",")[0].trim();

  // Strip brackets for IPv6 like "[::1]:1234"
  if (ip.startsWith("[") && ip.includes("]")) {
    ip = ip.slice(1, ip.indexOf("]")).trim();
  }

  // Strip IPv4 port like "1.2.3.4:5678"
  if (ip.includes(".") && ip.includes(":") && !ip.includes("::")) {
    const lastColon = ip.lastIndexOf(":");
    if (lastColon > 0) ip = ip.slice(0, lastColon).trim();
  }

  // IPv4-mapped IPv6
  if (ip.toLowerCase().startsWith("::ffff:")) ip = ip.slice(7).trim();

  return ip;
}

function getClientIp(request: Request, env: Env): string {
  const h = request.headers;
  const cfIp = normalizeClientIp(h.get("cf-connecting-ip") || "");
  if (cfIp) return cfIp;

  const trustProxy = parseBoolEnv(env?.WORKER_TRUST_PROXY_HEADERS);
  if (trustProxy) {
    const proxyIp = normalizeClientIp(h.get("true-client-ip") || h.get("x-real-ip") || h.get("x-forwarded-for") || "");
    if (proxyIp) return proxyIp;
  }

  const directIp = normalizeClientIp(h.get("x-rsp4copilot-client-ip") || "");
  if (directIp) return directIp;

  return normalizeClientIp(h.get("true-client-ip") || h.get("x-real-ip") || h.get("x-forwarded-for") || "");
}

function webUiHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
	<head>
	  <meta charset="utf-8" />
	  <meta name="viewport" content="width=device-width, initial-scale=1" />
	  <link rel="icon" href="data:," />
	  <title>rsp4copilot - API 网关管理界面</title>
	  <style>
    :root {
      color-scheme: light dark;
      --bg: #0a0e1a;
      --bg-secondary: #111827;
      --card: #1a1f2e;
      --card-hover: #1f2535;
      --text: #f1f5f9;
      --text-secondary: #94a3b8;
      --muted: #64748b;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --accent-light: #60a5fa;
      --border: #2d3748;
      --border-light: #374151;
      --success: #10b981;
      --warning: #f59e0b;
      --error: #ef4444;
      --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -1px rgba(0, 0, 0, 0.2);
      --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.4), 0 4px 6px -2px rgba(0, 0, 0, 0.3);
    }
    @media (prefers-color-scheme: light){
      :root{
        --bg: #f8fafc;
        --bg-secondary: #ffffff;
        --card: #ffffff;
        --card-hover: #f8fafc;
        --text: #0f172a;
        --text-secondary: #475569;
        --muted: #64748b;
        --accent: #3b82f6;
        --accent-hover: #2563eb;
        --accent-light: #60a5fa;
        --border: #e2e8f0;
        --border-light: #cbd5e1;
        --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.08);
        --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.12), 0 4px 6px -2px rgba(0, 0, 0, 0.1);
      }
    }
    *{ box-sizing:border-box; }
    body{
      margin:0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background:linear-gradient(135deg, var(--bg) 0%, var(--bg-secondary) 100%);
      color:var(--text);
      line-height:1.6;
      min-height:100vh;
    }

    /* Header */
    .header{
      background:var(--card);
      border-bottom:1px solid var(--border);
      padding:16px 24px;
      box-shadow:var(--shadow);
      position:sticky;
      top:0;
      z-index:100;
      backdrop-filter:blur(10px);
    }
    .header-content{
      max-width:1400px;
      margin:0 auto;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:20px;
    }
    .logo{
      font-size:20px;
      font-weight:700;
      color:var(--accent-light);
      display:flex;
      align-items:center;
      gap:10px;
    }
    .logo-icon{
      width:32px;
      height:32px;
      background:linear-gradient(135deg, var(--accent) 0%, var(--accent-light) 100%);
      border-radius:8px;
      display:flex;
      align-items:center;
      justify-content:center;
      font-size:16px;
    }

    /* Navigation Tabs */
    .nav-tabs{
      display:flex;
      gap:4px;
      padding:0 8px;
      overflow-x:auto;
      -webkit-overflow-scrolling:touch;
    }
    .nav-tab{
      padding:8px 16px;
      border:none;
      background:transparent;
      color:var(--text-secondary);
      cursor:pointer;
      border-radius:8px;
      font-size:14px;
      font-weight:500;
      white-space:nowrap;
      transition:all 0.2s;
      position:relative;
    }
    .nav-tab:hover{
      color:var(--text);
      background:var(--bg);
    }
    .nav-tab.active{
      color:var(--accent-light);
      background:color-mix(in oklab, var(--accent) 15%, transparent);
    }
    .nav-tab.active::after{
      content:'';
      position:absolute;
      bottom:-8px;
      left:50%;
      transform:translateX(-50%);
      width:24px;
      height:3px;
      background:var(--accent);
      border-radius:2px;
    }

    /* Main Container */
    .wrap{
      max-width:1400px;
      margin:0 auto;
      padding:24px;
    }

    /* Tab Content */
    .tab-content{ display:none; }
    .tab-content.active{ display:block; }
    .tab-content.fade-in{
      animation:fadeIn 0.3s ease-in-out;
    }
    @keyframes fadeIn{
      from{ opacity:0; transform:translateY(10px); }
      to{ opacity:1; transform:translateY(0); }
    }

    /* Cards */
    .card{
      background:var(--card);
      border:1px solid var(--border);
      border-radius:12px;
      padding:20px;
      margin-bottom:20px;
      box-shadow:var(--shadow);
      transition:all 0.2s;
    }
    .card:hover{
      border-color:var(--border-light);
      box-shadow:var(--shadow-lg);
    }
    h1, h2, h3{ margin:0 0 12px; }
    h1{ font-size:22px; font-weight:700; }
    h2{ font-size:16px; font-weight:600; color:var(--text); }
    h3{ font-size:14px; font-weight:600; color:var(--text-secondary); }

    /* Grid Layout */
    .row{
      display:flex;
      gap:16px;
      flex-wrap:wrap;
      align-items:stretch;
    }
    .grid{
      display:grid;
      grid-template-columns:repeat(auto-fit, minmax(280px, 1fr));
      gap:16px;
    }
    .col{ flex:1; min-width:280px; }

    /* Typography */
    .muted{
      color:var(--muted);
      font-size:13px;
      line-height:1.6;
    }
    code{
      background:var(--bg);
      padding:2px 6px;
      border-radius:4px;
      font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size:12px;
      color:var(--accent-light);
    }

    /* Forms */
    label{
      display:block;
      font-size:13px;
      color:var(--text-secondary);
      margin-bottom:8px;
      font-weight:500;
    }
    input, textarea, select{
      width:100%;
      border:1px solid var(--border);
      border-radius:8px;
      padding:10px 12px;
      background:var(--bg);
      color:var(--text);
      font-size:14px;
      transition:all 0.2s;
      outline:none;
    }
    input:focus, textarea:focus, select:focus{
      border-color:var(--accent);
      box-shadow:0 0 0 3px color-mix(in oklab, var(--accent) 15%, transparent);
    }
    textarea{
      min-height:120px;
      font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size:13px;
      resize:vertical;
    }

    /* Buttons */
    button{
      border:1px solid var(--border);
      background:var(--bg);
      color:var(--text);
      padding:10px 16px;
      border-radius:8px;
      cursor:pointer;
      font-size:14px;
      font-weight:500;
      transition:all 0.2s;
      white-space:nowrap;
    }
    button:hover{
      background:var(--card);
      border-color:var(--border-light);
      transform:translateY(-1px);
    }
    button:active{
      transform:translateY(0);
    }
    button.primary{
      background:linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%);
      border-color:transparent;
      color:#fff;
    }
    button.primary:hover{
      box-shadow:0 4px 12px color-mix(in oklab, var(--accent) 40%, transparent);
    }
    button.danger{
      background:color-mix(in oklab, var(--error) 15%, transparent);
      border-color:var(--error);
      color:var(--error);
    }
    button.danger:hover{
      background:var(--error);
      color:#fff;
    }

    /* Pre/Code blocks */
    pre{
      margin:0;
      white-space:pre-wrap;
      word-break:break-word;
      font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size:12px;
      background:var(--bg);
      padding:12px;
      border-radius:8px;
      border:1px solid var(--border);
      max-height:400px;
      overflow:auto;
    }

    /* Status badges */
    .badge{
      display:inline-block;
      padding:4px 10px;
      border-radius:6px;
      font-size:12px;
      font-weight:600;
    }
    .badge-success{ background:color-mix(in oklab, var(--success) 20%, transparent); color:var(--success); }
    .badge-warning{ background:color-mix(in oklab, var(--warning) 20%, transparent); color:var(--warning); }
    .badge-error{ background:color-mix(in oklab, var(--error) 20%, transparent); color:var(--error); }

    /* Utility */
    .gap-sm{ gap:8px; }
    .gap-md{ gap:12px; }
    .gap-lg{ gap:16px; }
    .mt-sm{ margin-top:8px; }
    .mt-md{ margin-top:12px; }
    .mt-lg{ margin-top:20px; }
    .hidden{ display:none !important; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-content">
      <div class="logo">
        <div class="logo-icon">🚀</div>
        <span>rsp4copilot</span>
      </div>
	      <nav class="nav-tabs" id="navTabs">
	        <button class="nav-tab active" data-tab="dashboard">概览</button>
	        <button class="nav-tab" data-tab="config">配置管理</button>
	        <button class="nav-tab" data-tab="test">API 测试</button>
	        <button class="nav-tab" data-tab="dist">分发测试</button>
	        <button class="nav-tab" data-tab="secrets">密钥管理</button>
	        <button class="nav-tab" data-tab="custom">自定义请求</button>
	      </nav>
    </div>
  </div>

  <div class="wrap">

    <!-- Dashboard Tab -->
    <div id="tab-dashboard" class="tab-content active fade-in">
      <div class="row">
        <div class="col card">
          <h1>🎯 API 网关概览</h1>
          <p class="muted">这是 rsp4copilot 的管理界面，用于自检和调试网关服务。</p>
          <div class="mt-lg grid">
            <div class="muted">
              <strong>使用提示：</strong><br>
              • 页面默认通过服务端代理调用网关（无需手动输入入口 Key）<br>
              • 如代理不可用，会自动切换到手动模式
            </div>
            <div id="manualKeyWrap" class="hidden">
              <label>入口 API Key（手动模式）</label>
              <input id="key" placeholder="粘贴你的 WORKER_AUTH_KEY（仅本地保存）" />
              <p class="muted mt-sm">会保存在浏览器 localStorage（同源）</p>
            </div>
          </div>
          <div class="mt-lg">
            <button class="primary" id="btnHealth">📊 健康检查</button>
            <button class="primary" id="btnModels" style="margin-left:8px">📋 模型列表</button>
          </div>
        </div>
        <div class="col card">
          <h2>📡 响应结果</h2>
          <pre id="out" class="muted">点击左侧按钮开始</pre>
        </div>
      </div>
    </div>

    <!-- Config Tab -->
    <div id="tab-config" class="tab-content fade-in">
      <div class="card">
        <h1>⚙️ 服务端配置文件（Docker）</h1>
        <p class="muted">
          读取/保存 <code>RSP4COPILOT_CONFIG_FILE</code>。<br>
          保存需要：1) <code>WEB_UI_CONFIG_WRITE=true</code>；2) Docker 挂载 <code>/config</code> 可写。
        </p>
        <div class="mt-md">
          <button class="primary" id="btnCfgLoad">📂 加载配置</button>
          <button class="primary" id="btnCfgSave" style="margin-left:8px">💾 保存配置</button>
          <button id="btnCfgCheck" style="margin-left:8px">✅ 一键检测</button>
          <button id="btnCfgVisualRender" style="margin-left:8px">🔄 刷新可视化</button>
          <button id="btnCfgAddProvider" style="margin-left:8px">➕ 添加 Provider</button>
          <button id="btnCfgApplyToText" style="margin-left:8px">✨ 应用到文本</button>
        </div>
        <div class="mt-lg">
          <div id="providersForm"></div>
        </div>
        <div class="mt-lg">
          <label>配置内容（JSONC）</label>
          <textarea id="cfg" spellcheck="false" placeholder="点击“加载配置”后会出现在这里"></textarea>
          <p class="muted mt-sm" id="cfgStatus"></p>
        </div>
      </div>
    </div>

	    <!-- Test Tab -->
	    <div id="tab-test" class="tab-content fade-in">
	      <div class="card">
	        <h1>🧪 快速测试</h1>
	        <p class="muted">基于当前配置生成请求，自动选择 provider + model</p>
        <div class="mt-lg grid">
          <div>
            <label>协议</label>
            <input id="testProto" value="openai-chat" />
            <p class="muted mt-sm">可选：openai-chat / openai-responses / claude / gemini</p>
          </div>
          <div>
            <label>Provider</label>
            <input id="testProvider" placeholder="例如 openai" />
          </div>
          <div>
            <label>Model</label>
            <input id="testModel" placeholder="例如 gpt-5.2" />
          </div>
        </div>
        <div class="mt-lg">
          <label>Prompt</label>
          <textarea id="testPrompt" spellcheck="false" placeholder="hello">hello</textarea>
        </div>
        <div class="mt-md">
          <button class="primary" id="btnTestSend">🚀 发送测试请求</button>
          <button id="btnTestFill" style="margin-left:8px">📝 填充到"自定义请求"</button>
        </div>
        <p class="muted mt-sm" id="testStatus"></p>
	      </div>
	    </div>

	    <!-- Distributed Test Tab -->
	    <div id="tab-dist" class="tab-content fade-in">
	      <div class="card">
	        <h1>🛰️ 分发 API 测试</h1>
	        <p class="muted">
	          以“用户调用”的方式测试你分发出去的 API（会直接带上你填写的 Key，不走服务端代理）。<br>
	          如果目标不是当前站点域名，浏览器可能因为 CORS 拦截而失败（这种情况建议用 curl 测）。
	        </p>
	        <div class="mt-lg grid">
	          <div>
	            <label>Base URL</label>
	            <input id="distBase" placeholder="例如 https://api.example.com" />
	            <p class="muted mt-sm">默认使用当前站点：<code>location.origin</code></p>
	          </div>
	          <div>
	            <label>API Key（Bearer）</label>
	            <input id="distKey" type="password" placeholder="粘贴你分发给用户的 Key" />
	            <p class="muted mt-sm">仅保存在浏览器 localStorage</p>
	          </div>
	        </div>
	        <div class="mt-lg grid">
	          <div>
	            <label>路径</label>
	            <input id="distPath" value="/v1/chat/completions" />
	          </div>
	          <div>
	            <label>方法</label>
	            <input id="distMethod" value="POST" />
	          </div>
	          <div style="display:flex; align-items:flex-end">
	            <button class="primary" id="btnDistSend" style="width:100%">🚀 发送</button>
	          </div>
	        </div>
	        <div class="mt-lg">
	          <label>Body（JSON）</label>
	          <textarea id="distBody" spellcheck="false">{ "model": "gpt-5.2", "messages": [ { "role": "user", "content": "hello" } ] }</textarea>
	        </div>
	        <div class="mt-md">
	          <button id="btnDistFillChat">📝 填充 Chat 示例</button>
	          <button id="btnDistFillResponses" style="margin-left:8px">📝 填充 Responses 示例</button>
	        </div>
	        <div class="mt-lg">
	          <h2>📡 返回结果</h2>
	          <pre id="distOut" class="muted">点击“发送”后会显示在这里</pre>
	        </div>
	        <p class="muted mt-sm" id="distStatus"></p>
	      </div>
	    </div>

	    <!-- Secrets Tab -->
	    <div id="tab-secrets" class="tab-content fade-in">
	      <div class="card">
	        <h1>🔑 密钥查看（危险操作）</h1>
        <p class="muted">
          需要服务端开启：<code>WEB_UI_SECRETS_VIEW=true</code>。<br>
          默认返回脱敏值；若要明文需额外开启 <code>WEB_UI_SECRETS_REVEAL=true</code>。
        </p>
        <div class="mt-md" style="display:flex; align-items:center; gap:12px; flex-wrap:wrap">
          <button class="primary" id="btnSecrets">🔍 加载密钥</button>
          <label style="display:flex; gap:8px; align-items:center; margin:0; cursor:pointer">
            <input type="checkbox" id="secretsReveal" />
            <span class="muted">请求明文（reveal=1）</span>
          </label>
        </div>
        <div class="mt-lg">
          <label>返回内容（JSON）</label>
          <textarea id="secrets" spellcheck="false" placeholder="点击“加载密钥”后会出现在这里"></textarea>
          <p class="muted mt-sm" id="secretsStatus"></p>
        </div>
      </div>

      <div class="card">
        <h1>🔧 上游 Key 修改（危险操作）</h1>
        <p class="muted">
          仅支持修改配置里 <code>apiKeyEnv</code> 引用到的上游环境变量。<br>
          需要服务端开启：<code>WEB_UI_SECRETS_VIEW=true</code> + <code>WEB_UI_SECRETS_WRITE=true</code>。<br>
          这些值会写入 <code>RSP4COPILOT_ENV_FILE</code>（默认 <code>/config/rsp4copilot.env</code>）。
        </p>
        <div class="mt-md" style="display:flex; align-items:center; gap:12px; flex-wrap:wrap">
          <button class="primary" id="btnUpKeysLoad">📋 加载可编辑列表</button>
          <button class="primary" id="btnUpKeysSave" style="margin-left:8px">💾 保存上游 Key</button>
          <label style="display:flex; gap:8px; align-items:center; margin:0; cursor:pointer">
            <input type="checkbox" id="upKeysReveal" />
            <span class="muted">显示当前值（reveal=1）</span>
          </label>
        </div>
        <div class="mt-lg">
          <div id="upKeysForm"></div>
        </div>
        <p class="muted mt-sm" id="upKeysStatus"></p>
      </div>
    </div>

    <!-- Custom Request Tab -->
    <div id="tab-custom" class="tab-content fade-in">
      <div class="card">
        <h1>🎨 自定义请求（JSON）</h1>
        <p class="muted">完全自定义 path/method/body 来调试 API</p>
        <div class="mt-lg grid">
          <div>
            <label>路径</label>
            <input id="path" value="/v1/chat/completions" />
          </div>
          <div>
            <label>方法</label>
            <input id="method" value="POST" />
          </div>
          <div style="display:flex; align-items:flex-end">
            <button class="primary" id="btnSend" style="width:100%">🚀 发送</button>
          </div>
        </div>
        <div class="mt-lg">
          <label>Body（JSON）</label>
          <textarea id="body">{ "model": "gpt-5.2", "messages": [ { "role": "user", "content": "hello" } ] }</textarea>
          <p class="muted mt-sm">
            ⚠️ 注意：SSE 流式响应在此页面不会做事件解析，会直接显示原始文本。
          </p>
        </div>
      </div>
    </div>

  </div>
  <script>
    // Tab Navigation
    const navTabs = document.getElementById('navTabs');
    const tabs = navTabs?.querySelectorAll('.nav-tab') || [];
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const targetTab = tab.getAttribute('data-tab');
        if (!targetTab) return;

        // Update active nav tab
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        // Show target content, hide others
        document.querySelectorAll('.tab-content').forEach(content => {
          content.classList.remove('active', 'fade-in');
        });
        const targetContent = document.getElementById('tab-' + targetTab);
        if (targetContent) {
          targetContent.classList.add('active', 'fade-in');
        }
      });
    });

    const manualKeyWrapEl = document.getElementById('manualKeyWrap');
    const keyEl = document.getElementById('key');
    const outEl = document.getElementById('out');
	    const pathEl = document.getElementById('path');
	    const methodEl = document.getElementById('method');
	    const bodyEl = document.getElementById('body');
	    const cfgEl = document.getElementById('cfg');
	    const cfgStatusEl = document.getElementById('cfgStatus');
	    const providersFormEl = document.getElementById('providersForm');
	    const testProtoEl = document.getElementById('testProto');
	    const testProviderEl = document.getElementById('testProvider');
	    const testModelEl = document.getElementById('testModel');
	    const testPromptEl = document.getElementById('testPrompt');
	    const testStatusEl = document.getElementById('testStatus');
	    const distBaseEl = document.getElementById('distBase');
	    const distKeyEl = document.getElementById('distKey');
	    const distPathEl = document.getElementById('distPath');
	    const distMethodEl = document.getElementById('distMethod');
	    const distBodyEl = document.getElementById('distBody');
	    const distOutEl = document.getElementById('distOut');
	    const distStatusEl = document.getElementById('distStatus');
		    const secretsEl = document.getElementById('secrets');
		    const secretsStatusEl = document.getElementById('secretsStatus');
		    const secretsRevealEl = document.getElementById('secretsReveal');
		    const upKeysFormEl = document.getElementById('upKeysForm');
	    const upKeysRevealEl = document.getElementById('upKeysReveal');
	    const upKeysStatusEl = document.getElementById('upKeysStatus');

    function setOut(text, isErr){
      outEl.className = isErr ? '' : '';
      outEl.textContent = text;
    }
    let useProxy = true;

    function loadKey(){
      try { keyEl.value = localStorage.getItem('rsp4copilot.key') || ''; } catch {}
    }
    function saveKey(){
      try { localStorage.setItem('rsp4copilot.key', keyEl.value || ''); } catch {}
    }

    function setDistStatus(text){
      if (!distStatusEl) return;
      distStatusEl.textContent = text || '';
    }

    function setDistOut(text, isErr){
      if (!distOutEl) return;
      distOutEl.className = isErr ? '' : 'muted';
      distOutEl.textContent = text || '';
    }

    function loadDistPrefs(){
      try {
        if (distBaseEl && !distBaseEl.value) distBaseEl.value = localStorage.getItem('rsp4copilot.distBase') || '';
        if (distKeyEl && !distKeyEl.value) distKeyEl.value = localStorage.getItem('rsp4copilot.distKey') || '';
      } catch {}
      try {
        if (distBaseEl && !distBaseEl.value) distBaseEl.value = location.origin;
      } catch {}
    }

    function saveDistPrefs(){
      try {
        if (distBaseEl) localStorage.setItem('rsp4copilot.distBase', distBaseEl.value || '');
        if (distKeyEl) localStorage.setItem('rsp4copilot.distKey', distKeyEl.value || '');
      } catch {}
    }

    distBaseEl?.addEventListener('input', saveDistPrefs);
    distKeyEl?.addEventListener('input', saveDistPrefs);
    loadDistPrefs();

    async function callDirect(path, opt){
      saveKey();
      const headers = Object.assign({ 'content-type': 'application/json' }, (opt && opt.headers) || {});
      const key = (keyEl.value || '').trim();
      if (key) headers['authorization'] = 'Bearer ' + key;
      const resp = await fetch(path, Object.assign({}, opt || {}, { headers }));
      const text = await resp.text();
      return { status: resp.status, headers: Object.fromEntries(resp.headers.entries()), text };
    }

    async function callProxy(path, opt){
      const target = '/ui/api/proxy?path=' + encodeURIComponent(path || '/');
      const headers = Object.assign({}, (opt && opt.headers) || {});
      const resp = await fetch(target, Object.assign({}, opt || {}, { headers }));
      const text = await resp.text();
      return { status: resp.status, headers: Object.fromEntries(resp.headers.entries()), text };
    }

    async function callGateway(path, opt){
      if (useProxy) return callProxy(path, opt);
      return callDirect(path, opt);
    }

    async function callDistributed(baseUrl, path, opt, apiKey){
      const base = String(baseUrl || '').trim() || (typeof location !== 'undefined' ? location.origin : '');
      const relPath = String(path || '').trim() || '/';
      // Join path relative to base (preserve base path prefix if provided).
      // If relPath starts with "/", URL() would drop base pathname, so strip it.
      const baseFixed = base.endsWith('/') ? base : (base + '/');
      const relFixed = relPath.startsWith('/') ? relPath.slice(1) : relPath;
      const url = new URL(relFixed, baseFixed);
      const headers = Object.assign({}, (opt && opt.headers) || {});
      if (apiKey) headers['authorization'] = 'Bearer ' + String(apiKey).trim();
      const resp = await fetch(url.toString(), Object.assign({}, opt || {}, { headers }));
      const text = await resp.text();
      return { url: url.toString(), method: (opt && opt.method) || 'GET', status: resp.status, headers: Object.fromEntries(resp.headers.entries()), text };
    }

    async function callAdmin(path, opt){
      // Do NOT set Authorization header here; Basic Auth is handled by the browser.
      const headers = Object.assign({ 'content-type': 'application/json' }, (opt && opt.headers) || {});
      const resp = await fetch(path, Object.assign({}, opt || {}, { headers }));
      const text = await resp.text();
      return { status: resp.status, headers: Object.fromEntries(resp.headers.entries()), text };
    }
    function pretty(r){
      let body = r.text;
      try { body = JSON.stringify(JSON.parse(r.text), null, 2); } catch {}
      const prefix = (r && r.url) ? (String(r.method || 'GET').toUpperCase() + ' ' + String(r.url) + '\\n') : '';
      return prefix + 'HTTP ' + r.status + '\\n' + JSON.stringify(r.headers, null, 2) + '\\n\\n' + body;
    }

    document.getElementById('btnHealth').addEventListener('click', async () => {
      try { const r = await callGateway('/v1/health', { method: 'GET' }); setOut(pretty(r)); } catch (e) { setOut(String(e && e.message ? e.message : e), true); }
    });
    document.getElementById('btnModels').addEventListener('click', async () => {
      try { const r = await callGateway('/v1/models', { method: 'GET' }); setOut(pretty(r)); } catch (e) { setOut(String(e && e.message ? e.message : e), true); }
    });
	    document.getElementById('btnSend').addEventListener('click', async () => {
	      try{
	        const path = (pathEl.value || '/').trim() || '/';
	        const method = (methodEl.value || 'POST').trim().toUpperCase() || 'POST';
	        const raw = (bodyEl.value || '').trim();
	        const body = raw ? raw : '{}';
	        const r = await callGateway(path, { method, body: method === 'GET' || method === 'HEAD' ? undefined : body, headers: { 'content-type': 'application/json' } });
	        setOut(pretty(r));
	      } catch (e) {
	        setOut(String(e && e.message ? e.message : e), true);
	      }
	    });

	    function buildTestRequest(proto, providerId, modelName, promptText){
	      const p = String(proto || '').trim().toLowerCase();
	      const provider = String(providerId || '').trim();
	      const model = String(modelName || '').trim();
	      const prompt = String(promptText || '').trim() || 'hello';
	      if (!provider || !model) return { ok: false, error: '请填写 provider 和 model' };

	      const fullModel = provider + '.' + model;
	      if (p === 'openai-chat') {
	        return { ok: true, path: '/v1/chat/completions', method: 'POST', body: JSON.stringify({ model: fullModel, messages: [{ role: 'user', content: prompt }], stream: false }) };
	      }
	      if (p === 'openai-responses') {
	        return { ok: true, path: '/v1/responses', method: 'POST', body: JSON.stringify({ model: fullModel, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }], stream: false }) };
	      }
	      if (p === 'claude') {
	        return { ok: true, path: '/claude/v1/messages', method: 'POST', body: JSON.stringify({ model: fullModel, max_tokens: 256, messages: [{ role: 'user', content: prompt }] }) };
	      }
	      if (p === 'gemini') {
	        const path = '/gemini/v1beta/models/' + encodeURIComponent(model) + ':generateContent?provider=' + encodeURIComponent(provider);
	        return { ok: true, path, method: 'POST', body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }) };
	      }
	      return { ok: false, error: '未知协议：' + proto };
	    }

	    document.getElementById('btnTestFill').addEventListener('click', async () => {
	      try{
	        const req = buildTestRequest(testProtoEl.value, testProviderEl.value, testModelEl.value, testPromptEl.value);
	        if (!req.ok) { setTestStatus(req.error); return; }
	        pathEl.value = req.path;
	        methodEl.value = req.method;
	        bodyEl.value = req.body;
	        setTestStatus('已填充到“自定义请求”。');
	      } catch (e) {
	        setTestStatus('填充异常：' + String(e && e.message ? e.message : e));
	      }
	    });

		    document.getElementById('btnTestSend').addEventListener('click', async () => {
		      try{
		        setTestStatus('发送中...');
		        const req = buildTestRequest(testProtoEl.value, testProviderEl.value, testModelEl.value, testPromptEl.value);
		        if (!req.ok) { setTestStatus(req.error); return; }
		        const r = await callGateway(req.path, { method: req.method, body: req.body, headers: { 'content-type': 'application/json' } });
		        setOut(pretty(r), r.status >= 400);
		        setTestStatus('已发送：HTTP ' + r.status);
		      } catch (e) {
		        setTestStatus('发送异常：' + String(e && e.message ? e.message : e));
		      }
		    });

		    document.getElementById('btnDistFillChat')?.addEventListener('click', async () => {
		      try{
		        if (distPathEl) distPathEl.value = '/v1/chat/completions';
		        if (distMethodEl) distMethodEl.value = 'POST';
		        if (distBodyEl) distBodyEl.value = '{ \"model\": \"gpt-5.2\", \"messages\": [ { \"role\": \"user\", \"content\": \"hello\" } ] }';
		        setDistStatus('已填充 Chat 示例。');
		      } catch (e) {
		        setDistStatus('填充异常：' + String(e && e.message ? e.message : e));
		      }
		    });

		    document.getElementById('btnDistFillResponses')?.addEventListener('click', async () => {
		      try{
		        if (distPathEl) distPathEl.value = '/v1/responses';
		        if (distMethodEl) distMethodEl.value = 'POST';
		        if (distBodyEl) distBodyEl.value = '{ \"model\": \"gpt-5.2\", \"input\": \"hello\" }';
		        setDistStatus('已填充 Responses 示例。');
		      } catch (e) {
		        setDistStatus('填充异常：' + String(e && e.message ? e.message : e));
		      }
		    });

		    document.getElementById('btnDistSend')?.addEventListener('click', async () => {
		      try{
		        setDistStatus('发送中...');
		        setDistOut('', false);
		        const base = safeStr(distBaseEl && distBaseEl.value ? distBaseEl.value : '').trim() || (typeof location !== 'undefined' ? location.origin : '');
		        const key = safeStr(distKeyEl && distKeyEl.value ? distKeyEl.value : '').trim();
		        const path = safeStr(distPathEl && distPathEl.value ? distPathEl.value : '').trim() || '/';
		        const method = safeStr(distMethodEl && distMethodEl.value ? distMethodEl.value : 'POST').trim().toUpperCase() || 'POST';
		        const raw = safeStr(distBodyEl && distBodyEl.value ? distBodyEl.value : '').trim();

		        // Validate JSON early for common case.
		        if (raw) {
		          try { JSON.parse(raw); } catch (e) { setDistStatus('Body 不是合法 JSON：' + String(e && e.message ? e.message : e)); return; }
		        }

		        const headers = raw ? { 'content-type': 'application/json' } : {};
		        const body = (method === 'GET' || method === 'HEAD') ? undefined : (raw ? raw : undefined);

		        let r = null;
		        try {
		          r = await callDistributed(base, path, { method, body, headers }, key);
		        } catch (e) {
		          setDistStatus('发送失败：' + String(e && e.message ? e.message : e));
		          setDistOut(String(e && e.message ? e.message : e), true);
		          return;
		        }
		        const ct = String((r && r.headers && (r.headers['content-type'] || r.headers['Content-Type'])) || '').toLowerCase();
		        const looksHtml = ct.includes('text/html') || String(r.text || '').trim().toLowerCase().startsWith('<!doctype html') || String(r.text || '').includes('<html');
		        if (looksHtml) {
		          setDistStatus('已发送：HTTP ' + r.status + '（看起来返回的是网页 HTML：Base URL/路径可能指向了管理后台或前端静态页，而不是 API 入口）');
		        } else {
		          setDistStatus('已发送：HTTP ' + r.status);
		        }
		        setDistOut(pretty(r), r.status >= 400);
		        setOut(pretty(r), r.status >= 400);
		      } catch (e) {
		        setDistStatus('发送异常：' + String(e && e.message ? e.message : e));
		        setDistOut(String(e && e.message ? e.message : e), true);
		      }
		    });

	    if (keyEl) {
	      keyEl.addEventListener('input', saveKey);
	      loadKey();
	    }

    // Detect whether the Node/Docker UI proxy is available.
    (async () => {
      try {
        const r = await fetch('/ui/api/health', { method: 'GET' });
        if (r.status === 200) {
          useProxy = true;
          if (manualKeyWrapEl) manualKeyWrapEl.style.display = 'none';
          return;
        }
      } catch {}
      useProxy = false;
      if (manualKeyWrapEl) manualKeyWrapEl.style.display = 'block';
      setOut('提示：未检测到服务端代理（/ui/api/*）。请在“手动模式”输入入口 API Key（WORKER_AUTH_KEY）后再试。');
    })();

	    function setCfgStatus(text){
	      cfgStatusEl.textContent = text || '';
	    }

	    let cfgObj = null;

	    function setTestStatus(text){
	      testStatusEl.textContent = text || '';
	    }

		    function ensureCfgObj(){
		      if (!cfgObj || typeof cfgObj !== 'object') cfgObj = { version: 1, providers: {} };
		      if (!cfgObj.providers || typeof cfgObj.providers !== 'object') cfgObj.providers = {};
		      if (!cfgObj.version) cfgObj.version = 1;
		      return cfgObj;
		    }

		    function safeStr(v){ return String(v == null ? '' : v); }

		    const apiKeyEnvChoiceState = { loaded: false, loading: false, list: [], presentByName: {} };

		    function uniqSortedStrings(list){
		      const out = [];
		      const seen = new Set();
		      for (const raw of Array.isArray(list) ? list : []) {
		        const s = safeStr(raw).trim();
		        if (!s) continue;
		        if (seen.has(s)) continue;
		        seen.add(s);
		        out.push(s);
		      }
		      out.sort((a, b) => a.localeCompare(b));
		      return out;
		    }

		    function mergeStringLists(a, b){
		      return uniqSortedStrings([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]);
		    }

		    function collectApiKeyEnvChoicesFromConfig(root){
		      const out = [];
		      if (!root || typeof root !== 'object') return [];
		      const providers = (root.providers && typeof root.providers === 'object') ? root.providers : {};
		      for (const pid of Object.keys(providers)) {
		        const p = (providers[pid] && typeof providers[pid] === 'object') ? providers[pid] : {};
		        if (p.apiKeyEnv) out.push(p.apiKeyEnv);
		        const ups = Array.isArray(p.upstreams) ? p.upstreams : [];
		        for (const u of ups) {
		          if (u && typeof u === 'object' && u.apiKeyEnv) out.push(u.apiKeyEnv);
		        }
		      }
		      return uniqSortedStrings(out);
		    }

		    async function loadApiKeyEnvChoicesFromServer(){
		      if (apiKeyEnvChoiceState.loading) return;
		      apiKeyEnvChoiceState.loading = true;
		      try{
		        const r = await callAdmin('/admin/api/upstream_keys', { method: 'GET' });
		        if (r.status !== 200) return;
		        let json = null;
		        try { json = JSON.parse(r.text || '{}'); } catch { json = null; }
		        if (!json || typeof json !== 'object') return;

		        const names = [];
		        const presentByName = {};
		        const providers = Array.isArray(json.providers) ? json.providers : [];
		        for (const p of providers) {
		          const items = Array.isArray(p && p.items) ? p.items : [];
		          for (const it of items) {
		            const envVar = safeStr(it && it.envVar ? it.envVar : '').trim();
		            if (!envVar) continue;
		            names.push(envVar);
		            if (presentByName[envVar] == null) presentByName[envVar] = Boolean(it.present);
		            else presentByName[envVar] = Boolean(presentByName[envVar]) || Boolean(it.present);
		          }
		        }

		        apiKeyEnvChoiceState.list = uniqSortedStrings(names);
		        apiKeyEnvChoiceState.presentByName = presentByName;
		        apiKeyEnvChoiceState.loaded = true;
		      } catch {}
		      finally {
		        apiKeyEnvChoiceState.loading = false;
		      }
		    }

		    function createApiKeyEnvPicker({ value, choices, placeholder, onChange }){
		      const wrap = document.createElement('div');
		      wrap.style.display = 'grid';
		      wrap.style.gap = '8px';

		      const select = document.createElement('select');
		      select.style.width = '100%';

		      const optEmpty = document.createElement('option');
		      optEmpty.value = '';
		      optEmpty.textContent = '（不设置 / 清空）';
		      select.appendChild(optEmpty);

		      const normalizedChoices = uniqSortedStrings(choices || []);
		      for (const c of normalizedChoices) {
		        const opt = document.createElement('option');
		        opt.value = c;
		        opt.textContent = c;
		        select.appendChild(opt);
		      }

		      const optCustom = document.createElement('option');
		      optCustom.value = '__custom__';
		      optCustom.textContent = '自定义...';
		      select.appendChild(optCustom);

		      const input = document.createElement('input');
		      input.placeholder = safeStr(placeholder || 'apiKeyEnv');
		      input.value = safeStr(value || '');

		      const v0 = safeStr(value || '').trim();
		      const inChoices = Boolean(v0 && normalizedChoices.includes(v0));
		      select.value = inChoices ? v0 : (v0 ? '__custom__' : '');
		      input.style.display = select.value === '__custom__' ? 'block' : 'none';

		      function emit(v){
		        try { onChange && onChange(safeStr(v).trim()); } catch {}
		      }

		      select.addEventListener('change', () => {
		        const v = select.value;
		        if (v === '__custom__') {
		          input.style.display = 'block';
		          input.focus();
		          emit(input.value);
		          return;
		        }
		        input.style.display = 'none';
		        input.value = v || '';
		        emit(v);
		      });
		      input.addEventListener('input', () => {
		        if (select.value !== '__custom__') return;
		        emit(input.value);
		      });

		      wrap.appendChild(select);
		      wrap.appendChild(input);
		      return wrap;
		    }

		    function createApiModePicker({ value, onChange }){
		      const wrap = document.createElement('div');
		      wrap.style.display = 'grid';
		      wrap.style.gap = '8px';

		      const select = document.createElement('select');
		      select.style.width = '100%';

		      const known = [
		        { value: 'openai-responses', label: 'openai-responses（OpenAI Responses）' },
		        { value: 'openai-chat-completions', label: 'openai-chat-completions（OpenAI Chat Completions）' },
		        { value: 'claude', label: 'claude（Anthropic）' },
		        { value: 'gemini', label: 'gemini（Google）' },
		      ];

		      const optEmpty = document.createElement('option');
		      optEmpty.value = '';
		      optEmpty.textContent = '（请选择）';
		      select.appendChild(optEmpty);

		      for (const it of known) {
		        const opt = document.createElement('option');
		        opt.value = it.value;
		        opt.textContent = it.label;
		        select.appendChild(opt);
		      }

		      const optCustom = document.createElement('option');
		      optCustom.value = '__custom__';
		      optCustom.textContent = '自定义...';
		      select.appendChild(optCustom);

		      const input = document.createElement('input');
		      input.placeholder = 'openai-responses / openai-chat-completions / gemini / claude';
		      input.value = safeStr(value || '');

		      const v0 = safeStr(value || '').trim();
		      const knownValues = known.map((x) => x.value);
		      const inKnown = Boolean(v0 && knownValues.includes(v0));
		      select.value = inKnown ? v0 : (v0 ? '__custom__' : '');
		      input.style.display = select.value === '__custom__' ? 'block' : 'none';

		      function emit(v){
		        try { onChange && onChange(safeStr(v).trim()); } catch {}
		      }

		      select.addEventListener('change', () => {
		        const v = select.value;
		        if (v === '__custom__') {
		          input.style.display = 'block';
		          input.focus();
		          emit(input.value);
		          return;
		        }
		        input.style.display = 'none';
		        input.value = v || '';
		        emit(v);
		      });
		      input.addEventListener('input', () => {
		        if (select.value !== '__custom__') return;
		        emit(input.value);
		      });

		      wrap.appendChild(select);
		      wrap.appendChild(input);
		      return wrap;
		    }

			    function promptTextModal({ title, label, placeholder, initialValue, okText, cancelText, inputType, revealToggle }){
			      return new Promise((resolve) => {
			        const overlay = document.createElement('div');
			        overlay.style.position = 'fixed';
			        overlay.style.inset = '0';
			        overlay.style.background = 'rgba(0,0,0,.55)';
		        overlay.style.display = 'flex';
		        overlay.style.alignItems = 'center';
		        overlay.style.justifyContent = 'center';
		        overlay.style.padding = '16px';
		        overlay.style.zIndex = '9999';

		        const card = document.createElement('div');
		        card.className = 'card';
		        card.style.maxWidth = '520px';
		        card.style.width = '100%';
		        card.style.margin = '0';

		        const h = document.createElement('div');
		        h.style.fontWeight = '800';
		        h.style.fontSize = '16px';
		        h.style.marginBottom = '12px';
		        h.textContent = safeStr(title || '请输入');

		        const lab = document.createElement('label');
		        lab.textContent = safeStr(label || '');

			        const inputWrap = document.createElement('div');
			        inputWrap.style.display = 'flex';
			        inputWrap.style.gap = '10px';
			        inputWrap.style.alignItems = 'center';

			        const input = document.createElement('input');
			        input.placeholder = safeStr(placeholder || '');
			        input.value = safeStr(initialValue || '');
			        input.type = safeStr(inputType || 'text') || 'text';
			        input.autocomplete = 'off';
			        inputWrap.appendChild(input);

			        if (revealToggle && input.type === 'password') {
			          const toggle = document.createElement('button');
			          toggle.textContent = '显示';
			          toggle.addEventListener('click', (e) => {
			            e.preventDefault();
			            const next = input.type === 'password' ? 'text' : 'password';
			            input.type = next;
			            toggle.textContent = next === 'password' ? '显示' : '隐藏';
			            try { input.focus(); } catch {}
			          });
			          inputWrap.appendChild(toggle);
			        }

			        const actions = document.createElement('div');
			        actions.style.display = 'flex';
			        actions.style.gap = '10px';
		        actions.style.justifyContent = 'flex-end';
		        actions.style.marginTop = '14px';

		        const cancel = document.createElement('button');
		        cancel.textContent = safeStr(cancelText || '取消');

		        const ok = document.createElement('button');
		        ok.className = 'primary';
		        ok.textContent = safeStr(okText || '确定');

		        function close(val){
		          try { overlay.remove(); } catch {}
		          resolve(val);
		        }

		        cancel.addEventListener('click', (e) => { e.preventDefault(); close(null); });
		        ok.addEventListener('click', (e) => { e.preventDefault(); close((input.value || '').trim()); });
		        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
		        const onKeyDown = (e) => {
		          if (e.key === 'Escape') close(null);
		          if (e.key === 'Enter') close((input.value || '').trim());
		        };
		        window.addEventListener('keydown', onKeyDown);

		        const close0 = close;
		        close = (val) => {
		          try { window.removeEventListener('keydown', onKeyDown); } catch {}
		          close0(val);
		        };

		        actions.appendChild(cancel);
		        actions.appendChild(ok);

		        card.appendChild(h);
			        if (label) card.appendChild(lab);
			        card.appendChild(inputWrap);
			        card.appendChild(actions);

			        overlay.appendChild(card);
			        document.body.appendChild(overlay);
			        setTimeout(() => { try { input.focus(); input.select(); } catch {} }, 0);
			      });
			    }

			    function createApiKeyEnvEditor({ getValue, setValue, choices, placeholder }){
			      const wrap = document.createElement('div');
			      wrap.style.display = 'grid';
			      wrap.style.gap = '8px';

			      const status = document.createElement('div');
			      status.className = 'muted';

			      const msg = document.createElement('div');
			      msg.className = 'muted';
			      msg.style.whiteSpace = 'pre-wrap';
			      msg.style.wordBreak = 'break-word';

			      function setMsg(kind, text){
			        try { msg.innerHTML = ''; } catch {}
			        const t = safeStr(text || '').trim();
			        if (!t) return;
			        const compact = !t.includes('\\n') && t.length <= 80;
			        if (compact) {
			          const b = document.createElement('span');
			          b.className = 'badge ' + (kind === 'success' ? 'badge-success' : (kind === 'error' ? 'badge-error' : 'badge-warning'));
			          b.textContent = t;
			          msg.appendChild(b);
			          return;
			        }
			        const pre = document.createElement('div');
			        pre.textContent = t;
			        msg.appendChild(pre);
			      }

			      const actions = document.createElement('div');
			      actions.style.display = 'flex';
			      actions.style.gap = '10px';
			      actions.style.alignItems = 'center';

			      const btn = document.createElement('button');
			      btn.textContent = '写入 key';

			      function refresh(){
			        const name = safeStr(getValue ? getValue() : '').trim();
			        if (!name) {
			          status.textContent = 'key：未设置（请选择 apiKeyEnv）';
			          btn.disabled = true;
			          btn.title = '请先选择 apiKeyEnv';
			          return;
			        }
			        btn.disabled = false;
			        btn.title = '';
			        const known = apiKeyEnvChoiceState && apiKeyEnvChoiceState.presentByName && Object.prototype.hasOwnProperty.call(apiKeyEnvChoiceState.presentByName, name);
			        if (!known) {
			          status.textContent = 'key：未知（可在“密钥管理”加载，或开启 WEB_UI_SECRETS_VIEW）';
			          return;
			        }
			        status.textContent = 'key：' + (apiKeyEnvChoiceState.presentByName[name] ? '已设置' : '未设置');
			      }

			      btn.addEventListener('click', async (e) => {
			        e.preventDefault();
			        setMsg('', '');
			        const name = safeStr(getValue ? getValue() : '').trim();
			        if (!name) { setMsg('warning', '请先选择 apiKeyEnv'); return; }
			        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
			          setMsg('error', 'apiKeyEnv 必须是合法的环境变量名（只能包含字母/数字/下划线，且不能以数字开头）。');
			          return;
			        }
			        if (apiKeyEnvChoiceState.loaded && Array.isArray(apiKeyEnvChoiceState.list) && apiKeyEnvChoiceState.list.length) {
			          const allowed = apiKeyEnvChoiceState.list.includes(name);
				          if (!allowed) {
				            setMsg(
				              'error',
				              '该 apiKeyEnv 不在服务端允许写入的列表中。\\n\\n' +
				                '服务端只允许写入“当前配置里引用到的 apiKeyEnv”。\\n' +
				                '请先在配置里把 provider/upstream 的 apiKeyEnv 设置为这个名字并保存配置，然后重新加载配置或在“密钥管理→加载可编辑列表”。'
				            );
				            return;
				          }
				        }
			        const v0 = await promptTextModal({
			          title: '写入 key',
			          label: '将写入环境变量：' + name + '（会写入服务器 /config/rsp4copilot.env）',
			          placeholder: '粘贴新 key（不会显示明文）',
			          initialValue: '',
			          okText: '写入',
			          cancelText: '取消',
			          inputType: 'password',
			          revealToggle: true,
			        });
			        const v = safeStr(v0).trim();
			        if (!v) return;

			        const originalText = btn.textContent;
			        btn.disabled = true;
			        btn.textContent = '写入中...';
			        try{
			          const controller = new AbortController();
			          const t = setTimeout(() => { try { controller.abort(); } catch {} }, 30000);
			          const r = await callAdmin('/admin/api/upstream_keys', { method: 'PUT', body: JSON.stringify({ updates: { [name]: v } }), signal: controller.signal });
			          try { clearTimeout(t); } catch {}
			          if (r.status !== 200) {
			            let msg = '写入失败：HTTP ' + r.status;
			            try {
			              const j = JSON.parse(r.text || '{}');
			              const em = j && j.error && j.error.message ? String(j.error.message) : '';
			              if (em) msg += '\\n' + em;
			            } catch {}
			            if (r.status === 400) {
			              msg += '\\n\\n提示：请确认该 apiKeyEnv 已在当前配置中被引用（并已保存配置），且 key 非空。';
			            }
			            setMsg('error', msg);
			            return;
			          }
			          await loadApiKeyEnvChoicesFromServer();
			          refresh();
			          setMsg('success', '写入成功：' + name);
			        } catch (err) {
			          const m = String(err && err.message ? err.message : err);
			          const isAbort = Boolean(err && (err.name === 'AbortError' || String(err).includes('AbortError')));
			          setMsg('error', isAbort ? '写入异常：请求超时（30s）' : ('写入异常：' + m));
			        } finally {
			          try { btn.textContent = originalText; } catch {}
			          refresh();
			        }
			      });

		      const picker = createApiKeyEnvPicker({
		        value: safeStr(getValue ? getValue() : ''),
		        choices,
		        placeholder,
		        onChange: (v) => { try { setValue && setValue(v); } catch {} refresh(); },
		      });

			      actions.appendChild(btn);
			      wrap.appendChild(picker);
			      wrap.appendChild(status);
			      wrap.appendChild(msg);
			      wrap.appendChild(actions);

		      refresh();
		      return wrap;
		    }

		    function normalizeBaseUrlInputToList(raw){
		      if (Array.isArray(raw)) return raw.map((v) => safeStr(v).trim()).filter(Boolean);
		      const s = safeStr(raw).trim();
		      return s ? [s] : [];
	    }

	    function getFirstBaseUrl(obj){
	      if (!obj || typeof obj !== 'object') return '';
	      const s1 = typeof obj.baseURL === 'string' ? obj.baseURL.trim() : '';
	      if (s1) return s1;
	      const list = Array.isArray(obj.baseURLs) ? obj.baseURLs : [];
	      if (list.length) return safeStr(list[0]).trim();
	      return '';
	    }

	    function setSingleBaseUrl(obj, raw){
	      if (!obj || typeof obj !== 'object') return;
	      const s = safeStr(raw).trim();
	      obj.baseURL = s;
	      obj.baseURLs = s ? [s] : [];
	    }

	    function normalizeCfgObjForUi(root){
	      if (!root || typeof root !== 'object') return root;
	      if (!root.providers || typeof root.providers !== 'object') root.providers = {};
	      const providers = root.providers;
	      for (const pid of Object.keys(providers)) {
	        const p = (providers[pid] && typeof providers[pid] === 'object') ? providers[pid] : {};

	        if (!Array.isArray(p.baseURLs)) p.baseURLs = normalizeBaseUrlInputToList(p.baseURL ?? p.baseUrl ?? p.url);
	        if (typeof p.baseURL !== 'string') p.baseURL = getFirstBaseUrl(p);

	        if (Array.isArray(p.upstreams)) {
	          for (let i = 0; i < p.upstreams.length; i++) {
	            const u = (p.upstreams[i] && typeof p.upstreams[i] === 'object') ? p.upstreams[i] : {};
	            if (!Array.isArray(u.baseURLs)) u.baseURLs = normalizeBaseUrlInputToList(u.baseURL ?? u.baseUrl ?? u.url);
	            if (typeof u.baseURL !== 'string') u.baseURL = getFirstBaseUrl(u);
	            p.upstreams[i] = u;
	          }
	        }

	        providers[pid] = p;
	      }
	      return root;
	    }

	    function cfgToWritableObject(){
	      const root = ensureCfgObj();
	      const out = JSON.parse(JSON.stringify(root || {}));
	      if (!out || typeof out !== 'object') return { version: 1, providers: {} };
	      if (!out.providers || typeof out.providers !== 'object') out.providers = {};

	      for (const pid of Object.keys(out.providers)) {
	        const p = (out.providers[pid] && typeof out.providers[pid] === 'object') ? out.providers[pid] : {};

	        const pBaseList = Array.isArray(p.baseURLs) ? p.baseURLs : normalizeBaseUrlInputToList(p.baseURL ?? p.baseUrl ?? p.url);
	        if (pBaseList.length) p.baseURL = (pBaseList.length === 1 ? pBaseList[0] : pBaseList);
	        delete p.baseURLs;

	        if (Array.isArray(p.upstreams)) {
	          for (const u of p.upstreams) {
	            if (!u || typeof u !== 'object') continue;
	            const uBaseList = Array.isArray(u.baseURLs) ? u.baseURLs : normalizeBaseUrlInputToList(u.baseURL ?? u.baseUrl ?? u.url);
	            if (uBaseList.length) u.baseURL = (uBaseList.length === 1 ? uBaseList[0] : uBaseList);
	            delete u.baseURLs;
	          }
	        }

	        out.providers[pid] = p;
	      }

	      return out;
	    }

		    function runConfigCheck(root, upstreamKeysPayload){
	      const errors = [];
	      const warns = [];

	      if (!root || typeof root !== 'object') {
	        errors.push('配置为空或不是对象（请先“加载配置”）。');
	        return { errors, warns };
	      }

	      const version = Number(root.version ?? 1);
	      if (!(version === 1)) warns.push('version 不是 1（当前仅支持 version=1）。');

	      const providers = (root.providers && typeof root.providers === 'object') ? root.providers : null;
	      if (!providers || !Object.keys(providers).length) {
	        errors.push('providers 为空（至少需要配置 1 个 provider）。');
	        return { errors, warns };
	      }

	      const requiredKeyNames = new Set();

		      for (const pid of Object.keys(providers).sort()) {
		        const p = (providers[pid] && typeof providers[pid] === 'object') ? providers[pid] : {};
		        const apiMode = safeStr(p.apiMode || '').trim();
		        if (!apiMode) errors.push('Provider ' + pid + ': 缺少 apiMode。');

	        const hasUpstreams = Array.isArray(p.upstreams) && p.upstreams.length > 0;
		        if (hasUpstreams) {
		          const seen = new Set();
		          for (let i = 0; i < p.upstreams.length; i++) {
		            const u = (p.upstreams[i] && typeof p.upstreams[i] === 'object') ? p.upstreams[i] : {};
		            const uid = safeStr(u.id || ('#' + (i + 1))).trim() || ('#' + (i + 1));
		            if (seen.has(uid)) warns.push('Provider ' + pid + ' upstream ' + uid + ': id 重复（建议唯一）。');
		            seen.add(uid);

		            const base = getFirstBaseUrl(u);
		            if (!base) errors.push('Provider ' + pid + ' upstream ' + uid + ': 缺少 baseURL。');

		            const keyEnv = safeStr(u.apiKeyEnv || '').trim();
		            const inlineKey = safeStr(u.apiKey || '').trim();
		            if (!keyEnv && !inlineKey) errors.push('Provider ' + pid + ' upstream ' + uid + ': 缺少 apiKeyEnv 或 apiKey。');
		            if (keyEnv) requiredKeyNames.add(keyEnv);

		            const wt = Number(u.weight == null ? 1 : u.weight);
		            if (!Number.isFinite(wt) || wt <= 0) warns.push('Provider ' + pid + ' upstream ' + uid + ': weight 非法（应为 >0 数字）。');
		          }
		        } else {
		          const base = getFirstBaseUrl(p);
		          if (!base) errors.push('Provider ' + pid + ': 缺少 baseURL。');

		          const keyEnv = safeStr(p.apiKeyEnv || '').trim();
		          const inlineKey = safeStr(p.apiKey || '').trim();
		          if (!keyEnv && !inlineKey) errors.push('Provider ' + pid + ': 缺少 apiKeyEnv 或 apiKey。');
		          if (keyEnv) requiredKeyNames.add(keyEnv);
		        }

		        const models = (p.models && typeof p.models === 'object') ? p.models : {};
		        const mnames = Object.keys(models || {});
		        if (!mnames.length) warns.push('Provider ' + pid + ': 未配置 models（建议至少 1 个）。');
		        for (const mn of mnames) {
		          const m = (models[mn] && typeof models[mn] === 'object') ? models[mn] : {};
		          const up = safeStr(m.upstreamModel || '').trim();
		          if (!up) warns.push('Provider ' + pid + ' model ' + mn + ': upstreamModel 为空（请求时可能失败）。');
		        }
		      }

	      // Optional: check referenced apiKeyEnv presence (if secrets API enabled).
		      const byName = upstreamKeysPayload && typeof upstreamKeysPayload === 'object' ? upstreamKeysPayload.byName : null;
		      if (byName && typeof byName === 'object') {
		        for (const name of Array.from(requiredKeyNames).sort()) {
		          const info = byName[name];
		          if (!info) {
		            warns.push('环境变量 ' + name + ': 未出现在 /admin/api/upstream_keys 列表里（可能不在 allowlist）。');
		            continue;
		          }
		          if (!info.present) errors.push('环境变量 ' + name + ': 未设置（对应 apiKeyEnv 引用）。');
		        }
		      } else {
		        warns.push('未启用密钥检测（WEB_UI_SECRETS_VIEW 关闭或无权限），跳过 apiKeyEnv 是否存在的检查。');
		      }

	      return { errors, warns };
	    }

		    function renderProvidersForm(){
		      if (!providersFormEl) return;
		      const root = normalizeCfgObjForUi(ensureCfgObj());
		      providersFormEl.innerHTML = '';
		      const providers = root.providers && typeof root.providers === 'object' ? root.providers : {};
		      const apiKeyEnvDefaults = [
		        'OPENAI_API_KEY',
		        'OPENAI_API_KEY_RELAY_A',
		        'OPENAI_API_KEY_RELAY_B',
		        'ANTHROPIC_API_KEY',
		        'GEMINI_API_KEY',
		      ];
		      const apiKeyEnvChoicesForUi = mergeStringLists(apiKeyEnvDefaults, mergeStringLists(collectApiKeyEnvChoicesFromConfig(root), apiKeyEnvChoiceState.list));
		      const ids = Object.keys(providers).sort();
		      if (!ids.length) {
		        const empty = document.createElement('div');
	        empty.className = 'card muted';
	        empty.style.textAlign = 'center';
	        empty.style.padding = '32px';
	        empty.innerHTML = '<div style="font-size:48px; margin-bottom:12px">📦</div><div>尚未配置任何 provider</div><div style="margin-top:8px">点击上方"添加 Provider"开始配置</div>';
	        providersFormEl.appendChild(empty);
	        return;
	      }

	      for (const pid of ids) {
	        const p = providers[pid] || {};
	        const card = document.createElement('div');
	        card.className = 'card';
	        card.style.marginBottom = '16px';

	        const header = document.createElement('div');
	        header.style.display = 'flex';
	        header.style.justifyContent = 'space-between';
	        header.style.alignItems = 'center';
	        header.style.marginBottom = '16px';
	        header.style.paddingBottom = '12px';
	        header.style.borderBottom = '1px solid var(--border)';

	        const title = document.createElement('div');
	        title.style.display = 'flex';
	        title.style.alignItems = 'center';
	        title.style.gap = '10px';
	        title.innerHTML = '<span style="font-size:20px">⚡</span><span style="font-weight:700; font-size:16px">' + pid + '</span>';
	        header.appendChild(title);

	        const delBtn = document.createElement('button');
	        delBtn.className = 'danger';
	        delBtn.textContent = '🗑️ 删除';
	        delBtn.style.padding = '6px 12px';
	        delBtn.style.fontSize = '13px';
	        delBtn.addEventListener('click', (e) => {
	          e.preventDefault();
	          if (!confirm('确认删除 provider ' + pid + ' ?')) return;
	          delete root.providers[pid];
	          renderProvidersForm();
	        });
	        header.appendChild(delBtn);
	        card.appendChild(header);

	        const grid = document.createElement('div');
	        grid.className = 'grid';
	        grid.style.marginTop = '16px';

	        const apiModeWrap = document.createElement('div');
	        const apiModeLabel = document.createElement('label');
	        apiModeLabel.textContent = 'apiMode';
	        apiModeWrap.appendChild(apiModeLabel);
	        const apiModePicker = createApiModePicker({
	          value: safeStr(p.apiMode || ''),
	          onChange: (v) => { p.apiMode = safeStr(v).trim(); providers[pid] = p; },
	        });
	        apiModeWrap.appendChild(apiModePicker);
	        grid.appendChild(apiModeWrap);

	        const discoverWrap = document.createElement('div');
	        const discoverLabel = document.createElement('label');
	        discoverLabel.textContent = 'discoverModels（自动拉取上游模型）';
	        discoverWrap.appendChild(discoverLabel);
	        const discoverRow = document.createElement('div');
	        discoverRow.style.display = 'flex';
	        discoverRow.style.gap = '10px';
	        discoverRow.style.alignItems = 'center';
	        const discover = document.createElement('input');
	        discover.type = 'checkbox';
	        discover.checked = Boolean(p.discoverModels);
	        discover.addEventListener('change', () => { p.discoverModels = Boolean(discover.checked); providers[pid] = p; });
	        discoverRow.appendChild(discover);
	        const discoverHint = document.createElement('div');
	        discoverHint.className = 'muted';
	        discoverHint.textContent = '开启后会尝试调用上游 GET /v1/models（或 /models），用于免手写模型名/前端下拉框。';
	        discoverRow.appendChild(discoverHint);
	        discoverWrap.appendChild(discoverRow);
	        grid.appendChild(discoverWrap);

	        const upstreams = Array.isArray(p.upstreams) ? p.upstreams : [];
	        const useUpsWrap = document.createElement('div');
	        const useUpsLabel = document.createElement('label');
	        useUpsLabel.textContent = '使用 upstreams（多上游聚合）';
	        useUpsWrap.appendChild(useUpsLabel);
	        const useUpsRow = document.createElement('div');
	        useUpsRow.style.display = 'flex';
	        useUpsRow.style.gap = '10px';
	        useUpsRow.style.alignItems = 'center';
	        const useUps = document.createElement('input');
	        useUps.type = 'checkbox';
	        useUps.checked = upstreams.length > 0;
	        useUps.addEventListener('change', () => {
	          if (useUps.checked) {
	            if (!Array.isArray(p.upstreams) || !p.upstreams.length) p.upstreams = [{ id: 'u1', baseURLs: [], baseURL: '', apiKeyEnv: '', weight: 1 }];
	            delete p.baseURL;
	            delete p.baseURLs;
	            delete p.apiKeyEnv;
	          } else {
	            delete p.upstreams;
	            if (typeof p.baseURL !== 'string') p.baseURL = '';
	            if (typeof p.apiKeyEnv !== 'string') p.apiKeyEnv = '';
	            setSingleBaseUrl(p, p.baseURL);
	          }
	          providers[pid] = p;
	          renderProvidersForm();
	        });
	        useUpsRow.appendChild(useUps);
	        const useUpsHint = document.createElement('div');
	        useUpsHint.className = 'muted';
	        useUpsHint.textContent = '勾选后每个 upstream 单独配置 baseURL + apiKeyEnv';
	        useUpsRow.appendChild(useUpsHint);
	        useUpsWrap.appendChild(useUpsRow);
	        grid.appendChild(useUpsWrap);

	        if (Array.isArray(p.upstreams) && p.upstreams.length) {
	          const upsWrap = document.createElement('div');
	          const upsLabel = document.createElement('label');
	          upsLabel.textContent = '📡 upstreams（上游列表）';
	          upsWrap.appendChild(upsLabel);

	          const addUpBtn = document.createElement('button');
	          addUpBtn.textContent = '➕ 添加 upstream';
	          addUpBtn.style.marginBottom = '12px';
	          addUpBtn.addEventListener('click', (e) => {
	            e.preventDefault();
	            const n = (Array.isArray(p.upstreams) ? p.upstreams.length : 0) + 1;
	            p.upstreams = Array.isArray(p.upstreams) ? p.upstreams : [];
	            p.upstreams.push({ id: 'u' + n, baseURLs: [], baseURL: '', apiKeyEnv: '', weight: 1 });
	            providers[pid] = p;
	            renderProvidersForm();
	          });
	          upsWrap.appendChild(addUpBtn);

	          const upsBox = document.createElement('div');
	          upsBox.style.display = 'grid';
	          upsBox.style.gap = '12px';

	          for (let i = 0; i < p.upstreams.length; i++) {
	            const u = p.upstreams[i] || {};
	            const row = document.createElement('div');
	            row.style.border = '1px solid var(--border)';
	            row.style.borderRadius = '10px';
	            row.style.padding = '12px';
	            row.style.display = 'grid';
	            row.style.gap = '10px';
	            row.style.background = 'var(--bg)';

	            const top = document.createElement('div');
	            top.style.display = 'flex';
	            top.style.gap = '10px';
	            top.style.flexWrap = 'wrap';
	            top.style.alignItems = 'center';

	            const idIn = document.createElement('input');
	            idIn.placeholder = 'id（标识符）';
	            idIn.value = safeStr(u.id || '');
	            idIn.addEventListener('input', () => { u.id = idIn.value.trim(); p.upstreams[i] = u; providers[pid] = p; });
	            top.appendChild(idIn);

	            const wtIn = document.createElement('input');
	            wtIn.placeholder = 'weight（权重）';
	            wtIn.value = safeStr(u.weight == null ? 1 : u.weight);
	            wtIn.addEventListener('input', () => {
	              const n = Number(wtIn.value);
	              u.weight = Number.isFinite(n) && n > 0 ? n : 1;
	              p.upstreams[i] = u;
	              providers[pid] = p;
	            });
	            top.appendChild(wtIn);

	            const rm = document.createElement('button');
	            rm.className = 'danger';
	            rm.textContent = '🗑️ 删除';
	            rm.style.padding = '8px 12px';
	            rm.addEventListener('click', (e) => {
	              e.preventDefault();
	              p.upstreams.splice(i, 1);
	              providers[pid] = p;
	              renderProvidersForm();
	            });
	            top.appendChild(rm);
	            row.appendChild(top);

	            const baseIn = document.createElement('input');
	            baseIn.placeholder = 'baseURL (上游/中转站地址)';
	            baseIn.value = safeStr(getFirstBaseUrl(u) || '');
	            baseIn.addEventListener('input', () => { setSingleBaseUrl(u, baseIn.value); p.upstreams[i] = u; providers[pid] = p; });
	            row.appendChild(baseIn);

		            const keyEnvEditor = createApiKeyEnvEditor({
		              getValue: () => safeStr(u.apiKeyEnv || ''),
		              setValue: (v) => { u.apiKeyEnv = safeStr(v).trim(); p.upstreams[i] = u; providers[pid] = p; },
		              choices: apiKeyEnvChoicesForUi,
		              placeholder: 'apiKeyEnv (例如 OPENAI_API_KEY_RELAY_A)',
		            });
		            row.appendChild(keyEnvEditor);

	            upsBox.appendChild(row);
	          }

	          upsWrap.appendChild(upsBox);
	          grid.appendChild(upsWrap);
	        } else {
	          const baseWrap = document.createElement('div');
	          const baseLabel = document.createElement('label');
	          baseLabel.textContent = 'baseURL';
	          baseWrap.appendChild(baseLabel);
	          const base = document.createElement('input');
	          base.placeholder = '上游/中转站地址';
	          base.value = safeStr(getFirstBaseUrl(p) || '');
	          base.addEventListener('input', () => { setSingleBaseUrl(p, base.value); providers[pid] = p; });
	          baseWrap.appendChild(base);
	          grid.appendChild(baseWrap);

		          const keyWrap = document.createElement('div');
		          const keyLabel = document.createElement('label');
		          keyLabel.textContent = 'apiKeyEnv';
		          keyWrap.appendChild(keyLabel);
		          const editor = createApiKeyEnvEditor({
		            getValue: () => safeStr(p.apiKeyEnv || ''),
		            setValue: (v) => { p.apiKeyEnv = safeStr(v).trim(); providers[pid] = p; },
		            choices: apiKeyEnvChoicesForUi,
		            placeholder: '例如 OPENAI_API_KEY / GEMINI_API_KEY',
		          });
		          keyWrap.appendChild(editor);
		          grid.appendChild(keyWrap);
		        }

	        const modelsWrap = document.createElement('div');
	        const modelsLabel = document.createElement('label');
	        modelsLabel.textContent = '🤖 models（模型列表）';
	        modelsWrap.appendChild(modelsLabel);

	        const addModelBtn = document.createElement('button');
	        addModelBtn.textContent = '➕ 添加 model';
	        addModelBtn.style.marginBottom = '12px';
	        addModelBtn.addEventListener('click', (e) => {
	          e.preventDefault();
	          const name = prompt('modelName（对外展示/请求里使用）', '');
	          if (!name) return;
	          const n = name.trim();
	          if (!n) return;
	          p.models = (p.models && typeof p.models === 'object') ? p.models : {};
	          if (!p.models[n]) p.models[n] = { upstreamModel: n };
	          providers[pid] = p;
	          renderProvidersForm();
	        });
	        modelsWrap.appendChild(addModelBtn);

	        const models = (p.models && typeof p.models === 'object') ? p.models : {};
	        const mnames = Object.keys(models).sort();
	        const list = document.createElement('div');
	        list.style.display = 'grid';
	        list.style.gap = '12px';

	        if (!mnames.length) {
	          const hint = document.createElement('div');
	          hint.className = 'muted';
	          hint.style.textAlign = 'center';
	          hint.style.padding = '20px';
	          hint.style.border = '1px dashed var(--border)';
	          hint.style.borderRadius = '8px';
	          hint.textContent = '💡 建议至少配置 1 个 model';
	          list.appendChild(hint);
	        }

	        for (const mn of mnames) {
	          const m = models[mn] || {};
	          const row = document.createElement('div');
	          row.style.border = '1px solid var(--border)';
	          row.style.borderRadius = '10px';
	          row.style.padding = '12px';
	          row.style.display = 'grid';
	          row.style.gap = '10px';
	          row.style.background = 'var(--bg)';

	          const top = document.createElement('div');
	          top.style.display = 'flex';
	          top.style.justifyContent = 'space-between';
	          top.style.alignItems = 'center';
	          top.style.paddingBottom = '8px';
	          top.style.borderBottom = '1px solid var(--border)';

	          const name = document.createElement('div');
	          name.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
	          name.style.fontSize = '13px';
	          name.style.fontWeight = '600';
	          name.style.color = 'var(--accent-light)';
	          name.textContent = '📦 ' + mn;
	          top.appendChild(name);

	          const rm = document.createElement('button');
	          rm.className = 'danger';
	          rm.textContent = '🗑️ 删除';
	          rm.style.padding = '6px 12px';
	          rm.style.fontSize = '13px';
	          rm.addEventListener('click', (e) => {
	            e.preventDefault();
	            delete models[mn];
	            p.models = models;
	            providers[pid] = p;
	            renderProvidersForm();
	          });
	          top.appendChild(rm);
	          row.appendChild(top);

	          const up = document.createElement('input');
	          up.placeholder = 'upstreamModel（上游真实模型名）';
	          up.value = safeStr(m.upstreamModel || mn);
	          up.addEventListener('input', () => { m.upstreamModel = up.value.trim() || mn; models[mn] = m; p.models = models; providers[pid] = p; });
	          row.appendChild(up);

	          list.appendChild(row);
	        }

	        modelsWrap.appendChild(list);
	        grid.appendChild(modelsWrap);

	        card.appendChild(grid);
	        providersFormEl.appendChild(card);
	      }
	    }

	    function cfgToJsonText(){
	      return JSON.stringify(cfgToWritableObject(), null, 2);
	    }

    function loadCfgDraft(){
      try { cfgEl.value = localStorage.getItem('rsp4copilot.cfgDraft') || ''; } catch {}
    }
    function saveCfgDraft(){
      try { localStorage.setItem('rsp4copilot.cfgDraft', cfgEl.value || ''); } catch {}
    }
    cfgEl?.addEventListener('input', saveCfgDraft);
    loadCfgDraft();

	    document.getElementById('btnCfgLoad')?.addEventListener('click', async () => {
	      try{
	        setCfgStatus('加载中...');
	        const r = await callAdmin('/admin/api/config', { method: 'GET' });
	        if (r.status !== 200) {
	          setCfgStatus('加载失败：HTTP ' + r.status);
	          setOut(pretty(r), true);
	          return;
	        }
	        const json = JSON.parse(r.text);
	        cfgEl.value = String(json && json.content ? json.content : '');
	        saveCfgDraft();
	        const parsed = json && json.parsed ? json.parsed : null;
	        const writable = json && json.writeEnabled;
	        const exists = json && json.exists;
	        cfgObj = (json && json.config && typeof json.config === 'object') ? json.config : null;
	        if (!cfgObj) {
	          try { cfgObj = JSON.parse(cfgEl.value || '{}'); } catch {}
	        }
		        if (cfgObj) {
		          normalizeCfgObjForUi(cfgObj);
		          renderProvidersForm();
		          loadApiKeyEnvChoicesFromServer().then(() => { try { if (cfgObj) renderProvidersForm(); } catch {} });
		        }
		        setCfgStatus('已加载。文件存在=' + (exists ? 'true' : 'false') + '；写入权限(开关)=' + (writable ? 'true' : 'false') + (parsed && parsed.ok === false ? '；解析错误：' + parsed.error : ''));
		      } catch (e) {
		        setCfgStatus('加载异常：' + String(e && e.message ? e.message : e));
		      }
		    });

		    document.getElementById('btnCfgSave')?.addEventListener('click', async () => {
		      try{
		        setCfgStatus('保存中...');
		        // If user edits via the visual form, always apply it to text before saving.
		        // This will overwrite JSONC comments in the textarea.
		        if (cfgObj) {
		          cfgEl.value = cfgToJsonText();
		          saveCfgDraft();
		        }
		        const content = (cfgEl.value || '').trim();
		        if (!content) { setCfgStatus('配置为空，未保存'); return; }
		        const r = await callAdmin('/admin/api/config', { method: 'PUT', body: JSON.stringify({ content }) });
		        if (r.status !== 200) {
		          let msg = '保存失败：HTTP ' + r.status;
		          try {
		            const j = JSON.parse(r.text || '{}');
		            const em = j && j.error && j.error.message ? String(j.error.message) : '';
		            if (em) msg += '；' + em;
		          } catch {}
		          setCfgStatus(msg);
		          setOut(pretty(r), true);
		          return;
		        }
		        setCfgStatus('保存成功。');
		      } catch (e) {
		        setCfgStatus('保存异常：' + String(e && e.message ? e.message : e));
		      }
		    });

	    document.getElementById('btnCfgVisualRender')?.addEventListener('click', async () => {
	      try{
	        if (!cfgObj) {
	          const raw = (cfgEl.value || '').trim();
	          if (raw) {
	            try { cfgObj = JSON.parse(raw); } catch {}
	          }
	        }
		        if (!cfgObj) { setCfgStatus('没有可视化数据：请先点击“加载配置”。'); return; }
		        normalizeCfgObjForUi(cfgObj);
		        renderProvidersForm();
		        loadApiKeyEnvChoicesFromServer().then(() => { try { if (cfgObj) renderProvidersForm(); } catch {} });
		        setCfgStatus('可视化已刷新。');
		      } catch (e) {
		        setCfgStatus('刷新异常：' + String(e && e.message ? e.message : e));
		      }
		    });

		    document.getElementById('btnCfgAddProvider')?.addEventListener('click', async () => {
		      try{
		        const root = ensureCfgObj();
		        setCfgStatus('添加 Provider：请输入 id...');
		        const id0 = await promptTextModal({
		          title: '添加 Provider',
		          label: 'provider id（不能包含点号）',
		          placeholder: '例如 openai',
		          initialValue: 'openai',
		          okText: '添加',
		          cancelText: '取消',
		        });
		        const id = String(id0 || '').trim();
		        if (!id) { setCfgStatus('已取消添加。'); return; }
		        if (id.includes('.')) { alert('provider id 不能包含 .'); return; }
		        if (!/^[A-Za-z0-9_-]+$/.test(id)) { alert('provider id 建议只用字母/数字/_/-'); return; }
		        if (root.providers[id]) { alert('已存在 provider: ' + id); return; }
		        root.providers[id] = { apiMode: 'openai-responses', baseURL: '', apiKeyEnv: '', models: {} };
		        cfgObj = root;
		        renderProvidersForm();
		        setCfgStatus('已添加 provider：' + id);
		      } catch (e) {
		        setCfgStatus('添加异常：' + String(e && e.message ? e.message : e));
		      }
		    });

	    document.getElementById('btnCfgApplyToText')?.addEventListener('click', async () => {
	      try{
	        if (!cfgObj) { setCfgStatus('没有可应用的数据：请先点击“加载配置”。'); return; }
	        cfgEl.value = cfgToJsonText();
	        saveCfgDraft();
	        setCfgStatus('已把可视化配置写入文本（JSON 格式；会覆盖注释）。');
	      } catch (e) {
	        setCfgStatus('应用异常：' + String(e && e.message ? e.message : e));
	      }
	    });

	    document.getElementById('btnCfgCheck')?.addEventListener('click', async () => {
	      try{
	        setCfgStatus('检测中...');
	        if (!cfgObj) {
	          const raw = (cfgEl.value || '').trim();
	          if (raw) {
	            try { cfgObj = JSON.parse(raw); } catch {}
	          }
	        }
	        if (!cfgObj) { setCfgStatus('没有可检测的数据：请先点击“加载配置”。'); return; }

	        normalizeCfgObjForUi(cfgObj);

	        let upstreamKeysPayload = null;
	        try {
	          const r = await callAdmin('/admin/api/upstream_keys', { method: 'GET' });
	          if (r.status === 200) {
	            const j = JSON.parse(r.text || '{}');
	            upstreamKeysPayload = j && typeof j === 'object' ? j : null;
	          }
	        } catch {}

	        const { errors, warns } = runConfigCheck(cfgObj, upstreamKeysPayload);
	        const lines = [];
	        if (errors.length) {
	          lines.push('❌ 错误：');
	          for (const e of errors) lines.push('- ' + e);
	        } else {
	          lines.push('✅ 未发现阻断错误。');
	        }
	        if (warns.length) {
	          lines.push('');
	          lines.push('⚠️ 提示：');
	          for (const w of warns) lines.push('- ' + w);
	        }

	        setOut(lines.join('\\n'), errors.length > 0);
	        setCfgStatus('检测完成：错误 ' + errors.length + '；提示 ' + warns.length + '。');
	      } catch (e) {
	        setCfgStatus('检测异常：' + String(e && e.message ? e.message : e));
	      }
	    });

    function setSecretsStatus(text){
      secretsStatusEl.textContent = text || '';
    }

    function saveSecretsRevealPref(){
      try { localStorage.setItem('rsp4copilot.secretsReveal', secretsRevealEl.checked ? '1' : '0'); } catch {}
    }
    function loadSecretsRevealPref(){
      try { secretsRevealEl.checked = (localStorage.getItem('rsp4copilot.secretsReveal') || '0') === '1'; } catch {}
    }
    secretsRevealEl.addEventListener('change', saveSecretsRevealPref);
    loadSecretsRevealPref();

    document.getElementById('btnSecrets').addEventListener('click', async () => {
      try{
        setSecretsStatus('加载中...');
        const reveal = secretsRevealEl.checked;
        const path = reveal ? '/admin/api/secrets?reveal=1' : '/admin/api/secrets';
        const r = await callAdmin(path, { method: 'GET' });
        if (r.status !== 200) {
          setSecretsStatus('加载失败：HTTP ' + r.status);
          setOut(pretty(r), true);
          return;
        }
        let json = null;
        try { json = JSON.parse(r.text); } catch {}
        secretsEl.value = json ? JSON.stringify(json, null, 2) : r.text;
        const allowReveal = json && json.allowReveal;
        const mode = json && json.mode;
        setSecretsStatus('已加载。mode=' + (mode || '') + (reveal && allowReveal === false ? '（服务端未允许明文）' : ''));
      } catch (e) {
        setSecretsStatus('加载异常：' + String(e && e.message ? e.message : e));
      }
    });

	    function setUpKeysStatus(text){
	      upKeysStatusEl.textContent = text || '';
	    }

	    function saveUpKeysRevealPref(){
	      try { localStorage.setItem('rsp4copilot.upKeysReveal', upKeysRevealEl.checked ? '1' : '0'); } catch {}
	    }
	    function loadUpKeysRevealPref(){
	      try { upKeysRevealEl.checked = (localStorage.getItem('rsp4copilot.upKeysReveal') || '0') === '1'; } catch {}
	    }
	    upKeysRevealEl.addEventListener('change', saveUpKeysRevealPref);
	    loadUpKeysRevealPref();

	    function clearUpKeysForm(){
	      upKeysFormEl.innerHTML = '';
	    }

	    function renderUpKeysForm(data){
	      clearUpKeysForm();
	      const providers = Array.isArray(data && data.providers) ? data.providers : [];
	      if (!providers.length) {
	        const empty = document.createElement('div');
	        empty.className = 'muted';
	        empty.textContent = '未发现可编辑的 apiKeyEnv（请检查配置是否使用 apiKeyEnv / upstreams）。';
	        upKeysFormEl.appendChild(empty);
	        return;
	      }

	      for (const p of providers) {
	        const pid = String(p && p.providerId ? p.providerId : '').trim() || '(unknown)';
	        const items = Array.isArray(p && p.items) ? p.items : [];

	        // Group by envVar so shared keys are edited once.
	        const byEnv = new Map();
	        for (const it of items) {
	          const envVar = String(it && it.envVar ? it.envVar : '').trim();
	          if (!envVar) continue;
	          if (!byEnv.has(envVar)) {
	            byEnv.set(envVar, { envVar, present: Boolean(it.present), value: String(it.value || ''), refs: [] });
	          }
	          const g = byEnv.get(envVar);
	          g.present = g.present || Boolean(it.present);
	          if (!g.value && it.value) g.value = String(it.value || '');
	          const kind = String(it.kind || '');
	          const upstreamId = String(it.upstreamId || '');
	          if (kind === 'provider') g.refs.push('provider');
	          else g.refs.push(upstreamId ? ('upstream:' + upstreamId) : 'upstream');
	        }

	        const box = document.createElement('div');
	        box.style.border = '1px solid var(--border)';
	        box.style.borderRadius = '12px';
	        box.style.padding = '12px';

	        const title = document.createElement('div');
	        title.style.fontWeight = '700';
	        title.style.marginBottom = '8px';
	        title.textContent = 'Provider: ' + pid;
	        box.appendChild(title);

	        const list = document.createElement('div');
	        list.style.display = 'grid';
	        list.style.gap = '10px';

	        for (const [envVar, g] of Array.from(byEnv.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
	          const row = document.createElement('div');
	          row.style.display = 'grid';
	          row.style.gridTemplateColumns = '1fr';
	          row.style.gap = '6px';
	          row.style.padding = '10px';
	          row.style.border = '1px solid var(--border)';
	          row.style.borderRadius = '10px';

	          const top = document.createElement('div');
	          top.style.display = 'flex';
	          top.style.gap = '10px';
	          top.style.flexWrap = 'wrap';
	          top.style.alignItems = 'baseline';

	          const name = document.createElement('div');
	          name.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
	          name.style.fontSize = '12px';
	          name.textContent = envVar;

	          const refs = document.createElement('div');
	          refs.className = 'muted';
	          refs.textContent = (g.refs && g.refs.length ? g.refs.join(', ') : '');

	          const status = document.createElement('div');
	          status.className = 'muted';
	          status.textContent = '当前=' + (g.present ? (g.value || '(set)') : '(missing)');

	          top.appendChild(name);
	          top.appendChild(refs);
	          top.appendChild(status);
	          row.appendChild(top);

	          const inputRow = document.createElement('div');
	          inputRow.style.display = 'flex';
	          inputRow.style.gap = '10px';
	          inputRow.style.alignItems = 'center';

	          const input = document.createElement('input');
	          input.type = 'password';
	          input.placeholder = '输入新 key（留空则不修改）';
	          input.setAttribute('data-env-var', envVar);
	          input.autocomplete = 'new-password';
	          inputRow.appendChild(input);

	          const toggle = document.createElement('button');
	          toggle.textContent = '显示/隐藏';
	          toggle.addEventListener('click', (e) => {
	            e.preventDefault();
	            input.type = input.type === 'password' ? 'text' : 'password';
	          });
	          inputRow.appendChild(toggle);

	          row.appendChild(inputRow);
	          list.appendChild(row);
	        }

	        box.appendChild(list);
	        upKeysFormEl.appendChild(box);
	      }

	      // 显示其他环境变量和添加新变量的区域
	      const allowAddNew = data && data.allowAddNew === true;
	      const otherEnvVars = Array.isArray(data && data.otherEnvVars) ? data.otherEnvVars : [];

	      if (allowAddNew) {
	        const otherBox = document.createElement('div');
	        otherBox.style.border = '1px solid var(--border)';
	        otherBox.style.borderRadius = '12px';
	        otherBox.style.padding = '12px';
	        otherBox.style.marginTop = '12px';

	        const otherTitle = document.createElement('div');
	        otherTitle.style.fontWeight = '700';
	        otherTitle.style.marginBottom = '8px';
	        otherTitle.textContent = '其他环境变量（不在配置中的）';
	        otherBox.appendChild(otherTitle);

	        const otherDesc = document.createElement('div');
	        otherDesc.className = 'muted';
	        otherDesc.style.fontSize = '12px';
	        otherDesc.style.marginBottom = '12px';
	        otherDesc.textContent = '这些环境变量已存在于文件中，但不在当前配置的 apiKeyEnv 引用里。';
	        otherBox.appendChild(otherDesc);

	        // 显示已存在的其他变量
	        if (otherEnvVars.length > 0) {
	          const otherList = document.createElement('div');
	          otherList.style.display = 'grid';
	          otherList.style.gap = '10px';
	          otherList.style.marginBottom = '16px';

	          for (const env of otherEnvVars) {
	            const row = document.createElement('div');
	            row.style.display = 'grid';
	            row.style.gridTemplateColumns = '1fr';
	            row.style.gap = '6px';
	            row.style.padding = '10px';
	            row.style.border = '1px solid var(--border)';
	            row.style.borderRadius = '10px';

	            const top = document.createElement('div');
	            top.style.display = 'flex';
	            top.style.gap = '10px';
	            top.style.alignItems = 'baseline';

	            const name = document.createElement('div');
	            name.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
	            name.style.fontSize = '12px';
	            name.textContent = env.name || '';

	            const status = document.createElement('div');
	            status.className = 'muted';
	            status.textContent = '当前=' + (env.present ? (env.value || '(set)') : '(missing)');

	            top.appendChild(name);
	            top.appendChild(status);
	            row.appendChild(top);

	            const inputRow = document.createElement('div');
	            inputRow.style.display = 'flex';
	            inputRow.style.gap = '10px';
	            inputRow.style.alignItems = 'center';

	            const input = document.createElement('input');
	            input.type = 'password';
	            input.placeholder = '输入新 key（留空则不修改）';
	            input.setAttribute('data-env-var', env.name || '');
	            input.autocomplete = 'new-password';
	            inputRow.appendChild(input);

	            const toggle = document.createElement('button');
	            toggle.textContent = '显示/隐藏';
	            toggle.addEventListener('click', (e) => {
	              e.preventDefault();
	              input.type = input.type === 'password' ? 'text' : 'password';
	            });
	            inputRow.appendChild(toggle);

	            row.appendChild(inputRow);
	            otherList.appendChild(row);
	          }

	          otherBox.appendChild(otherList);
	        }

	        // 添加新变量的区域
	        const addNewSection = document.createElement('div');
	        addNewSection.style.borderTop = '1px solid var(--border)';
	        addNewSection.style.paddingTop = '12px';
	        addNewSection.style.marginTop = otherEnvVars.length > 0 ? '12px' : '0';

	        const addNewTitle = document.createElement('div');
	        addNewTitle.style.fontWeight = '600';
	        addNewTitle.style.marginBottom = '8px';
	        addNewTitle.textContent = '添加新的 apiKeyEnv';
	        addNewSection.appendChild(addNewTitle);

	        const addNewGrid = document.createElement('div');
	        addNewGrid.style.display = 'grid';
	        addNewGrid.style.gridTemplateColumns = '1fr 1fr auto';
	        addNewGrid.style.gap = '8px';
	        addNewGrid.style.alignItems = 'center';

	        const nameInput = document.createElement('input');
	        nameInput.type = 'text';
	        nameInput.placeholder = '环境变量名（如：ds_key）';
	        nameInput.id = 'new-env-var-name';
	        nameInput.autocomplete = 'off';
	        addNewGrid.appendChild(nameInput);

	        const valueInput = document.createElement('input');
	        valueInput.type = 'password';
	        valueInput.placeholder = '密钥值';
	        valueInput.id = 'new-env-var-value';
	        valueInput.autocomplete = 'new-password';
	        addNewGrid.appendChild(valueInput);

	        const addBtn = document.createElement('button');
	        addBtn.textContent = '+ 添加';
	        addBtn.id = 'btn-add-new-env-var';
	        addBtn.addEventListener('click', () => {
	          const varName = (nameInput.value || '').trim();
	          const varValue = (valueInput.value || '').trim();
	          if (!varName || !varValue) {
	            alert('请填写环境变量名和密钥值');
	            return;
	          }
	          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
	            alert('环境变量名格式不正确（必须以字母或下划线开头，只包含字母、数字和下划线）');
	            return;
	          }

	          // 创建一个新的输入行
	          const newRow = document.createElement('div');
	          newRow.style.display = 'grid';
	          newRow.style.gridTemplateColumns = '1fr';
	          newRow.style.gap = '6px';
	          newRow.style.padding = '10px';
	          newRow.style.border = '1px solid var(--border)';
	          newRow.style.borderRadius = '10px';
	          newRow.style.marginTop = '10px';
	          newRow.className = 'new-env-var-row';

	          const top = document.createElement('div');
	          top.style.display = 'flex';
	          top.style.gap = '10px';
	          top.style.alignItems = 'baseline';

	          const name = document.createElement('div');
	          name.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
	          name.style.fontSize = '12px';
	          name.textContent = varName + ' (新)';

	          const status = document.createElement('div');
	          status.className = 'muted';
	          status.textContent = '当前=新变量';

	          top.appendChild(name);
	          top.appendChild(status);
	          newRow.appendChild(top);

	          const inputRow = document.createElement('div');
	          inputRow.style.display = 'flex';
	          inputRow.style.gap = '10px';
	          inputRow.style.alignItems = 'center';

	          const input = document.createElement('input');
	          input.type = 'password';
	          input.value = varValue;
	          input.setAttribute('data-env-var', varName);
	          input.autocomplete = 'new-password';
	          inputRow.appendChild(input);

	          const toggle = document.createElement('button');
	          toggle.textContent = '显示/隐藏';
	          toggle.addEventListener('click', (e) => {
	            e.preventDefault();
	            input.type = input.type === 'password' ? 'text' : 'password';
	          });
	          inputRow.appendChild(toggle);

	          const removeBtn = document.createElement('button');
	          removeBtn.textContent = '删除';
	          removeBtn.addEventListener('click', () => {
	            newRow.remove();
	          });
	          inputRow.appendChild(removeBtn);

	          newRow.appendChild(inputRow);

	          // 插入到添加新变量区域之前
	          const container = addNewSection.parentNode;
	          if (container) {
	            container.insertBefore(newRow, addNewSection);
	          }

	          // 清空输入框
	          nameInput.value = '';
	          valueInput.value = '';
	        });
	        addNewGrid.appendChild(addBtn);

	        addNewSection.appendChild(addNewGrid);
	        otherBox.appendChild(addNewSection);

	        upKeysFormEl.appendChild(otherBox);
	      }
	    }

	    document.getElementById('btnUpKeysLoad').addEventListener('click', async () => {
	      try{
	        setUpKeysStatus('加载中...');
	        const reveal = upKeysRevealEl.checked;
	        const path = reveal ? '/admin/api/upstream_keys?reveal=1' : '/admin/api/upstream_keys';
	        const r = await callAdmin(path, { method: 'GET' });
	        if (r.status !== 200) {
	          setUpKeysStatus('加载失败：HTTP ' + r.status);
	          setOut(pretty(r), true);
	          return;
	        }
	        const json = JSON.parse(r.text);
	        renderUpKeysForm(json);
	        setUpKeysStatus(
	          '已加载。envFile=' + String(json.envFile || '') +
	          '；writeEnabled=' + String(json.writeEnabled) +
	          '；mode=' + String(json.mode || '') +
	          (reveal && json.allowReveal === false ? '（服务端未允许明文）' : '')
	        );
	      } catch (e) {
	        setUpKeysStatus('加载异常：' + String(e && e.message ? e.message : e));
	      }
	    });

	    document.getElementById('btnUpKeysSave').addEventListener('click', async () => {
	      try{
	        setUpKeysStatus('保存中...');
	        const inputs = Array.from(upKeysFormEl.querySelectorAll('input[data-env-var]'));
	        const updates = {};
	        for (const el of inputs) {
	          const envVar = (el.getAttribute('data-env-var') || '').trim();
	          const v = (el.value || '').trim();
	          if (!envVar || !v) continue;
	          updates[envVar] = v;
	        }
	        const keys = Object.keys(updates);
	        if (!keys.length) { setUpKeysStatus('没有填写任何新 key（留空的不会修改）。'); return; }
	        if (!confirm('确认写入上游 key？这会把值写入服务器文件（/config/rsp4copilot.env）。')) { setUpKeysStatus('已取消。'); return; }

	        const r = await callAdmin('/admin/api/upstream_keys', { method: 'PUT', body: JSON.stringify({ updates }) });
	        if (r.status !== 200) {
	          setUpKeysStatus('保存失败：HTTP ' + r.status);
	          setOut(pretty(r), true);
	          return;
	        }
	        const json = JSON.parse(r.text);
	        setUpKeysStatus('保存成功。updated=' + JSON.stringify(json.updated || []));

	        // Clear input values after save.
	        for (const el of inputs) el.value = '';
	      } catch (e) {
	        setUpKeysStatus('保存异常：' + String(e && e.message ? e.message : e));
	      }
	    });
  </script>
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let reqId = "";
    try {
      reqId = crypto.randomUUID();
    } catch {
      reqId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    }

    const debug = isDebugEnabled(env);
    const corsHeaders = getCorsHeaders(request);

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const startedAt = Date.now();

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const allowedIps = parseCsvEnv(env?.WORKER_ALLOWED_IPS);
      if (allowedIps.length) {
        const clientIp = getClientIp(request, env);
        if (!isClientIpAllowed(clientIp, allowedIps)) {
          return withCors(jsonResponse(403, jsonError("Forbidden", "unauthorized")), corsHeaders);
        }
      }

      // Minimal built-in web UI (optional; protected by Basic Auth).
      if (request.method === "GET" && (path === "/" || path === "/ui")) {
        if (!parseBoolEnv(env?.WEB_UI_ENABLED)) {
          return withCors(jsonResponse(404, jsonError("Not found", "not_found")), corsHeaders);
        }
        const creds = getWebUiBasicCreds(env);
        if (!creds) {
          return withCors(jsonResponse(500, jsonError("Server misconfigured: missing WEB_UI_BASIC_USER/WEB_UI_BASIC_PASS", "server_error")), corsHeaders);
        }
        const parsed = parseBasicAuth(request.headers.get("authorization"));
        if (!parsed || parsed.user !== creds.user || parsed.pass !== creds.pass) {
          const headers: Record<string, string> = {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "www-authenticate": 'Basic realm="rsp4copilot"',
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
            "referrer-policy": "no-referrer",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
          };
          return withCors(new Response("Unauthorized", { status: 401, headers }), corsHeaders);
        }
        const headers: Record<string, string> = {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
        };
        return withCors(new Response(webUiHtml(), { status: 200, headers }), corsHeaders);
      }

      if (debug) {
        const authHeader = request.headers.get("authorization") || "";
        const hasBearer = typeof authHeader === "string" && authHeader.toLowerCase().includes("bearer ");
        const xApiKey = request.headers.get("x-api-key") || "";
        logDebug(debug, reqId, "inbound request", {
          method: request.method,
          host: url.host,
          path,
          search: redactUrlSearchForLog(url),
          userAgent: request.headers.get("user-agent") || "",
          cfRay: request.headers.get("cf-ray") || "",
          hasAuthorization: Boolean(authHeader),
          authScheme: hasBearer ? "bearer" : authHeader ? "custom" : "",
          authorizationLen: typeof authHeader === "string" ? authHeader.length : 0,
          hasXApiKey: Boolean(xApiKey),
          xApiKeyLen: typeof xApiKey === "string" ? xApiKey.length : 0,
          contentType: request.headers.get("content-type") || "",
          contentLength: request.headers.get("content-length") || "",
        });
      }

      const workerAuthKeys = getWorkerAuthKeys(env);
      if (!workerAuthKeys.length) {
        return withCors(jsonResponse(500, jsonError("Server misconfigured: missing WORKER_AUTH_KEY/WORKER_AUTH_KEYS", "server_error")), corsHeaders);
      }

      const authHeader = request.headers.get("authorization");
      let token = bearerToken(authHeader);
      if (!token && typeof authHeader === "string") {
        const maybe = authHeader.trim();
        if (maybe && !maybe.includes(" ")) token = maybe;
      }
      if (!token) token = request.headers.get("x-api-key");
      if (!token) token = request.headers.get("x-goog-api-key");
      if (!token) token = request.headers.get("anthropic-api-key");
      if (!token) token = request.headers.get("x-anthropic-api-key");
      if (!token && path.startsWith("/gemini/")) token = url.searchParams.get("key");
      token = normalizeAuthValue(token);

      if (!token) {
        return withCors(jsonResponse(401, jsonError("Missing API key", "unauthorized"), { "www-authenticate": "Bearer" }), corsHeaders);
      }
      if (!workerAuthKeys.includes(token)) {
        return withCors(jsonResponse(401, jsonError("Unauthorized", "unauthorized"), { "www-authenticate": "Bearer" }), corsHeaders);
      }

      if (debug) {
        logDebug(debug, reqId, "auth ok", { tokenLen: token.length, authKeyCount: workerAuthKeys.length });
      }

      const gatewayCfg = parseGatewayConfig(env);

      if (request.method === "GET" && (path === "/health" || path === "/v1/health")) {
        return withCors(jsonResponse(200, { ok: true, time: Math.floor(Date.now() / 1000) }), corsHeaders);
      }

      // Models list
      if (
        request.method === "GET" &&
        (path === "/v1/models" || path === "/models" || path === "/openai/v1/models" || path === "/claude/v1/models")
      ) {
        if (!gatewayCfg.ok || !gatewayCfg.config) {
          return withCors(jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error")), corsHeaders);
        }
        const entries: ModelListEntry[] = [];
        const seen = new Set<string>();
        for (const [providerId, provider] of Object.entries(gatewayCfg.config.providers || {})) {
          const ownedBy = typeof provider?.ownedBy === "string" && provider.ownedBy.trim() ? provider.ownedBy.trim() : providerId;
          for (const modelName of Object.keys(provider.models || {})) {
            const key = `${providerId}::${modelName}`;
            if (seen.has(key)) continue;
            seen.add(key);
            entries.push({ providerId, modelName, ownedBy });
          }
        }

        // Optional: discover models from upstream `/v1/models` (OpenAI-compatible relays), then cache with TTL.
        try {
          const discovered = await refreshDiscoveredModelsForConfig({ env, config: gatewayCfg.config, request, reqId, debug });
          for (const m of discovered) {
            const key = `${m.providerId}::${m.modelName}`;
            if (seen.has(key)) continue;
            seen.add(key);
            entries.push(m);
          }
        } catch (e) {
          logDebug(debug, reqId, "models discovery: failed", { error: String((e as any)?.message || e) });
        }

        return withCors(jsonResponse(200, openaiModelsListFromEntries(entries)), corsHeaders);
      }
      if (request.method === "GET" && path === "/gemini/v1beta/models") {
        if (!gatewayCfg.ok || !gatewayCfg.config) {
          return withCors(jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error")), corsHeaders);
        }
        return withCors(jsonResponse(200, geminiModelsList(gatewayCfg.config)), corsHeaders);
      }

      // Ollama API compatibility
      if (request.method === "GET" && path === "/api/tags") {
        if (!gatewayCfg.ok || !gatewayCfg.config) {
          return withCors(jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error")), corsHeaders);
        }
        return withCors(jsonResponse(200, ollamaModelsList(gatewayCfg.config)), corsHeaders);
      }
      if (request.method === "GET" && path === "/api/version") {
        return withCors(jsonResponse(200, { version: "0.1.0" }), corsHeaders);
      }

      // OpenAI Chat Completions
      if (request.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
        const parsed = await readJsonBody(request);
        if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
          return withCors(jsonResponse(400, jsonError("Invalid JSON body")), corsHeaders);
        }
        const reqJson = parsed.value as any;

        const model = reqJson.model;
        if (typeof model !== "string" || !model.trim()) return withCors(jsonResponse(400, jsonError("Missing required field: model")), corsHeaders);

        const stream = Boolean(reqJson.stream);
        const extraSystemText = shouldInjectCopilotToolUseInstructions(request, reqJson) ? copilotToolUseInstructionsText() : "";

        if (gatewayCfg.ok && gatewayCfg.config) {
          const providerHint = reqJson.provider ?? reqJson.owned_by ?? reqJson.ownedBy ?? reqJson.owner ?? reqJson.vendor;
          const resolved = resolveModel(gatewayCfg.config, model, providerHint);
          if (resolved.ok === false) return withCors(jsonResponse(resolved.status, resolved.error), corsHeaders);

          reqJson.model = resolved.model.upstreamModel;
          const resp = await dispatchOpenAIChatToProvider({
            request,
            env,
            config: gatewayCfg.config,
            provider: resolved.provider,
            model: resolved.model,
            reqJson,
            stream,
            token,
            debug,
            reqId,
            path,
            startedAt,
            extraSystemText,
          });
          return withCors(resp, corsHeaders);
        }

        return withCors(jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error")), corsHeaders);
      }

      // OpenAI Text Completions (legacy/compat)
      if (request.method === "POST" && (path === "/v1/completions" || path === "/completions")) {
        if (!gatewayCfg.ok || !gatewayCfg.config) {
          return withCors(jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error")), corsHeaders);
        }

        const parsed = await readJsonBody(request);
        if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
          return withCors(jsonResponse(400, jsonError("Invalid JSON body")), corsHeaders);
        }
        const reqJson = parsed.value as any;
        const model = reqJson.model;
        if (typeof model !== "string" || !model.trim()) return withCors(jsonResponse(400, jsonError("Missing required field: model")), corsHeaders);

        const providerHint = reqJson.provider ?? reqJson.owned_by ?? reqJson.ownedBy ?? reqJson.owner ?? reqJson.vendor;
        const resolved = resolveModel(gatewayCfg.config, model, providerHint);
        if (resolved.ok === false) return withCors(jsonResponse(resolved.status, resolved.error), corsHeaders);

        const providerApiMode = typeof resolved.provider.apiMode === "string" ? resolved.provider.apiMode.trim() : "";
        if (providerApiMode !== "openai-responses") {
          return withCors(
            jsonResponse(400, jsonError(`Unsupported apiMode for /v1/completions: ${providerApiMode || "(empty)"}`, "invalid_request_error")),
            corsHeaders,
          );
        }

        const modelOpts = resolved.model?.options || {};
        const reasoningEffort = typeof (modelOpts as any).reasoningEffort === "string" ? String((modelOpts as any).reasoningEffort).trim() : "";
        const upstreamCandidates = listUpstreamCandidates({ env, provider: resolved.provider, request, reqId });
        if (!upstreamCandidates.length) {
          return withCors(
            jsonResponse(500, jsonError(`Server misconfigured: missing upstream API key for provider ${resolved.provider.id}`, "server_error")),
            corsHeaders,
          );
        }

        const stream = Boolean(reqJson.stream);
        const extraSystemText = shouldInjectCopilotToolUseInstructions(request, reqJson) ? copilotToolUseInstructionsText() : "";
        const inheritedCustomHeaders = parseUpstreamCustomHeaders(env);

        let lastResp: Response | null = null;
        for (let i = 0; i < upstreamCandidates.length; i++) {
          const upstream = upstreamCandidates[i];
          const responsesPath =
            (upstream.endpoints && typeof (upstream.endpoints as any).responsesPath === "string" && String((upstream.endpoints as any).responsesPath).trim()) ||
            (upstream.endpoints && typeof (upstream.endpoints as any).responses_path === "string" && String((upstream.endpoints as any).responses_path).trim()) ||
            "";

          const upstreamHeadersEnv =
            upstream.customHeader && Object.keys(upstream.customHeader).length
              ? JSON.stringify({ ...inheritedCustomHeaders, ...upstream.customHeader })
              : "";
          const env2: Env = {
            ...env,
            OPENAI_BASE_URL: joinUrls(upstream.baseURLs),
            OPENAI_API_KEY: upstream.apiKey,
            ...(upstreamHeadersEnv ? { RSP4COPILOT_UPSTREAM_HEADERS: upstreamHeadersEnv } : null),
            ...(responsesPath ? { RESP_RESPONSES_PATH: responsesPath } : null),
            ...(reasoningEffort ? { RESP_REASONING_EFFORT: reasoningEffort } : null),
          };

          const resp = await handleOpenAIRequest({
            request,
            env: env2,
            reqJson,
            model: resolved.model.upstreamModel,
            stream,
            token,
            debug,
            reqId,
            path,
            startedAt,
            isTextCompletions: true,
            extraSystemText,
          });

          lastResp = resp;
          if (resp.ok) return withCors(resp, corsHeaders);
          if (!shouldTryNextUpstreamCandidateStatus(resp.status) || i === upstreamCandidates.length - 1) return withCors(resp, corsHeaders);
        }

        return withCors(lastResp || jsonResponse(502, jsonError("Upstream error", "bad_gateway")), corsHeaders);
      }

      // OpenAI Responses
      if (request.method === "POST" && (path === "/v1/responses" || path === "/responses" || path === "/openai/v1/responses")) {
        if (!gatewayCfg.ok || !gatewayCfg.config) {
          return withCors(jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error")), corsHeaders);
        }

        const parsed = await readJsonBody(request);
        if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
          return withCors(jsonResponse(400, jsonError("Invalid JSON body")), corsHeaders);
        }
        const respReq = parsed.value as any;
        const providerHint = respReq.provider ?? respReq.owned_by ?? respReq.ownedBy ?? respReq.owner ?? respReq.vendor;
        const resolved = resolveModel(gatewayCfg.config, respReq.model, providerHint);
        if (resolved.ok === false) return withCors(jsonResponse(resolved.status, resolved.error), corsHeaders);

        const stream = Boolean(respReq.stream);
        const modelId = typeof respReq.model === "string" ? respReq.model : "";
        const providerApiMode = typeof resolved.provider.apiMode === "string" ? resolved.provider.apiMode.trim() : "";

        // If the upstream is also OpenAI Responses, proxy it directly to preserve multimodal outputs (e.g. images).
        if (providerApiMode === "openai-responses") {
          const modelOpts = resolved.model?.options || {};
          const reasoningEffort = typeof (modelOpts as any).reasoningEffort === "string" ? String((modelOpts as any).reasoningEffort).trim() : "";
          const upstreamCandidates = listUpstreamCandidates({ env, provider: resolved.provider, request, reqId });
          if (!upstreamCandidates.length) {
            return withCors(
              jsonResponse(500, jsonError(`Server misconfigured: missing upstream API key for provider ${resolved.provider.id}`, "server_error")),
              corsHeaders,
            );
          }
          const inheritedCustomHeaders = parseUpstreamCustomHeaders(env);

          let lastResp: Response | null = null;
          for (let i = 0; i < upstreamCandidates.length; i++) {
            const upstream = upstreamCandidates[i];
            const responsesPath =
              (upstream.endpoints && typeof (upstream.endpoints as any).responsesPath === "string" && String((upstream.endpoints as any).responsesPath).trim()) ||
              (upstream.endpoints && typeof (upstream.endpoints as any).responses_path === "string" && String((upstream.endpoints as any).responses_path).trim()) ||
              "";

            const upstreamHeadersEnv =
              upstream.customHeader && Object.keys(upstream.customHeader).length
                ? JSON.stringify({ ...inheritedCustomHeaders, ...upstream.customHeader })
                : "";
            const env2: Env = {
              ...env,
              OPENAI_BASE_URL: joinUrls(upstream.baseURLs),
              OPENAI_API_KEY: upstream.apiKey,
              ...(upstreamHeadersEnv ? { RSP4COPILOT_UPSTREAM_HEADERS: upstreamHeadersEnv } : null),
              ...(responsesPath ? { RESP_RESPONSES_PATH: responsesPath } : null),
              ...(reasoningEffort ? { RESP_REASONING_EFFORT: reasoningEffort } : null),
            };

            const upstreamResp = await handleOpenAIResponsesUpstream({
              request,
              env: env2,
              reqJson: respReq,
              upstreamModel: resolved.model.upstreamModel,
              outModel: modelId,
              stream,
              token,
              debug,
              reqId,
              path,
              startedAt,
            });

            lastResp = upstreamResp;
            if (upstreamResp.ok) return withCors(upstreamResp, corsHeaders);
            if (!shouldTryNextUpstreamCandidateStatus(upstreamResp.status) || i === upstreamCandidates.length - 1) return withCors(upstreamResp, corsHeaders);
          }

          return withCors(lastResp || jsonResponse(502, jsonError("Upstream error", "bad_gateway")), corsHeaders);
        }

        const openaiReq = responsesRequestToOpenAIChat(respReq) as any;
        openaiReq.model = resolved.model.upstreamModel;
        openaiReq.stream = stream;

        const openaiResp = await dispatchOpenAIChatToProvider({
          request,
          env,
          config: gatewayCfg.config,
          provider: resolved.provider,
          model: resolved.model,
          reqJson: openaiReq,
          stream,
          token,
          debug,
          reqId,
          path,
          startedAt,
          extraSystemText: "",
        });
        if (!openaiResp.ok) return withCors(openaiResp, corsHeaders);

        if (stream) {
          const body = openAIChatSseToResponsesSse(openaiResp, modelId);
          return withCors(new Response(body, { status: 200, headers: sseHeaders() }), corsHeaders);
        }

        const openaiJson = await openaiResp.json().catch(() => null);
        if (!openaiJson || typeof openaiJson !== "object") return withCors(openaiResp, corsHeaders);
        return withCors(jsonResponse(200, openAIChatResponseToResponses(openaiJson, modelId)), corsHeaders);
      }

      // Claude Messages
      if (request.method === "POST" && path === "/claude/v1/messages") {
        if (!gatewayCfg.ok || !gatewayCfg.config) {
          return withCors(jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error")), corsHeaders);
        }

        const parsed = await readJsonBody(request);
        if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
          return withCors(jsonResponse(400, jsonError("Invalid JSON body")), corsHeaders);
        }
        const claudeReq = parsed.value as any;
        const providerHint = claudeReq.provider ?? claudeReq.owned_by ?? claudeReq.ownedBy ?? claudeReq.owner ?? claudeReq.vendor;
        const resolved = resolveModel(gatewayCfg.config, claudeReq.model, providerHint);
        if (resolved.ok === false) return withCors(jsonResponse(resolved.status, resolved.error), corsHeaders);

        const converted = claudeMessagesRequestToOpenaiChat(claudeReq);
        if (converted.ok === false) return withCors(jsonResponse(converted.status, converted.error), corsHeaders);

        const openaiReq = converted.req as any;
        openaiReq.model = resolved.model.upstreamModel;
        const stream = Boolean(openaiReq.stream);

        const openaiResp = await dispatchOpenAIChatToProvider({
          request,
          env,
          config: gatewayCfg.config,
          provider: resolved.provider,
          model: resolved.model,
          reqJson: openaiReq,
          stream,
          token,
          debug,
          reqId,
          path,
          startedAt,
          extraSystemText: "",
        });
        if (!openaiResp.ok) return withCors(openaiResp, corsHeaders);

        if (stream) {
          const transformed = await openaiStreamToClaudeMessagesSse(openaiResp, { reqModel: resolved.model.upstreamModel, debug, reqId });
          if (!transformed.ok) return withCors(jsonResponse(transformed.status, transformed.error), corsHeaders);
          return withCors(transformed.resp, corsHeaders);
        }

        const openaiJson = await openaiResp.json().catch(() => null);
        if (!openaiJson || typeof openaiJson !== "object") return withCors(openaiResp, corsHeaders);
        return withCors(jsonResponse(200, openaiChatResponseToClaudeMessage(openaiJson)), corsHeaders);
      }

      if (request.method === "POST" && path === "/claude/v1/messages/count_tokens") {
        if (!gatewayCfg.ok || !gatewayCfg.config) {
          return withCors(jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error")), corsHeaders);
        }
        const parsed = await readJsonBody(request);
        if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
          return withCors(jsonResponse(400, jsonError("Invalid JSON body")), corsHeaders);
        }
        const reqJson = parsed.value as any;
        const providerHint = reqJson.provider ?? reqJson.owned_by ?? reqJson.ownedBy ?? reqJson.owner ?? reqJson.vendor;
        const resolved = resolveModel(gatewayCfg.config, reqJson.model, providerHint);
        if (resolved.ok === false) return withCors(jsonResponse(resolved.status, resolved.error), corsHeaders);
        reqJson.model = resolved.model.upstreamModel;

        const providerApiMode = typeof resolved.provider.apiMode === "string" ? resolved.provider.apiMode.trim() : "";
        if (providerApiMode !== "claude") {
          return withCors(jsonResponse(400, jsonError("count_tokens requires a claude provider", "invalid_request_error")), corsHeaders);
        }

        const upstreamCandidates = listUpstreamCandidates({ env, provider: resolved.provider, request, reqId });
        if (!upstreamCandidates.length) {
          return withCors(
            jsonResponse(500, jsonError(`Server misconfigured: missing upstream API key for provider ${resolved.provider.id}`, "server_error")),
            corsHeaders,
          );
        }

        const inheritedCustomHeaders = parseUpstreamCustomHeaders(env);
        let lastResp: Response | null = null;
        for (let i = 0; i < upstreamCandidates.length; i++) {
          const upstream = upstreamCandidates[i];
          const messagesPath =
            upstream.endpoints && typeof (upstream.endpoints as any).messagesPath === "string" ? String((upstream.endpoints as any).messagesPath).trim() : "";
          const upstreamHeadersEnv =
            upstream.customHeader && Object.keys(upstream.customHeader).length
              ? JSON.stringify({ ...inheritedCustomHeaders, ...upstream.customHeader })
              : "";
          const env2: Env = {
            ...env,
            CLAUDE_BASE_URL: joinUrls(upstream.baseURLs),
            CLAUDE_API_KEY: upstream.apiKey,
            ...(upstreamHeadersEnv ? { RSP4COPILOT_UPSTREAM_HEADERS: upstreamHeadersEnv } : null),
            ...(messagesPath ? { CLAUDE_MESSAGES_PATH: messagesPath } : null),
          };

          const resp = await handleClaudeCountTokens({ request, env: env2, reqJson, debug, reqId });
          lastResp = resp;
          if (resp.ok) return withCors(resp, corsHeaders);
          if (!shouldTryNextUpstreamCandidateStatus(resp.status) || i === upstreamCandidates.length - 1) return withCors(resp, corsHeaders);
        }

        return withCors(lastResp || jsonResponse(502, jsonError("Upstream error", "bad_gateway")), corsHeaders);
      }

      // Gemini
      if (request.method === "POST" && path.startsWith("/gemini/v1beta/models/")) {
        if (!gatewayCfg.ok || !gatewayCfg.config) {
          return withCors(jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error")), corsHeaders);
        }
        const m = path.match(/^\/gemini\/v1beta\/models\/([^/]+):(generateContent|streamGenerateContent)$/);
        if (!m) return withCors(jsonResponse(404, jsonError("Not found", "not_found")), corsHeaders);

        const modelId = decodeURIComponent(m[1] || "");
        const methodName = m[2] || "generateContent";
        const stream = methodName === "streamGenerateContent";

        const providerHint = url.searchParams.get("provider") || url.searchParams.get("owned_by") || url.searchParams.get("ownedBy") || "";
        const resolved = resolveModel(gatewayCfg.config, modelId, providerHint);
        if (resolved.ok === false) return withCors(jsonResponse(resolved.status, resolved.error), corsHeaders);

        const parsed = await readJsonBody(request);
        if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
          return withCors(jsonResponse(400, jsonError("Invalid JSON body")), corsHeaders);
        }

        const providerApiMode = typeof resolved.provider.apiMode === "string" ? resolved.provider.apiMode.trim() : "";
        if (providerApiMode === "gemini") {
          const upstreamCandidates = listUpstreamCandidates({ env, provider: resolved.provider, request, reqId });
          if (!upstreamCandidates.length) {
            return withCors(
              jsonResponse(500, jsonError(`Server misconfigured: missing upstream API key for provider ${resolved.provider.id}`, "server_error")),
              corsHeaders,
            );
          }

          const inheritedCustomHeaders = parseUpstreamCustomHeaders(env);
          let lastResp: Response | null = null;
          for (let i = 0; i < upstreamCandidates.length; i++) {
            const upstream = upstreamCandidates[i];
            const upstreamHeadersEnv =
              upstream.customHeader && Object.keys(upstream.customHeader).length
                ? JSON.stringify({ ...inheritedCustomHeaders, ...upstream.customHeader })
                : "";
            const env2: Env = {
              ...env,
              GEMINI_BASE_URL: joinUrls(upstream.baseURLs),
              GEMINI_API_KEY: upstream.apiKey,
              ...(upstreamHeadersEnv ? { RSP4COPILOT_UPSTREAM_HEADERS: upstreamHeadersEnv } : null),
            };
            const upstreamResp = await handleGeminiGenerateContentUpstream({
              request,
              env: env2,
              reqJson: parsed.value,
              model: resolved.model.upstreamModel,
              stream,
              debug,
              reqId,
            });

            lastResp = upstreamResp;
            if (upstreamResp.ok) return withCors(upstreamResp, corsHeaders);
            if (!shouldTryNextUpstreamCandidateStatus(upstreamResp.status) || i === upstreamCandidates.length - 1) return withCors(upstreamResp, corsHeaders);
          }

          return withCors(lastResp || jsonResponse(502, jsonError("Upstream error", "bad_gateway")), corsHeaders);
        }

        const openaiReq = geminiRequestToOpenAIChat(parsed.value) as any;
        openaiReq.model = resolved.model.upstreamModel;
        openaiReq.stream = stream;

        const openaiResp = await dispatchOpenAIChatToProvider({
          request,
          env,
          config: gatewayCfg.config,
          provider: resolved.provider,
          model: resolved.model,
          reqJson: openaiReq,
          stream,
          token,
          debug,
          reqId,
          path,
          startedAt,
          extraSystemText: "",
        });
        if (!openaiResp.ok) return withCors(openaiResp, corsHeaders);

        if (stream) {
          const body = openAIChatSseToGeminiSse(openaiResp);
          return withCors(new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } }), corsHeaders);
        }

        const openaiJson = await openaiResp.json().catch(() => null);
        if (!openaiJson || typeof openaiJson !== "object") return withCors(openaiResp, corsHeaders);
        return withCors(jsonResponse(200, openAIChatResponseToGemini(openaiJson)), corsHeaders);
      }

      if (request.method !== "POST") return withCors(jsonResponse(404, jsonError("Not found", "not_found")), corsHeaders);
      return withCors(jsonResponse(404, jsonError("Not found", "not_found")), corsHeaders);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err ?? "unknown error");
      const stack = err instanceof Error ? err.stack : "";
      console.error(`[rsp4copilot][${reqId}] critical error: ${message}`, { stack });
      if (debug) logDebug(debug, reqId, "unhandled exception", { error: message, stack: previewString(stack, 2400) });
      return withCors(jsonResponse(500, jsonError(`Internal Server Error: ${message}`, "server_error")), corsHeaders);
    }
  },
};

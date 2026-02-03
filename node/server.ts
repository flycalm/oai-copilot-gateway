import { createServer } from "node:http";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";

import worker from "../src/workers";
import { getWorkerAuthKeys, normalizeAuthValue, parseBoolEnv } from "../src/common";
import { parseGatewayConfig } from "../src/config";

class FileKvNamespace {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = String(filePath || "").trim();
  }

  async get(_key: string): Promise<string | null> {
    try {
      if (!this.filePath) return null;
      if (!existsSync(this.filePath)) return null;
      const content = readFileSync(this.filePath, "utf8");
      return typeof content === "string" && content.trim() ? content : null;
    } catch {
      return null;
    }
  }

  async put(_key: string, value: string): Promise<void> {
    if (!this.filePath) return;
    const dir = dirname(this.filePath);
    const tmp = `${this.filePath}.${Date.now()}.tmp`;
    try {
      // Ensure directory exists (Docker default: /config is mounted)
      if (dir && !existsSync(dir)) {
        // no mkdir here; if missing, just fail silently
      }
      writeFileSync(tmp, String(value ?? ""), "utf8");
      renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        // Best-effort cleanup: overwrite target if rename fails on some FS.
        writeFileSync(this.filePath, String(value ?? ""), "utf8");
      } catch {}
      try {
        if (existsSync(tmp)) renameSync(tmp, tmp + ".failed");
      } catch {}
      const msg = err instanceof Error ? err.message : String(err ?? "write failed");
      console.error(`[rsp4copilot] stats persist failed (${this.filePath}): ${msg}`);
    }
  }
}

function statsPersistEnabled(): boolean {
  const raw = process.env.RSP4COPILOT_STATS_PERSIST;
  if (raw == null) return true;
  return parseBoolEnv(raw);
}

function getStatsFilePath(): string {
  const p = String(process.env.RSP4COPILOT_STATS_FILE || "").trim();
  return p || "/config/rsp4copilot.stats.json";
}

let statsKvSingleton: FileKvNamespace | null = null;
function getStatsKv(): FileKvNamespace {
  const filePath = getStatsFilePath();
  if (!statsKvSingleton || statsKvSingleton.filePath !== filePath) {
    statsKvSingleton = new FileKvNamespace(filePath);
  }
  return statsKvSingleton;
}

function normalizeRemoteAddress(raw: unknown): string {
  let ip = String(raw ?? "").trim();
  if (!ip) return "";
  if (ip.toLowerCase().startsWith("::ffff:")) ip = ip.slice(7);
  return ip;
}

function parseDotenv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = String(raw || "").split(/\r?\n/);
  for (const lineRaw of lines) {
    const line = String(lineRaw ?? "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    let s = trimmed;
    if (s.toLowerCase().startsWith("export ")) s = s.slice(7).trim();
    const idx = s.indexOf("=");
    if (idx <= 0) continue;

    const key = s.slice(0, idx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let val = s.slice(idx + 1).trim();
    if (!val) {
      out[key] = "";
      continue;
    }

    const q = val[0];
    if ((q === '"' || q === "'") && val.length >= 2 && val.endsWith(q)) {
      val = val.slice(1, -1);
      if (q === '"') {
        val = val
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      }
    }

    out[key] = val;
  }
  return out;
}

function escapeDotenvValue(value: string): string {
  const v = String(value ?? "");
  const escaped = v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

function serializeDotenv(map: Record<string, string>): string {
  const keys = Object.keys(map).sort((a, b) => a.localeCompare(b));
  const lines: string[] = [];
  for (const k of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    lines.push(`${k}=${escapeDotenvValue(String(map[k] ?? ""))}`);
  }
  return lines.join("\n") + "\n";
}

function decodeBase64ToString(value: string): string | null {
  const v = String(value || "").trim();
  if (!v) return null;
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

function getWebUiBasicCreds(): { user: string; pass: string } | null {
  const user = normalizeAuthValue(process.env.WEB_UI_BASIC_USER);
  const pass = normalizeAuthValue(process.env.WEB_UI_BASIC_PASS);
  if (!user || !pass) return null;
  return { user, pass };
}

function requireWebUiBasicAuth(req: any): Response | null {
  if (!parseBoolEnv(process.env.WEB_UI_ENABLED)) {
    return jsonResp(404, { error: { message: "Not found", code: "not_found", type: "not_found_error" } });
  }
  const creds = getWebUiBasicCreds();
  if (!creds) {
    return jsonResp(500, { error: { message: "Missing WEB_UI_BASIC_USER/WEB_UI_BASIC_PASS", code: "server_error", type: "server_error" } });
  }
  const parsed = parseBasicAuth((req.headers.authorization as string | undefined) || null);
  if (!parsed || parsed.user !== creds.user || parsed.pass !== creds.pass) return unauthorizedBasic();
  return null;
}

function unauthorizedBasic(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "www-authenticate": 'Basic realm="oai-copilot-gateway"',
      "x-content-type-options": "nosniff",
    },
  });
}

function jsonResp(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function maskSecretValue(v: string): string {
  const s = String(v || "");
  if (!s) return "";
  const tail = s.length <= 6 ? s : s.slice(-6);
  return `***${tail}`;
}

function getEnvFilePath(): string {
  const p = String(process.env.RSP4COPILOT_ENV_FILE || "").trim();
  return p || "/config/rsp4copilot.env";
}

function listTruthyEnvKeysFromConfig(parsedCfg: any): string[] {
  const out: string[] = [];
  const cfg = parsedCfg && parsedCfg.ok && parsedCfg.config ? parsedCfg.config : null;
  const providers = cfg && cfg.providers && typeof cfg.providers === "object" ? cfg.providers : null;
  if (!providers) return out;

  for (const p of Object.values(providers)) {
    if (!p || typeof p !== "object") continue;
    const ups = Array.isArray((p as any).upstreams) ? (p as any).upstreams : [];
    if (ups.length) {
      for (const u of ups) {
        const uEnv = typeof u?.apiKeyEnv === "string" ? String(u.apiKeyEnv).trim() : "";
        if (uEnv) out.push(uEnv);
      }
    } else {
      const apiKeyEnv = typeof (p as any).apiKeyEnv === "string" ? String((p as any).apiKeyEnv).trim() : "";
      if (apiKeyEnv) out.push(apiKeyEnv);
    }
  }

  return Array.from(new Set(out)).filter(Boolean);
}

function listUpstreamKeyRefs(parsedCfg: any): {
  providerId: string;
  kind: "provider" | "upstream";
  envVar: string;
  upstreamId?: string;
}[] {
  const out: { providerId: string; kind: "provider" | "upstream"; envVar: string; upstreamId?: string }[] = [];
  const cfg = parsedCfg && parsedCfg.ok && parsedCfg.config ? parsedCfg.config : null;
  const providers = cfg && cfg.providers && typeof cfg.providers === "object" ? cfg.providers : null;
  if (!providers) return out;

  for (const [providerId, p] of Object.entries(providers)) {
    if (!p || typeof p !== "object") continue;
    const ups = Array.isArray((p as any).upstreams) ? (p as any).upstreams : [];
    if (ups.length) {
      for (const u of ups) {
        const envVar = typeof u?.apiKeyEnv === "string" ? String(u.apiKeyEnv).trim() : "";
        if (!envVar) continue;
        const upstreamId = typeof u?.id === "string" ? String(u.id).trim() : "";
        out.push({ providerId, kind: "upstream", envVar, upstreamId: upstreamId || undefined });
      }
      continue;
    }
    const envVar = typeof (p as any).apiKeyEnv === "string" ? String((p as any).apiKeyEnv).trim() : "";
    if (envVar) out.push({ providerId, kind: "provider", envVar });
  }

  const uniq = new Map<string, (typeof out)[number]>();
  for (const it of out) {
    const key = `${it.providerId}::${it.kind}::${it.upstreamId || ""}::${it.envVar}`;
    if (!uniq.has(key)) uniq.set(key, it);
  }
  return Array.from(uniq.values());
}

function getSecretsPayload(env: Record<string, string | undefined>): {
  mode: "masked" | "full";
  downstream: { keys: string[]; count: number };
  upstream: { referencedEnvVars: { name: string; value: string; present: boolean }[]; inlineConfigKeys: { path: string; value: string }[] };
  warnings: string[];
} {
  const reveal = parseBoolEnv(process.env.WEB_UI_SECRETS_REVEAL);
  const mode: "masked" | "full" = reveal ? "full" : "masked";
  const warnings: string[] = [];

  const downstreamKeys = getWorkerAuthKeys(env as any);
  const downstream = {
    keys: downstreamKeys.map((k) => (mode === "full" ? k : maskSecretValue(k))),
    count: downstreamKeys.length,
  };

  const parsedCfg = parseGatewayConfig(env as any);
  if (!parsedCfg.ok) {
    warnings.push(`Config invalid/missing: ${(parsedCfg as any).error || "unknown error"}`);
  }

  const referencedEnvVarNames = listTruthyEnvKeysFromConfig(parsedCfg);
  const referencedEnvVars = referencedEnvVarNames.map((name) => {
    const raw = normalizeAuthValue((env as any)[name] ?? (process.env as any)[name]);
    const present = Boolean(raw);
    const value = mode === "full" ? raw : raw ? maskSecretValue(raw) : "";
    return { name, value, present };
  });

  const inlineConfigKeys: { path: string; value: string }[] = [];
  if (parsedCfg.ok && parsedCfg.config) {
    for (const [pid, p] of Object.entries(parsedCfg.config.providers || {})) {
      const pk = normalizeAuthValue((p as any).apiKey);
      if (pk) inlineConfigKeys.push({ path: `providers.${pid}.apiKey`, value: mode === "full" ? pk : maskSecretValue(pk) });
      const ups = Array.isArray((p as any).upstreams) ? (p as any).upstreams : [];
      for (let i = 0; i < ups.length; i++) {
        const u = ups[i];
        const uk = normalizeAuthValue(u?.apiKey);
        if (uk) inlineConfigKeys.push({ path: `providers.${pid}.upstreams[${i}].apiKey`, value: mode === "full" ? uk : maskSecretValue(uk) });
      }
    }
    if (inlineConfigKeys.length) warnings.push("Config contains inline apiKey values; prefer apiKeyEnv when possible.");
  }

  return { mode, downstream, upstream: { referencedEnvVars, inlineConfigKeys }, warnings };
}

function isOriginAllowed(origin: string, hostHeader: string): boolean {
  const o = String(origin || "").trim();
  const h = String(hostHeader || "").trim();
  if (!o || !h) return false;
  try {
    const u = new URL(o);
    return u.host === h;
  } catch {
    return false;
  }
}

function buildEnv(): Record<string, any> {
  const env: Record<string, any> = {};
  for (const [k, v] of Object.entries(process.env)) env[k] = v;

  // Optional overlay env file (for web-managed upstream keys in Docker).
  const envFile = getEnvFilePath();
  try {
    if (envFile && existsSync(envFile)) {
      const overlay = parseDotenv(readFileSync(envFile, "utf8"));
      for (const [k, v] of Object.entries(overlay)) env[k] = v;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? "read failed");
    console.error(`[rsp4copilot] failed to read RSP4COPILOT_ENV_FILE (${envFile}): ${message}`);
  }

  if (!env.RSP4COPILOT_CONFIG) {
    const file = env.RSP4COPILOT_CONFIG_FILE;
    if (file) {
      try {
        env.RSP4COPILOT_CONFIG = readFileSync(file, "utf8");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err ?? "read failed");
        console.error(`[rsp4copilot] failed to read RSP4COPILOT_CONFIG_FILE (${file}): ${message}`);
      }
    }
  }

  // Stats persistence (Node/Docker): provide a KV-like binding backed by a local file.
  // Worker side will use env.RSP4COPILOT_STATS_KV if present.
  if (statsPersistEnabled()) {
    env.RSP4COPILOT_STATS_KV = getStatsKv();
  }

  return env;
}

function toHeaders(nodeHeaders: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeHeaders)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const it of v) headers.append(k, it);
    } else {
      headers.set(k, v);
    }
  }
  return headers;
}

async function readBody(req: any): Promise<Uint8Array | undefined> {
  const method = String(req?.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", resolve);
    req.on("error", reject);
  });
  if (!chunks.length) return undefined;
  return Buffer.concat(chunks);
}

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || "8788");

function getConfigFilePath(): string {
  const p = String(process.env.RSP4COPILOT_CONFIG_FILE || "").trim();
  return p || "/config/rsp4copilot.config.jsonc";
}

function mayWriteConfigFile(): boolean {
  return parseBoolEnv(process.env.WEB_UI_CONFIG_WRITE);
}

function mayWriteSecrets(): boolean {
  return parseBoolEnv(process.env.WEB_UI_SECRETS_WRITE);
}

function pickGatewayAuthKey(env: Record<string, any>): string {
  const keys = getWorkerAuthKeys(env as any);
  return keys.length ? keys[0] : "";
}

function isSafeGatewayPath(path: string): boolean {
  const p = String(path || "").trim();
  if (!p.startsWith("/")) return false;
  if (p.startsWith("//")) return false;
  if (p.includes("://")) return false;
  if (p.includes("\n") || p.includes("\r")) return false;
  if (p === "/" || p === "/ui" || p === "/ui/" || p.startsWith("/ui/api/")) return false;
  if (p.startsWith("/admin/")) return false;
  return true;
}

function isOaiCopilotUserAgent(ua: unknown): boolean {
  const s = String(ua ?? "");
  return s.toLowerCase().includes("oai-compatible-copilot/");
}

function isCopilotStreamingEndpoint(url: URL, method: unknown): boolean {
  const m = String(method ?? "").toUpperCase();
  if (m !== "POST") return false;
  const p = url.pathname;
  return p === "/chat/completions" || p === "/v1/chat/completions" || p === "/responses" || p === "/v1/responses" || p === "/openai/v1/responses";
}

function wantsEventStream(acceptHeader: unknown): boolean {
  const a = String(acceptHeader ?? "");
  return a.toLowerCase().includes("text/event-stream");
}

const server = createServer(async (req, res) => {
  try {
    const proto = (req.headers["x-forwarded-proto"] as string | undefined) || "http";
    const hostHeader = (req.headers.host as string | undefined) || `${host}:${port}`;
    const url = new URL(req.url || "/", `${proto}://${hostHeader}`);

    // Web UI proxy APIs: browser calls these without the gateway API key;
    // server injects WORKER_AUTH_KEY to talk to the gateway.
    if (url.pathname === "/ui/api/health" || url.pathname === "/ui/api/models" || url.pathname === "/ui/api/proxy") {
      const authErr = requireWebUiBasicAuth(req);
      if (authErr) {
        res.statusCode = authErr.status;
        for (const [k, v] of authErr.headers.entries()) res.setHeader(k, v);
        return res.end(await authErr.text());
      }

      const env = buildEnv();
      const gatewayKey = pickGatewayAuthKey(env);
      if (!gatewayKey) {
        const resp = jsonResp(500, { error: { message: "Missing WORKER_AUTH_KEY/WORKER_AUTH_KEYS", code: "server_error", type: "server_error" } });
        res.statusCode = resp.status;
        for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
        return res.end(await resp.text());
      }

      let targetPath = "";
      if (url.pathname === "/ui/api/health") targetPath = "/v1/health";
      else if (url.pathname === "/ui/api/models") targetPath = "/v1/models";
      else {
        targetPath = String(url.searchParams.get("path") || "").trim();
      }

      if (!isSafeGatewayPath(targetPath)) {
        const resp = jsonResp(400, { error: { message: "Invalid path", code: "bad_request", type: "invalid_request_error" } });
        res.statusCode = resp.status;
        for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
        return res.end(await resp.text());
      }

      const body = await readBody(req);
      const clientIp = normalizeRemoteAddress(req.socket?.remoteAddress);

      const headersObj: Record<string, string | string[] | undefined> = { ...req.headers };
      // Remove any client-supplied auth; enforce gateway auth key.
      delete (headersObj as any)["authorization"];
      delete (headersObj as any)["x-api-key"];
      delete (headersObj as any)["x-goog-api-key"];
      delete (headersObj as any)["anthropic-api-key"];
      delete (headersObj as any)["x-anthropic-api-key"];
      delete (headersObj as any)["host"];
      delete (headersObj as any)["content-length"];
      headersObj["authorization"] = `Bearer ${gatewayKey}`;
      headersObj["x-rsp4copilot-ui"] = "1";
      if (clientIp) headersObj["x-rsp4copilot-client-ip"] = clientIp;

      const targetUrl = new URL(targetPath, `${proto}://${hostHeader}`);
      const request = new Request(targetUrl.toString(), {
        method: req.method || "GET",
        headers: toHeaders(headersObj),
        body,
      });

      const resp = await worker.fetch(request, env as any);
      res.statusCode = resp.status || 200;
      for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
      if (!resp.body) return res.end();
      return Readable.fromWeb(resp.body as any).pipe(res);
    }

    // Admin API: config read/write for Docker (Node runtime).
    // Protected by the same Basic Auth as Web UI.
    if (url.pathname === "/admin/api/config") {
      const authErr = requireWebUiBasicAuth(req);
      if (authErr) {
        res.statusCode = authErr.status;
        for (const [k, v] of authErr.headers.entries()) res.setHeader(k, v);
        return res.end(await authErr.text());
      }

      const configPath = getConfigFilePath();
      const writeEnabled = mayWriteConfigFile();
      const method = String(req.method || "GET").toUpperCase();

      if (method === "GET") {
        const exists = existsSync(configPath);
        const content = exists ? readFileSync(configPath, "utf8") : "";
        const parsedCfg = content ? parseGatewayConfig({ RSP4COPILOT_CONFIG: content } as any) : { ok: false, error: "Missing config file" };
        const resp = jsonResp(200, {
          ok: true,
          configPath,
          exists,
          writeEnabled,
          content,
          parsed: parsedCfg.ok ? { ok: true } : { ok: false, error: (parsedCfg as any).error || "Invalid config" },
          config: parsedCfg && (parsedCfg as any).ok ? (parsedCfg as any).config : null,
        });
        res.statusCode = resp.status;
        for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
        return res.end(await resp.text());
      }

      if (method === "PUT") {
        if (!writeEnabled) {
          const resp = jsonResp(403, { error: { message: "Config write disabled (set WEB_UI_CONFIG_WRITE=true)", code: "forbidden", type: "invalid_request_error" } });
          res.statusCode = resp.status;
          for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
          return res.end(await resp.text());
        }
        // CSRF guard: require same-origin for browser writes.
        const origin = String(req.headers.origin || "");
        if (!isOriginAllowed(origin, hostHeader)) {
          const resp = jsonResp(403, { error: { message: "Forbidden (bad origin)", code: "forbidden", type: "invalid_request_error" } });
          res.statusCode = resp.status;
          for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
          return res.end(await resp.text());
        }

        const bodyBytes = await readBody(req);
        const bodyText = bodyBytes ? Buffer.from(bodyBytes).toString("utf8") : "";
        let payload: any = null;
        try {
          payload = bodyText ? JSON.parse(bodyText) : null;
        } catch {
          payload = null;
        }
        const content = typeof payload?.content === "string" ? payload.content : "";
        if (!content.trim()) {
          const resp = jsonResp(400, { error: { message: "Missing field: content", code: "bad_request", type: "invalid_request_error" } });
          res.statusCode = resp.status;
          for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
          return res.end(await resp.text());
        }
        if (content.length > 1024 * 1024) {
          const resp = jsonResp(413, { error: { message: "Config too large", code: "bad_request", type: "invalid_request_error" } });
          res.statusCode = resp.status;
          for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
          return res.end(await resp.text());
        }

        const validated = parseGatewayConfig({ RSP4COPILOT_CONFIG: content } as any);
        if (!validated.ok) {
          const resp = jsonResp(400, { error: { message: (validated as any).error || "Invalid config", code: "bad_request", type: "invalid_request_error" } });
          res.statusCode = resp.status;
          for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
          return res.end(await resp.text());
        }

        // Safety: only allow writing under /config by default.
        if (!configPath.startsWith("/config/")) {
          const resp = jsonResp(403, { error: { message: "Refusing to write config outside /config", code: "forbidden", type: "invalid_request_error" } });
          res.statusCode = resp.status;
          for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
          return res.end(await resp.text());
        }

        // Atomic-ish write: write temp then rename.
        const tmp = `${configPath}.tmp.${process.pid}.${Date.now()}`;
        try {
          // Ensure directory exists (bind mount should provide it).
          const dir = dirname(configPath);
          if (!existsSync(dir)) {
            const resp = jsonResp(500, { error: { message: `Config dir missing: ${dir}`, code: "server_error", type: "server_error" } });
            res.statusCode = resp.status;
            for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
            return res.end(await resp.text());
          }
          writeFileSync(tmp, content, "utf8");
          renameSync(tmp, configPath);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err ?? "write failed");
          const resp = jsonResp(500, { error: { message: `Write failed: ${message}`, code: "server_error", type: "server_error" } });
          res.statusCode = resp.status;
          for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
          return res.end(await resp.text());
        }

        const resp = jsonResp(200, { ok: true });
        res.statusCode = resp.status;
        for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
        return res.end(await resp.text());
      }

      const resp = jsonResp(405, { error: { message: "Method not allowed", code: "invalid_request_error", type: "invalid_request_error" } });
      res.statusCode = resp.status;
      for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
      return res.end(await resp.text());
    }

    // Admin API: view secrets (dangerous; disabled by default).
    if (url.pathname === "/admin/api/secrets") {
      if (!parseBoolEnv(process.env.WEB_UI_SECRETS_VIEW)) {
        const resp = jsonResp(404, { error: { message: "Not found", code: "not_found", type: "not_found_error" } });
        res.statusCode = resp.status;
        for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
        return res.end(await resp.text());
      }
      const authErr = requireWebUiBasicAuth(req);
      if (authErr) {
        res.statusCode = authErr.status;
        for (const [k, v] of authErr.headers.entries()) res.setHeader(k, v);
        return res.end(await authErr.text());
      }

      // If client requests reveal=1, only allow full secrets when WEB_UI_SECRETS_REVEAL=true.
      const wantReveal = url.searchParams.get("reveal") === "1";
      const allowReveal = parseBoolEnv(process.env.WEB_UI_SECRETS_REVEAL);
      if (wantReveal && !allowReveal) {
        const env = buildEnv();
        const payload = getSecretsPayload(env);
        const resp = jsonResp(200, { ok: true, allowReveal: false, ...payload });
        res.statusCode = resp.status;
        for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
        return res.end(await resp.text());
      }

      const env = buildEnv();
      const payload = getSecretsPayload(env);
      const resp = jsonResp(200, { ok: true, allowReveal, ...payload });
      res.statusCode = resp.status;
      for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
      return res.end(await resp.text());
    }

    // Admin API: update upstream keys referenced by apiKeyEnv.
    if (url.pathname === "/admin/api/upstream_keys") {
      if (!parseBoolEnv(process.env.WEB_UI_SECRETS_VIEW)) {
        const resp = jsonResp(404, { error: { message: "Not found", code: "not_found", type: "not_found_error" } });
        res.statusCode = resp.status;
        for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
        return res.end(await resp.text());
      }
      const authErr = requireWebUiBasicAuth(req);
      if (authErr) {
        res.statusCode = authErr.status;
        for (const [k, v] of authErr.headers.entries()) res.setHeader(k, v);
        return res.end(await authErr.text());
      }

      const env = buildEnv();
      const cfgParsed = parseGatewayConfig(env as any);
      if (!cfgParsed.ok) {
        const resp = jsonResp(400, { error: { message: (cfgParsed as any).error || "Invalid config", code: "bad_request", type: "invalid_request_error" } });
        res.statusCode = resp.status;
        for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
        return res.end(await resp.text());
      }
      const allowedNames = listTruthyEnvKeysFromConfig(cfgParsed).filter(Boolean);
      const refs = listUpstreamKeyRefs(cfgParsed);

      const method = String(req.method || "GET").toUpperCase();
      const envFile = getEnvFilePath();
      const writeEnabled = mayWriteSecrets();

      if (method === "GET") {
        const reveal = parseBoolEnv(process.env.WEB_UI_SECRETS_REVEAL) && url.searchParams.get("reveal") === "1";
        const allowAddNew = parseBoolEnv(process.env.WEB_UI_SECRETS_ADD_NEW);
        const byName: Record<string, { name: string; present: boolean; value: string }> = {};
        for (const name of allowedNames) {
          const raw = normalizeAuthValue((env as any)[name] ?? (process.env as any)[name]);
          const present = Boolean(raw);
          const value = reveal ? raw : raw ? maskSecretValue(raw) : "";
          byName[name] = { name, present, value };
        }

        const providerMap: Record<string, { providerId: string; items: any[] }> = {};
        for (const ref of refs) {
          if (!providerMap[ref.providerId]) providerMap[ref.providerId] = { providerId: ref.providerId, items: [] };
          const info = byName[ref.envVar] || { name: ref.envVar, present: false, value: "" };
          providerMap[ref.providerId].items.push({
            providerId: ref.providerId,
            kind: ref.kind,
            upstreamId: ref.upstreamId || "",
            envVar: ref.envVar,
            present: info.present,
            value: info.value,
          });
        }
        const providers = Object.values(providerMap)
          .map((p) => ({
            providerId: p.providerId,
            items: p.items.sort((a, b) => `${a.kind}:${a.upstreamId}:${a.envVar}`.localeCompare(`${b.kind}:${b.upstreamId}:${b.envVar}`)),
          }))
          .sort((a, b) => a.providerId.localeCompare(b.providerId));

        // 查找所有已存在但不在配置中的环境变量
        const otherEnvVars: Array<{ name: string; present: boolean; value: string }> = [];
        if (allowAddNew) {
          const parsedFile = existsSync(envFile) ? parseDotenv(readFileSync(envFile, "utf8")) : {};
          const allowedSet = new Set(allowedNames);
          for (const [key, value] of Object.entries(parsedFile)) {
            if (allowedSet.has(key)) continue;
            const raw = normalizeAuthValue(value);
            const present = Boolean(raw);
            const maskedValue = reveal ? raw : raw ? maskSecretValue(raw) : "";
            otherEnvVars.push({ name: key, present, value: maskedValue });
          }
          otherEnvVars.sort((a, b) => a.name.localeCompare(b.name));
        }

        const resp = jsonResp(200, {
          ok: true,
          envFile,
          writeEnabled,
          allowReveal: parseBoolEnv(process.env.WEB_UI_SECRETS_REVEAL),
          allowAddNew,
          mode: reveal ? "full" : "masked",
          providers,
          otherEnvVars,
        });
        res.statusCode = resp.status;
        for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
        return res.end(await resp.text());
      }

      if (method === "PUT") {
        if (!writeEnabled) {
          const resp = jsonResp(403, { error: { message: "Upstream key write disabled (set WEB_UI_SECRETS_WRITE=true)", code: "forbidden", type: "invalid_request_error" } });
          res.statusCode = resp.status;
          for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
          return res.end(await resp.text());
        }

        const origin = String(req.headers.origin || "");
        if (!isOriginAllowed(origin, hostHeader)) {
          const resp = jsonResp(403, { error: { message: "Forbidden (bad origin)", code: "forbidden", type: "invalid_request_error" } });
          res.statusCode = resp.status;
          for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
          return res.end(await resp.text());
        }

        const bodyBytes = await readBody(req);
        const bodyText = bodyBytes ? Buffer.from(bodyBytes).toString("utf8") : "";
        let payload: any = null;
        try {
          payload = bodyText ? JSON.parse(bodyText) : null;
        } catch {
          payload = null;
        }
        const updates = (payload && typeof payload === "object" && (payload.updates || payload.values || payload.keys)) || payload;
        const mapIn = updates && typeof updates === "object" && !Array.isArray(updates) ? updates : null;
        if (!mapIn) {
          const resp = jsonResp(400, { error: { message: "Body must be an object like { updates: { VAR: \"value\" } }", code: "bad_request", type: "invalid_request_error" } });
          res.statusCode = resp.status;
          for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
          return res.end(await resp.text());
        }

        const allowedSet = new Set(allowedNames);
        const parsedFile = existsSync(envFile) ? parseDotenv(readFileSync(envFile, "utf8")) : {};
        const changed: string[] = [];
        const allowAddNew = parseBoolEnv(process.env.WEB_UI_SECRETS_ADD_NEW);

        for (const [nameRaw, valueRaw] of Object.entries(mapIn)) {
          const name = String(nameRaw || "").trim();
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
          // 如果不允许添加新的，则跳过不在允许列表中的变量
          if (!allowAddNew && !allowedSet.has(name)) continue;
          const value = normalizeAuthValue(valueRaw);
          if (!value) continue;
          parsedFile[name] = value;
          changed.push(name);
        }

        if (!changed.length) {
          const resp = jsonResp(400, { error: { message: "No valid upstream keys to update (check apiKeyEnv names and non-empty values).", code: "bad_request", type: "invalid_request_error" } });
          res.statusCode = resp.status;
          for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
          return res.end(await resp.text());
        }

        if (!envFile.startsWith("/config/")) {
          const resp = jsonResp(403, { error: { message: "Refusing to write env file outside /config", code: "forbidden", type: "invalid_request_error" } });
          res.statusCode = resp.status;
          for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
          return res.end(await resp.text());
        }

        const tmp = `${envFile}.tmp.${process.pid}.${Date.now()}`;
        try {
          writeFileSync(tmp, serializeDotenv(parsedFile), "utf8");
          renameSync(tmp, envFile);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err ?? "write failed");
          const resp = jsonResp(500, { error: { message: `Write failed: ${message}`, code: "server_error", type: "server_error" } });
          res.statusCode = resp.status;
          for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
          return res.end(await resp.text());
        }

        const resp = jsonResp(200, { ok: true, envFile, updated: Array.from(new Set(changed)).sort((a, b) => a.localeCompare(b)) });
        res.statusCode = resp.status;
        for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
        return res.end(await resp.text());
      }

      const resp = jsonResp(405, { error: { message: "Method not allowed", code: "invalid_request_error", type: "invalid_request_error" } });
      res.statusCode = resp.status;
      for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
      return res.end(await resp.text());
    }

    // VS Code Copilot (via oai-compatible-copilot) can surface a generic `fetch failed` if it
    // doesn't receive any response bytes quickly enough. To make streaming robust (especially
    // when upstream TTFB is slow), we flush an SSE response immediately and then pipe the
    // worker's streaming body when it becomes available.
    //
    // This behavior is intentionally gated by user-agent + endpoint + Accept header so it
    // doesn't affect other clients.
    const shouldEarlySse =
      isOaiCopilotUserAgent(req.headers["user-agent"]) &&
      isCopilotStreamingEndpoint(url, req.method) &&
      wantsEventStream(req.headers.accept);

    if (shouldEarlySse) {
      const body = await readBody(req);
      const clientIp = normalizeRemoteAddress(req.socket?.remoteAddress);
      const headersObj: Record<string, string | string[] | undefined> = { ...req.headers };
      if (clientIp) headersObj["x-rsp4copilot-client-ip"] = clientIp;

      const request = new Request(url.toString(), {
        method: req.method || "GET",
        headers: toHeaders(headersObj),
        body,
      });

      const env = buildEnv();
      const workerFetchPromise = worker.fetch(request, env as any);

      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("connection", "keep-alive");
      res.setHeader("x-rsp4copilot-early-sse", "1");
      (res as any).flushHeaders?.();
      res.write(": rsp4copilot\n\n");

      void (async () => {
        try {
          const resp = await workerFetchPromise;
          if (resp.ok && resp.body) {
            Readable.fromWeb(resp.body as any).pipe(res);
            return;
          }

          const txt = await resp.text().catch(() => "");
          const err = {
            error: {
              message: txt || `Upstream error (status=${resp.status || 500})`,
              type: "server_error",
              code: "bad_gateway",
            },
          };
          res.write(`data: ${JSON.stringify(err)}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err ?? "unknown error");
          const payload = { error: { message, type: "server_error", code: "server_error" } };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }
      })();

      return;
    }

    const body = await readBody(req);
    const clientIp = normalizeRemoteAddress(req.socket?.remoteAddress);
    const headersObj: Record<string, string | string[] | undefined> = { ...req.headers };
    if (clientIp) headersObj["x-rsp4copilot-client-ip"] = clientIp;
    const request = new Request(url.toString(), {
      method: req.method || "GET",
      headers: toHeaders(headersObj),
      body,
    });

    const env = buildEnv();
    const resp = await worker.fetch(request, env as any);

    res.statusCode = resp.status || 200;
    for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);

    if (!resp.body) return res.end();
      Readable.fromWeb(resp.body as any).pipe(res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? "unknown error");
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: { message, type: "server_error", code: "server_error" } }));
  }
});

server.listen(port, host, () => {
  console.log(`[rsp4copilot] listening on ${host}:${port}`);
});

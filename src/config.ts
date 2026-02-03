import type { Env } from "./common";
import { normalizeAuthValue, normalizeBaseUrl } from "./common";
import { parseJsonc } from "./jsonc";

export interface ModelConfig {
  name: string;
  upstreamModel: string;
  options: Record<string, unknown>;
  quirks: Record<string, unknown>;
}

export interface ProviderUpstreamConfig {
  id: string;
  baseURLs: string[];
  apiKeyEnv: string;
  apiKey: string;
  weight: number;
  customHeader: Record<string, string>;
  options: Record<string, unknown>;
  endpoints: Record<string, unknown>;
  quirks: Record<string, unknown>;
}

export interface ProviderConfig {
  id: string;
  apiMode: string;
  ownedBy: string;
  baseURLs: string[];
  apiKeyEnv: string;
  apiKey: string;
  routing: Record<string, unknown>;
  upstreams: ProviderUpstreamConfig[];
  customHeader: Record<string, string>;
  options: Record<string, unknown>;
  endpoints: Record<string, unknown>;
  quirks: Record<string, unknown>;
  discoverModels?: boolean;
  discoverModelsTtlSeconds?: number;
  models: Record<string, ModelConfig>;
}

export interface GatewayConfig {
  version: 1;
  providers: Record<string, ProviderConfig>;
}

function normalizeStringArrayOrString(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v ?? "").trim()).filter(Boolean);
  const s = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return s ? [s] : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeCustomHeader(raw: unknown): Record<string, string> {
  const obj = isPlainObject(raw) ? raw : {};
  const out: Record<string, string> = {};
  for (const [k0, v0] of Object.entries(obj)) {
    const key = String(k0 ?? "")
      .trim()
      .toLowerCase();
    if (!key) continue;
    if (v0 == null) continue;
    const value = String(v0).trim();
    if (!value) continue;
    out[key] = value;
  }
  return out;
}

function normalizeProviderApiMode(raw: unknown): string {
  const v0 = typeof raw === "string" ? raw.trim() : "";
  if (!v0) return "";

  const v = v0.toLowerCase();
  if (v === "openai") return "openai-chat-completions";
  if (v === "openai-chat") return "openai-chat-completions";
  if (v === "openai-chat-completions") return "openai-chat-completions";
  if (v === "openai-responses") return "openai-responses";
  if (v === "anthropic") return "claude";
  if (v === "claude") return "claude";
  if (v === "gemini") return "gemini";

  return v0;
}

function normalizeBoolLike(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return Number.isFinite(raw) && raw !== 0;
  const v0 = typeof raw === "string" ? raw.trim() : "";
  if (!v0) return false;
  const v = v0.toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "y" || v === "on";
}

function normalizeDiscoverModelsTtlSeconds(raw: unknown): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(String(raw ?? ""));
  if (!Number.isFinite(n)) return undefined;
  if (n <= 0) return undefined;
  return Math.min(24 * 3600, Math.floor(n));
}

function inferProviderOwnedBy(apiMode: string, providerId: string): string {
  const t = typeof apiMode === "string" ? apiMode.trim().toLowerCase() : "";
  if (!t) return providerId;
  if (t.startsWith("openai")) return "openai";
  if (t === "claude") return "anthropic";
  if (t === "gemini") return "google";
  return providerId;
}

function normalizeWeight(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? ""));
  if (!Number.isFinite(n)) return 1;
  if (n <= 0) return 1;
  return n;
}

function normalizeProviderUpstreamConfig(providerId: string, idx: number, raw: unknown): ProviderUpstreamConfig {
  const obj = isPlainObject(raw) ? raw : {};
  const id0 = typeof (obj as any).id === "string" ? String((obj as any).id).trim() : "";
  const id = id0 || `${providerId}#${idx + 1}`;
  const baseURLs = normalizeStringArrayOrString((obj as any).baseURL ?? (obj as any).baseUrl ?? (obj as any).url);
  const apiKeyEnv = typeof (obj as any).apiKeyEnv === "string" ? String((obj as any).apiKeyEnv).trim() : "";
  const apiKey = typeof (obj as any).apiKey === "string" ? String((obj as any).apiKey).trim() : "";
  const weight = normalizeWeight((obj as any).weight ?? (obj as any).w);

  const customHeader = normalizeCustomHeader(
    (obj as any).customHeader ?? (obj as any).customHeaders ?? (obj as any).custom_headers ?? (obj as any).headers,
  );
  const options = isPlainObject((obj as any).options) ? ((obj as any).options as Record<string, unknown>) : {};
  const endpoints = isPlainObject((obj as any).endpoints) ? ((obj as any).endpoints as Record<string, unknown>) : {};
  const quirks = isPlainObject((obj as any).quirks) ? ((obj as any).quirks as Record<string, unknown>) : {};

  return { id, baseURLs, apiKeyEnv, apiKey, weight, customHeader, options, endpoints, quirks };
}

function normalizeProviderConfig(id: string, raw: unknown): ProviderConfig {
  const obj = isPlainObject(raw) ? raw : {};

  const apiModeRaw =
    (typeof (obj as any).apiMode === "string" && String((obj as any).apiMode).trim()) ||
    (typeof (obj as any).api_mode === "string" && String((obj as any).api_mode).trim()) ||
    "";
  const typeRaw = typeof (obj as any).type === "string" ? String((obj as any).type).trim() : "";
  const apiMode = normalizeProviderApiMode(apiModeRaw || typeRaw);
  const ownedBy =
    (typeof (obj as any).ownedBy === "string" && String((obj as any).ownedBy).trim()) ||
    (typeof (obj as any).owned_by === "string" && String((obj as any).owned_by).trim()) ||
    (typeof (obj as any).provider === "string" && String((obj as any).provider).trim()) ||
    "";
  const baseURLs = normalizeStringArrayOrString((obj as any).baseURL ?? (obj as any).baseUrl ?? (obj as any).url);
  const apiKeyEnv = typeof (obj as any).apiKeyEnv === "string" ? String((obj as any).apiKeyEnv).trim() : "";
  const apiKey = typeof (obj as any).apiKey === "string" ? String((obj as any).apiKey).trim() : "";

  const routing = isPlainObject((obj as any).routing) ? ((obj as any).routing as Record<string, unknown>) : {};
  const upstreamsRaw = Array.isArray((obj as any).upstreams) ? ((obj as any).upstreams as unknown[]) : [];
  const upstreams = upstreamsRaw.map((u, i) => normalizeProviderUpstreamConfig(id, i, u));

  const customHeader = normalizeCustomHeader(
    (obj as any).customHeader ?? (obj as any).customHeaders ?? (obj as any).custom_headers ?? (obj as any).headers,
  );
  const options = isPlainObject((obj as any).options) ? ((obj as any).options as Record<string, unknown>) : {};
  const endpoints = isPlainObject((obj as any).endpoints) ? ((obj as any).endpoints as Record<string, unknown>) : {};
  const quirks = isPlainObject((obj as any).quirks) ? ((obj as any).quirks as Record<string, unknown>) : {};
  const models = isPlainObject((obj as any).models) ? ((obj as any).models as Record<string, unknown>) : {};

  const discoverModels = normalizeBoolLike(
    (obj as any).discoverModels ?? (obj as any).autoModels ?? (obj as any).modelsFromUpstream ?? (obj as any).discover_models,
  );
  const discoverModelsTtlSeconds = normalizeDiscoverModelsTtlSeconds(
    (obj as any).discoverModelsTtlSeconds ?? (obj as any).modelsTtlSeconds ?? (obj as any).modelsCacheTtlSeconds ?? (obj as any).discover_models_ttl_seconds,
  );

  return {
    id,
    apiMode,
    ownedBy,
    baseURLs,
    apiKeyEnv,
    apiKey,
    routing,
    upstreams,
    customHeader,
    options,
    endpoints,
    quirks,
    discoverModels,
    discoverModelsTtlSeconds,
    models: models as unknown as Record<string, ModelConfig>,
  };
}

function normalizeModelConfig(name: string, raw: unknown): ModelConfig {
  const obj = isPlainObject(raw) ? raw : {};
  const upstreamModel = typeof (obj as any).upstreamModel === "string" ? String((obj as any).upstreamModel).trim() : "";
  const options = isPlainObject((obj as any).options) ? ((obj as any).options as Record<string, unknown>) : {};
  const quirks = isPlainObject((obj as any).quirks) ? ((obj as any).quirks as Record<string, unknown>) : {};
  return { name, upstreamModel: upstreamModel || name, options, quirks };
}

function readGatewayConfigRaw(env: Env): string {
  const primary = typeof (env as any)?.RSP4COPILOT_CONFIG === "string" ? String((env as any).RSP4COPILOT_CONFIG) : "";
  if (primary.trim()) return primary;
  return "";
}

export function parseGatewayConfig(env: Env):
  | { ok: true; config: GatewayConfig; source: "env"; error: "" }
  | { ok: false; config: null; source: "none" | "env"; error: string } {
  const raw = readGatewayConfigRaw(env);
  if (!raw.trim()) return { ok: false, config: null, source: "none", error: "Missing RSP4COPILOT_CONFIG" };

  const parsed = parseJsonc(raw);
  if (!parsed.ok) return { ok: false, config: null, source: "env", error: `Invalid config: ${parsed.error}` };

  const root = parsed.value;
  if (!isPlainObject(root)) return { ok: false, config: null, source: "env", error: "Config must be a JSON object" };

  const version = Number((root as any).version ?? 1);
  if (!Number.isFinite(version) || version !== 1) return { ok: false, config: null, source: "env", error: "Unsupported config version" };

  const providersRaw = isPlainObject((root as any).providers) ? ((root as any).providers as Record<string, unknown>) : null;
  if (!providersRaw) return { ok: false, config: null, source: "env", error: "Missing providers" };

  const providers: Record<string, ProviderConfig> = {};
  for (const [idRaw, pr] of Object.entries(providersRaw)) {
    const id = String(idRaw ?? "").trim();
    if (!id) continue;
    if (id.includes(".")) {
      return { ok: false, config: null, source: "env", error: `Provider id must not contain '.': ${id}` };
    }
    const p = normalizeProviderConfig(id, pr);
    if (!p.apiMode) return { ok: false, config: null, source: "env", error: `Provider ${id}: missing apiMode` };
    if (!p.ownedBy) p.ownedBy = inferProviderOwnedBy(p.apiMode, id);

    // Normalize base URLs early (provider-level, legacy mode).
    p.baseURLs = p.baseURLs
      .map((u) => normalizeBaseUrl(u))
      .map((u) => u.trim())
      .filter(Boolean);

    // Normalize upstreams (aggregation mode).
    const seenUpstreamIds = new Set<string>();
    const upstreams: ProviderUpstreamConfig[] = [];
    for (let i = 0; i < (Array.isArray(p.upstreams) ? p.upstreams.length : 0); i++) {
      const u0 = p.upstreams[i];
      const u: ProviderUpstreamConfig = { ...u0 };
      u.id = String(u.id || `${id}#${i + 1}`).trim() || `${id}#${i + 1}`;
      if (seenUpstreamIds.has(u.id)) u.id = `${u.id}#${i + 1}`;
      seenUpstreamIds.add(u.id);

      u.baseURLs = (Array.isArray(u.baseURLs) ? u.baseURLs : [])
        .map((x) => normalizeBaseUrl(x))
        .map((x) => x.trim())
        .filter(Boolean);
      if (!u.baseURLs.length) return { ok: false, config: null, source: "env", error: `Provider ${id} upstream ${u.id}: missing/invalid baseURL` };
      if (!u.apiKey && !u.apiKeyEnv) {
        return { ok: false, config: null, source: "env", error: `Provider ${id} upstream ${u.id}: missing apiKey or apiKeyEnv` };
      }
      u.weight = normalizeWeight(u.weight);
      u.customHeader = isPlainObject((u as any).customHeader) ? (u as any).customHeader : {};
      u.options = isPlainObject(u.options) ? u.options : {};
      u.endpoints = isPlainObject(u.endpoints) ? u.endpoints : {};
      u.quirks = isPlainObject(u.quirks) ? u.quirks : {};
      upstreams.push(u);
    }
    p.upstreams = upstreams;

    // Validate upstream settings: either (a) provider-level baseURL+key, or (b) one or more upstreams.
    const hasUpstreams = p.upstreams.length > 0;
    if (!hasUpstreams) {
      if (!p.baseURLs.length) return { ok: false, config: null, source: "env", error: `Provider ${id}: missing baseURL` };
      if (!p.apiKey && !p.apiKeyEnv) {
        return { ok: false, config: null, source: "env", error: `Provider ${id}: missing apiKey or apiKeyEnv` };
      }
    }

    const modelMap: Record<string, ModelConfig> = {};
    for (const [mnRaw, mr] of Object.entries(isPlainObject(p.models) ? p.models : {})) {
      const mn = String(mnRaw ?? "").trim();
      if (!mn) continue;
      modelMap[mn] = normalizeModelConfig(mn, mr);
    }
    p.models = modelMap;

    p.customHeader = isPlainObject((p as any).customHeader) ? (p as any).customHeader : {};
    providers[id] = p;
  }

  if (!Object.keys(providers).length) return { ok: false, config: null, source: "env", error: "No providers configured" };

  return { ok: true, config: { version: 1, providers }, source: "env", error: "" };
}

export function getProviderApiKey(env: Env, provider: ProviderConfig): string {
  const inline = typeof provider?.apiKey === "string" ? provider.apiKey.trim() : "";
  if (inline) return normalizeAuthValue(inline);
  const keyName = typeof provider?.apiKeyEnv === "string" ? provider.apiKeyEnv.trim() : "";
  if (!keyName) return "";
  return normalizeAuthValue((env as any)?.[keyName]);
}

export function getAnyApiKeyFromConfig(env: Env, ref: { apiKey?: unknown; apiKeyEnv?: unknown }): string {
  const inline = typeof ref?.apiKey === "string" ? String(ref.apiKey).trim() : "";
  if (inline) return normalizeAuthValue(inline);
  const keyName = typeof ref?.apiKeyEnv === "string" ? String(ref.apiKeyEnv).trim() : "";
  if (!keyName) return "";
  return normalizeAuthValue((env as any)?.[keyName]);
}

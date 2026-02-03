import type { Env } from "./common";
import type { ProviderConfig, ProviderUpstreamConfig } from "./config";
import { getAnyApiKeyFromConfig } from "./config";

export interface SelectedUpstream {
  id: string;
  baseURLs: string[];
  apiKey: string;
  customHeader: Record<string, string>;
  options: Record<string, unknown>;
  endpoints: Record<string, unknown>;
  quirks: Record<string, unknown>;
}

const roundRobinState = new Map<string, number>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeObjects(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const a = isPlainObject(base) ? base : {};
  const b = isPlainObject(override) ? override : {};
  const hasA = Object.keys(a).length > 0;
  const hasB = Object.keys(b).length > 0;
  if (!hasA && !hasB) return {};
  if (!hasA) return { ...b };
  if (!hasB) return { ...a };
  return { ...a, ...b };
}

function normalizeHeaderMap(raw: unknown): Record<string, string> {
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

function mergeHeaderMaps(a: unknown, b: unknown): Record<string, string> {
  const aa = normalizeHeaderMap(a);
  const bb = normalizeHeaderMap(b);
  const hasA = Object.keys(aa).length > 0;
  const hasB = Object.keys(bb).length > 0;
  if (!hasA && !hasB) return {};
  if (!hasA) return { ...bb };
  if (!hasB) return { ...aa };
  return { ...aa, ...bb };
}

function normalizeRoutingStrategy(raw: unknown): "priority" | "round_robin" | "random" | "hash" {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "roundrobin" || s === "round-robin" || s === "rr") return "round_robin";
  if (s === "random" || s === "rand") return "random";
  if (s === "hash" || s === "sticky" || s === "affinity") return "hash";
  return "priority";
}

function getRoutingStrategy(provider: ProviderConfig): "priority" | "round_robin" | "random" | "hash" {
  const r = isPlainObject(provider.routing) ? provider.routing : {};
  return normalizeRoutingStrategy((r as any).strategy ?? (r as any).mode);
}

function getAffinityKey(request: Request, reqId: string): string {
  const xSessionId = request.headers.get("x-session-id");
  if (typeof xSessionId === "string" && xSessionId.trim()) return `x-session-id:${xSessionId.trim()}`;
  const xff = request.headers.get("x-forwarded-for");
  if (typeof xff === "string" && xff.trim()) return `x-forwarded-for:${xff.trim().split(",")[0].trim()}`;
  const cfIp = request.headers.get("cf-connecting-ip");
  if (typeof cfIp === "string" && cfIp.trim()) return `cf-connecting-ip:${cfIp.trim()}`;
  return `req:${reqId}`;
}

function hash32(input: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function getProviderUpstreams(provider: ProviderConfig): ProviderUpstreamConfig[] {
  const list = Array.isArray(provider.upstreams) ? provider.upstreams : [];
  if (list.length) return list;
  return [
    {
      id: provider.id,
      baseURLs: Array.isArray(provider.baseURLs) ? provider.baseURLs : [],
      apiKeyEnv: provider.apiKeyEnv,
      apiKey: provider.apiKey,
      weight: 1,
      customHeader: normalizeHeaderMap(provider.customHeader),
      options: {},
      endpoints: {},
      quirks: {},
    },
  ];
}

function normalizeWeight(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? ""));
  if (!Number.isFinite(n)) return 1;
  if (n <= 0) return 1;
  return n;
}

function pickWeightedIndex(weights: number[], seedUnit: number): number {
  const w = weights.map(normalizeWeight);
  const total = w.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return 0;
  const r = Math.floor(seedUnit * total);
  let acc = 0;
  for (let i = 0; i < w.length; i++) {
    acc += w[i];
    if (r < acc) return i;
  }
  return w.length - 1;
}

function rotatedOrder(len: number, start: number): number[] {
  const s = ((start % len) + len) % len;
  const out: number[] = [];
  for (let i = 0; i < len; i++) out.push((s + i) % len);
  return out;
}

export function listUpstreamCandidates({
  env,
  provider,
  request,
  reqId,
}: {
  env: Env;
  provider: ProviderConfig;
  request: Request;
  reqId: string;
}): SelectedUpstream[] {
  const upstreams = getProviderUpstreams(provider);
  const weights = upstreams.map((u) => normalizeWeight(u.weight));
  const strategy = getRoutingStrategy(provider);

  let order: number[] = [];
  if (upstreams.length <= 1) {
    order = [0];
  } else if (strategy === "round_robin") {
    const next = (roundRobinState.get(provider.id) ?? 0) + 1;
    roundRobinState.set(provider.id, next);
    order = rotatedOrder(upstreams.length, next - 1);
  } else if (strategy === "random") {
    const idx = pickWeightedIndex(weights, Math.random());
    order = [idx, ...rotatedOrder(upstreams.length, idx + 1).filter((i) => i !== idx)];
  } else if (strategy === "hash") {
    const key = getAffinityKey(request, reqId);
    const unit = (hash32(`${provider.id}:${key}`) % 1_000_000) / 1_000_000;
    const idx = pickWeightedIndex(weights, unit);
    order = [idx, ...rotatedOrder(upstreams.length, idx + 1).filter((i) => i !== idx)];
  } else {
    order = rotatedOrder(upstreams.length, 0);
  }

  const out: SelectedUpstream[] = [];
  for (const i of order) {
    const u = upstreams[i];
    const apiKey = getAnyApiKeyFromConfig(env, u);
    if (!apiKey) continue;

    const customHeader = mergeHeaderMaps(provider.customHeader, u.customHeader);
    const options = mergeObjects(provider.options || {}, u.options || {});
    const endpoints = mergeObjects(provider.endpoints || {}, u.endpoints || {});
    const quirks = mergeObjects(provider.quirks || {}, u.quirks || {});

    out.push({ id: u.id || `${provider.id}#${i + 1}`, baseURLs: u.baseURLs, apiKey, customHeader, options, endpoints, quirks });
  }

  return out;
}

export function shouldTryNextUpstreamCandidateStatus(status: number): boolean {
  // Retry-ish statuses: network/proxy errors, rate limits, quota/payment errors, and common "wrong path" errors.
  // 401/403: often means a specific key is invalid or banned.
  return (
    status === 400 ||
    status === 402 ||
    status === 403 ||
    status === 404 ||
    status === 405 ||
    status === 408 ||
    status === 409 ||
    status === 422 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

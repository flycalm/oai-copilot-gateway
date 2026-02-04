import type { Env } from "./common";
import { applyUpstreamCustomHeaders, joinPathPrefix, logDebug, normalizeBaseUrl } from "./common";
import { getAnyApiKeyFromConfig, type GatewayConfig, type ProviderConfig } from "./config";
import { listUpstreamCandidates } from "./upstreams";

function normalizeDuplicateV1Segments(path: unknown): string {
  let p = typeof path === "string" ? path : path == null ? "" : String(path);
  if (!p) return p;
  p = p.replace(/\/{2,}/g, "/");
  for (let i = 0; i < 6; i++) {
    const next = p.replace(/\/v1\/+v1(\/|$)/g, "/v1$1");
    if (next === p) break;
    p = next;
  }
  return p;
}

function buildModelsListUrls(baseUrlRaw: string): string[] {
  const value = String(baseUrlRaw || "").trim();
  if (!value) return [];

  const out: string[] = [];
  const pushUrl = (urlStr: string) => {
    if (!urlStr || typeof urlStr !== "string") return;
    if (!out.includes(urlStr)) out.push(urlStr);
  };

  try {
    const normalized = normalizeBaseUrl(value);
    const u0 = new URL(normalized);
    const rawPath = (u0.pathname || "").replace(/\/+$/, "") || "/";
    const base0 = normalizeDuplicateV1Segments(rawPath);

    const basePathsSet = new Set<string>();
    const pushBase = (bp: string) => {
      const v = normalizeDuplicateV1Segments((bp || "").replace(/\/+$/, "") || "/");
      if (!v) return;
      basePathsSet.add(v);
    };

    pushBase(base0);
    if (base0.endsWith("/v1/models")) pushBase(base0.replace(/\/v1\/models$/, "") || "/");
    if (base0.endsWith("/models")) pushBase(base0.replace(/\/models$/, "") || "/");
    for (const bp of Array.from(basePathsSet)) {
      if (bp.endsWith("/v1")) pushBase(bp.replace(/\/v1$/, "") || "/");
    }

    const inferModelsPath = (basePath: string) => {
      const p = (basePath || "").replace(/\/+$/, "");
      if (p.endsWith("/openai") || p.endsWith("/openai/v1")) return "/models";
      if (p.endsWith("/v1")) return "/models";
      return "/v1/models";
    };

    for (const basePath of Array.from(basePathsSet)) {
      const isFullEndpoint = basePath.endsWith("/v1/models") || basePath.endsWith("/models");

      if (isFullEndpoint) {
        const u = new URL(normalized);
        u.pathname = basePath;
        u.search = "";
        u.hash = "";
        pushUrl(u.toString());
        continue;
      }

      const preferred = inferModelsPath(basePath);
      const candidatesRaw = [joinPathPrefix(basePath, preferred), joinPathPrefix(basePath, "/v1/models"), joinPathPrefix(basePath, "/models")];
      for (const path of candidatesRaw.map(normalizeDuplicateV1Segments)) {
        const u = new URL(normalized);
        u.pathname = path;
        u.search = "";
        u.hash = "";
        pushUrl(u.toString());
      }
    }
  } catch {
    // Ignore invalid base URL
  }

  return out;
}

function parseOpenAIModelsList(json: unknown): string[] {
  const obj = json && typeof json === "object" ? (json as any) : null;
  const data = obj && Array.isArray((obj as any).data) ? ((obj as any).data as any[]) : [];
  const out: string[] = [];
  for (const item of data) {
    if (typeof item === "string") {
      const id = item.trim();
      if (id && !id.includes(":")) out.push(id);
      continue;
    }
    if (item && typeof item === "object") {
      const id = typeof (item as any).id === "string" ? String((item as any).id).trim() : "";
      if (id && !id.includes(":")) out.push(id);
      continue;
    }
  }
  return out;
}

function shouldDiscoverModels(provider: ProviderConfig): boolean {
  return Boolean((provider as any)?.discoverModels);
}

export function getModelsDiscoveryWarnings({ env, provider }: { env: Env; provider: ProviderConfig }): string[] {
  if (!provider || !shouldDiscoverModels(provider)) return [];

  const warnings: string[] = [];

  const apiMode = typeof (provider as any)?.apiMode === "string" ? String((provider as any).apiMode).trim() : "";
  const apiModeLower = apiMode.toLowerCase();
  if (apiModeLower && !apiModeLower.startsWith("openai")) {
    warnings.push(`discoverModels 仅尝试 OpenAI 风格的 GET /v1/models 或 /models（当前 apiMode=${apiMode}）`);
  }

  const upstreams =
    Array.isArray((provider as any).upstreams) && (provider as any).upstreams.length
      ? ((provider as any).upstreams as any[])
      : [
          {
            id: provider.id,
            baseURLs: Array.isArray((provider as any).baseURLs) ? (provider as any).baseURLs : [],
            apiKey: (provider as any).apiKey,
            apiKeyEnv: (provider as any).apiKeyEnv,
          },
        ];

  const hasAnyBaseUrl = upstreams.some((u) => Array.isArray(u?.baseURLs) && u.baseURLs.some((x: any) => String(x ?? "").trim()));
  if (!hasAnyBaseUrl) warnings.push("未配置 baseURL/baseURLs（无法访问上游）");

  const apiKeyEnvNames = Array.from(
    new Set(
      upstreams
        .map((u) => (typeof u?.apiKeyEnv === "string" ? u.apiKeyEnv.trim() : ""))
        .filter(Boolean),
    ),
  );
  const hasAnyApiKey = upstreams.some((u) => Boolean(getAnyApiKeyFromConfig(env, u)));
  if (!hasAnyApiKey) {
    if (apiKeyEnvNames.length) warnings.push(`未检测到可用上游 API key：请检查环境变量 ${apiKeyEnvNames.join(", ")}`);
    else warnings.push("未检测到可用上游 API key：请配置 apiKey/apiKeyEnv");
  }

  return warnings;
}

export async function fetchUpstreamModelsForProvider({
  env,
  provider,
  request,
  reqId,
  debug,
}: {
  env: Env;
  provider: ProviderConfig;
  request: Request;
  reqId: string;
  debug: boolean;
}): Promise<string[]> {
  if (!provider || !shouldDiscoverModels(provider)) return [];
  return fetchModelsFromUpstream({ env, provider, request, reqId, debug });
}

async function fetchModelsFromUpstream({
  env,
  provider,
  request,
  reqId,
  debug,
}: {
  env: Env;
  provider: ProviderConfig;
  request: Request;
  reqId: string;
  debug: boolean;
}): Promise<string[]> {
  const candidates = listUpstreamCandidates({ env, provider, request, reqId });
  if (!candidates.length) return [];

  const all = new Set<string>();

  const timeoutMs = 2500;

  for (const upstream of candidates) {
    const baseURLs = Array.isArray(upstream.baseURLs) ? upstream.baseURLs : [];
    let ok = false;

    for (const baseUrl of baseURLs) {
      const urls = buildModelsListUrls(baseUrl);
      if (!urls.length) {
        logDebug(debug, reqId, "models discovery: invalid baseURL or no candidate endpoints", {
          providerId: provider.id,
          upstreamId: upstream.id,
          baseURL: String(baseUrl ?? ""),
        });
        continue;
      }
      for (const endpointUrl of urls) {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const baseHeaders: Record<string, string> = {
            authorization: `Bearer ${upstream.apiKey}`,
            accept: "application/json",
            ...upstream.customHeader,
          };
          const headers = applyUpstreamCustomHeaders(baseHeaders, env);
          const resp = await fetch(endpointUrl, { method: "GET", headers, signal: controller.signal });
          if (!resp.ok) {
            logDebug(debug, reqId, "models discovery: upstream non-OK response", {
              providerId: provider.id,
              upstreamId: upstream.id,
              url: endpointUrl,
              status: resp.status,
            });
            // Try next candidate URL.
            continue;
          }
          const parsed = await resp.json();
          for (const id of parseOpenAIModelsList(parsed)) all.add(id);
          ok = true;
          break;
        } catch (e) {
          logDebug(debug, reqId, "models discovery: upstream fetch error", {
            providerId: provider.id,
            upstreamId: upstream.id,
            url: endpointUrl,
            error: String((e as any)?.message || e),
          });
        } finally {
          clearTimeout(t);
        }
      }
      if (ok) break;
    }

    if (!ok) {
      logDebug(debug, reqId, "models discovery: upstream fetch failed", { providerId: provider.id, upstreamId: upstream.id });
    }
  }

  return Array.from(all).sort((a, b) => a.localeCompare(b));
}

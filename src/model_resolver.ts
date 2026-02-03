import { jsonError } from "./common";
import type { GatewayConfig, ModelConfig, ModelRouteProviderConfig, ModelRouteStrategy, ProviderConfig } from "./config";

const modelRoundRobinState = new Map<string, number>();

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

function hash32(input: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function getAffinityKey(request: Request | undefined, reqId: string): string {
  if (!request) return `req:${reqId}`;
  const xSessionId = request.headers.get("x-session-id");
  if (typeof xSessionId === "string" && xSessionId.trim()) return `x-session-id:${xSessionId.trim()}`;
  const xff = request.headers.get("x-forwarded-for");
  if (typeof xff === "string" && xff.trim()) return `x-forwarded-for:${xff.trim().split(",")[0].trim()}`;
  const cfIp = request.headers.get("cf-connecting-ip");
  if (typeof cfIp === "string" && cfIp.trim()) return `cf-connecting-ip:${cfIp.trim()}`;
  return `req:${reqId}`;
}

function normalizeRouteStrategy(raw: unknown): ModelRouteStrategy {
  const v0 = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v0 === "roundrobin" || v0 === "round-robin" || v0 === "rr" || v0 === "round_robin") return "round_robin";
  if (v0 === "random" || v0 === "rand") return "random";
  if (v0 === "hash" || v0 === "sticky" || v0 === "affinity") return "hash";
  if (v0 === "priority") return "priority";
  return "priority";
}

export function splitProviderModel(
  modelId: unknown,
): { ok: true; providerId: string; modelName: string; error: "" } | { ok: false; providerId: ""; modelName: ""; error: string } {
  const raw = typeof modelId === "string" ? modelId.trim() : "";
  if (!raw) return { ok: false, providerId: "", modelName: "", error: "Missing model" };
  if (raw.includes(":")) return { ok: false, providerId: "", modelName: "", error: "Invalid model: use providerId.modelName (':' is not allowed)" };
  const idx = raw.indexOf(".");
  if (idx <= 0 || idx === raw.length - 1) {
    return { ok: false, providerId: "", modelName: "", error: "Invalid model: must be providerId.modelName" };
  }
  const providerId = raw.slice(0, idx).trim();
  const modelName = raw.slice(idx + 1).trim();
  if (!providerId || !modelName) return { ok: false, providerId: "", modelName: "", error: "Invalid model: must be providerId.modelName" };
  return { ok: true, providerId, modelName, error: "" };
}

function normalizeProviderHint(hint: unknown): string {
  if (hint == null) return "";
  const v = typeof hint === "string" ? hint.trim() : String(hint).trim();
  return v;
}

function matchProviderByHint(
  config: GatewayConfig,
  hintRaw: unknown,
): { ok: true; providerId: string; provider: ProviderConfig; error: "" } | { ok: false; providerId: ""; provider: null; error: string } {
  const hint = normalizeProviderHint(hintRaw);
  if (!hint) return { ok: false, providerId: "", provider: null, error: "Missing provider" };

  const direct = config.providers[hint];
  if (direct) return { ok: true, providerId: hint, provider: direct, error: "" };

  const needle = hint.toLowerCase();
  const matches: Array<{ providerId: string; provider: ProviderConfig }> = [];
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (providerId.toLowerCase() === needle) matches.push({ providerId, provider });
    else if ((provider?.ownedBy || "").toLowerCase() === needle) matches.push({ providerId, provider });
  }

  if (matches.length === 1) return { ok: true, providerId: matches[0].providerId, provider: matches[0].provider, error: "" };
  if (matches.length > 1) return { ok: false, providerId: "", provider: null, error: `Ambiguous provider: ${hint} (use provider id)` };
  return { ok: false, providerId: "", provider: null, error: `Unknown provider: ${hint}` };
}

export function resolveModel(
  config: GatewayConfig,
  modelId: unknown,
  providerHint?: unknown,
  request?: Request,
  reqId: string = "",
):
  | {
      ok: true;
      providerId: string;
      modelName: string;
      provider: ProviderConfig;
      model: ModelConfig;
    }
  | { ok: false; status: number; error: { error: { message: string; type: string; code: string } } } {
  const rawModel = typeof modelId === "string" ? modelId.trim() : "";
  if (!rawModel) return { ok: false, status: 400, error: jsonError("Missing model", "invalid_request_error") };
  if (rawModel.includes(":")) return { ok: false, status: 400, error: jsonError("Invalid model (':' is not allowed)", "invalid_request_error") };

  if ((config as any)?.version === 2) {
    const cfg = config as any;
    const models: Record<string, ModelConfig> = (cfg.models && typeof cfg.models === "object" ? cfg.models : {}) as any;
    const routes: Record<string, any> = (cfg.routes && typeof cfg.routes === "object" ? cfg.routes : {}) as any;

    // Optional: explicit provider prefix (`providerId.modelName`), only when prefix matches a configured provider id/ownedBy.
    let explicitProviderId = "";
    let modelName = rawModel;
    if (rawModel.includes(".")) {
      const idx = rawModel.indexOf(".");
      const maybeProvider = rawModel.slice(0, idx).trim();
      const maybeModelName = rawModel.slice(idx + 1).trim();
      if (maybeProvider && maybeModelName) {
        const sel = matchProviderByHint(config, maybeProvider);
        if (sel.ok) {
          explicitProviderId = sel.providerId;
          modelName = maybeModelName;
        }
      }
    }

    const modelBase = models[modelName];
    if (!modelBase) return { ok: false, status: 400, error: jsonError(`Unknown model: ${modelName}`, "invalid_request_error") };

    const route = routes[modelName];
    const routeProvidersRaw = route && Array.isArray(route.providers) ? route.providers : [];
    const routeProviders: ModelRouteProviderConfig[] = routeProvidersRaw
      .map((x) => {
        if (typeof x === "string") return { providerId: x };
        if (!x || typeof x !== "object") return null;
        const providerId = typeof (x as any).providerId === "string" ? String((x as any).providerId).trim() : "";
        if (!providerId) return null;
        const out: ModelRouteProviderConfig = { providerId };
        const upstreamModel = typeof (x as any).upstreamModel === "string" ? String((x as any).upstreamModel).trim() : "";
        if (upstreamModel) out.upstreamModel = upstreamModel;
        const weight = normalizeWeight((x as any).weight ?? (x as any).w);
        if (Number.isFinite(weight) && weight !== 1) out.weight = weight;
        return out;
      })
      .filter(Boolean) as any;

    const candidates = routeProviders.filter((r) => Boolean((config as any).providers?.[r.providerId]));
    if (!candidates.length) {
      return { ok: false, status: 400, error: jsonError(`Model is not routed: ${modelName}`, "invalid_request_error") };
    }

    const hint = normalizeProviderHint(providerHint);
    const selectedProviderId = (() => {
      if (explicitProviderId) return explicitProviderId;
      if (hint) {
        const sel = matchProviderByHint(config, hint);
        if (!sel.ok) return "";
        return sel.providerId;
      }
      const strategy = normalizeRouteStrategy(route?.strategy ?? route?.mode);
      if (strategy === "round_robin") {
        const next = (modelRoundRobinState.get(modelName) ?? 0) + 1;
        modelRoundRobinState.set(modelName, next);
        return candidates[(next - 1) % candidates.length].providerId;
      }
      if (strategy === "random") {
        const weights = candidates.map((c) => normalizeWeight(c.weight ?? 1));
        const idx = pickWeightedIndex(weights, Math.random());
        return candidates[idx].providerId;
      }
      if (strategy === "hash") {
        const key = getAffinityKey(request, reqId);
        const unit = (hash32(`${modelName}:${key}`) % 1_000_000) / 1_000_000;
        const weights = candidates.map((c) => normalizeWeight(c.weight ?? 1));
        const idx = pickWeightedIndex(weights, unit);
        return candidates[idx].providerId;
      }
      return candidates[0].providerId;
    })();

    if (hint || explicitProviderId) {
      if (!selectedProviderId) {
        return { ok: false, status: 400, error: jsonError(`Unknown provider: ${hint || explicitProviderId}`, "invalid_request_error") };
      }
      if (!candidates.some((c) => c.providerId === selectedProviderId)) {
        return { ok: false, status: 400, error: jsonError(`Model ${modelName} is not routed to provider ${selectedProviderId}`, "invalid_request_error") };
      }
    }

    const provider = (config as any).providers[selectedProviderId];
    if (!provider) return { ok: false, status: 400, error: jsonError(`Unknown provider: ${selectedProviderId}`, "invalid_request_error") };
    const ref = candidates.find((c) => c.providerId === selectedProviderId) || candidates[0];
    const upstreamModel = (ref?.upstreamModel || "").trim() || (modelBase?.upstreamModel || "").trim() || modelName;
    const model: ModelConfig = { ...modelBase, name: modelName, upstreamModel };
    return { ok: true, providerId: selectedProviderId, modelName, provider, model };
  }

  // Optional: explicit provider prefix (`providerId.modelName`).
  // NOTE: Many upstream model IDs contain dots (e.g. `gpt-5.2`, `gemini-1.5-pro`), so we only treat it as a
  // provider prefix if the prefix matches a configured provider id (or a unique `ownedBy`).
  if (rawModel.includes(".")) {
    const idx = rawModel.indexOf(".");
    const maybeProvider = rawModel.slice(0, idx).trim();
    const maybeModelName = rawModel.slice(idx + 1).trim();
    if (maybeProvider && maybeModelName) {
      const sel = matchProviderByHint(config, maybeProvider);
      if (sel.ok) {
        const model = sel.provider.models[maybeModelName];
        if (model) return { ok: true, providerId: sel.providerId, modelName: maybeModelName, provider: sel.provider, model };
        return { ok: false, status: 400, error: jsonError(`Unknown model for provider ${sel.providerId}: ${maybeModelName}`, "invalid_request_error") };
      }
    }
  }

  // Preferred: separate `provider` + `model`
  const modelName = rawModel;
  const hint = normalizeProviderHint(providerHint);

  if (hint) {
    const sel = matchProviderByHint(config, hint);
    if (!sel.ok) return { ok: false, status: 400, error: jsonError(sel.error, "invalid_request_error") };
    const model = sel.provider.models[modelName];
    if (model) return { ok: true, providerId: sel.providerId, modelName, provider: sel.provider, model };
    return { ok: false, status: 400, error: jsonError(`Unknown model for provider ${sel.providerId}: ${modelName}`, "invalid_request_error") };
  }

  // No provider hint: infer from config (must be unique)
  const matches: Array<{ providerId: string; provider: ProviderConfig; model: ModelConfig }> = [];
  for (const [providerId, provider] of Object.entries(config.providers)) {
    const m = provider?.models?.[modelName];
    if (m) matches.push({ providerId, provider, model: m });
  }

  if (!matches.length) {
    return { ok: false, status: 400, error: jsonError(`Unknown model: ${modelName}`, "invalid_request_error") };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      status: 400,
      error: jsonError(`Ambiguous model: ${modelName} (provide 'provider' or use providerId.modelName)`, "invalid_request_error"),
    };
  }

  return { ok: true, providerId: matches[0].providerId, modelName, provider: matches[0].provider, model: matches[0].model };
}

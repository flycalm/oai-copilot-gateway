import type { GatewayConfig } from "./config";

export type ModelListEntry = { providerId: string; modelName: string; ownedBy: string };

function collectModelsV1(config: GatewayConfig): ModelListEntry[] {
  const out: Array<{ providerId: string; modelName: string; ownedBy: string }> = [];
  const providers = ((config as any).providers && typeof (config as any).providers === "object" ? (config as any).providers : {}) as Record<string, any>;
  for (const providerId of Object.keys(providers)) {
    const provider = providers[providerId] || {};
    const ownedBy = typeof provider?.ownedBy === "string" && provider.ownedBy.trim() ? provider.ownedBy.trim() : providerId;
    for (const modelName of Object.keys(provider.models || {})) {
      out.push({ providerId, modelName, ownedBy });
    }
  }
  return out;
}

function collectModelsV2(config: GatewayConfig): Array<{ modelName: string; providerIds: string[] }> {
  const out: Array<{ modelName: string; providerIds: string[] }> = [];
  const models = (config as any)?.models && typeof (config as any).models === "object" ? ((config as any).models as Record<string, unknown>) : {};
  const routes = (config as any)?.routes && typeof (config as any).routes === "object" ? ((config as any).routes as Record<string, any>) : {};
  for (const modelName of Object.keys(models || {})) {
    const route = routes[modelName];
    const list = route && Array.isArray(route.providers) ? route.providers : [];
    const providerIds = list
      .map((x) => String((x && x.providerId) || (x && x.id) || (typeof x === "string" ? x : "")).trim())
      .filter(Boolean)
      .filter((pid) => Boolean((config as any).providers?.[pid]));
    if (!providerIds.length) continue;
    out.push({ modelName, providerIds });
  }
  return out;
}

function modelIdForList(
  models: ModelListEntry[],
  entry: ModelListEntry,
): string {
  const count = models.reduce((n, m) => (m.modelName === entry.modelName ? n + 1 : n), 0);
  if (count <= 1) return entry.modelName;
  return `${entry.providerId}.${entry.modelName}`;
}

export function openaiModelsListFromEntries(
  models: ModelListEntry[],
): { object: "list"; data: Array<{ id: string; object: "model"; created: number; owned_by: string }> } {
  const ids = (Array.isArray(models) ? models : [])
    .map((m) => ({ id: modelIdForList(models, m), owned_by: m.ownedBy }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    object: "list",
    data: ids.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: m.owned_by })),
  };
}

export function openaiModelsList(config: GatewayConfig): { object: "list"; data: Array<{ id: string; object: "model"; created: number; owned_by: string }> } {
  if ((config as any)?.version === 2) {
    const out: Array<{ id: string; object: "model"; created: number; owned_by: string }> = [];
    for (const item of collectModelsV2(config)) {
      const ownedBy =
        item.providerIds.length === 1
          ? String((config as any).providers?.[item.providerIds[0]]?.ownedBy || item.providerIds[0]).trim() || item.providerIds[0]
          : "mixed";
      out.push({ id: item.modelName, object: "model", created: 0, owned_by: ownedBy });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return { object: "list", data: out };
  }
  return openaiModelsListFromEntries(collectModelsV1(config));
}

export function geminiModelsList(config: GatewayConfig): {
  models: Array<{ name: string; displayName: string; supportedGenerationMethods: ["generateContent", "streamGenerateContent"] }>;
} {
  const ids =
    (config as any)?.version === 2
      ? collectModelsV2(config).map((m) => m.modelName).sort((a, b) => a.localeCompare(b))
      : (() => {
          const models = collectModelsV1(config);
          return models
            .map((m) => modelIdForList(models, m))
            .sort((a, b) => a.localeCompare(b));
        })();
  return {
    models: ids.map((id) => ({
      name: `models/${id}`,
      displayName: id,
      supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
    })),
  };
}

export function ollamaModelsList(config: GatewayConfig): {
  models: Array<{ name: string; modified_at: string; size: number }>;
} {
  const ids =
    (config as any)?.version === 2
      ? collectModelsV2(config).map((m) => m.modelName).sort((a, b) => a.localeCompare(b))
      : (() => {
          const models = collectModelsV1(config);
          return models
            .map((m) => modelIdForList(models, m))
            .sort((a, b) => a.localeCompare(b));
        })();
  return {
    models: ids.map((id) => ({
      name: `${id}:latest`,
      modified_at: new Date().toISOString(),
      size: 0,
    })),
  };
}

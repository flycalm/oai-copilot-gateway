import type { GatewayConfig } from "./config";

export type ModelListEntry = { providerId: string; modelName: string; ownedBy: string };

function collectModels(config: GatewayConfig): ModelListEntry[] {
  const out: Array<{ providerId: string; modelName: string; ownedBy: string }> = [];
  for (const [providerId, provider] of Object.entries(config.providers)) {
    const ownedBy = typeof provider?.ownedBy === "string" && provider.ownedBy.trim() ? provider.ownedBy.trim() : providerId;
    for (const modelName of Object.keys(provider.models || {})) {
      out.push({ providerId, modelName, ownedBy });
    }
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
  return openaiModelsListFromEntries(collectModels(config));
}

export function geminiModelsList(config: GatewayConfig): {
  models: Array<{ name: string; displayName: string; supportedGenerationMethods: ["generateContent", "streamGenerateContent"] }>;
} {
  const models = collectModels(config);
  const ids = models
    .map((m) => modelIdForList(models, m))
    .sort((a, b) => a.localeCompare(b));
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
  const models = collectModels(config);
  const ids = models
    .map((m) => modelIdForList(models, m))
    .sort((a, b) => a.localeCompare(b));
  return {
    models: ids.map((id) => ({
      name: `${id}:latest`,
      modified_at: new Date().toISOString(),
      size: 0,
    })),
  };
}

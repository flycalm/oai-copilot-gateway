export interface DiscoveredModelsCacheEntry {
  updatedAtMs: number;
  expiresAtMs: number;
  models: Set<string>;
}

const discoveredModelsCache = new Map<string, DiscoveredModelsCacheEntry>();

export function setDiscoveredModelsCache(providerId: string, modelNames: string[], ttlSeconds: number): void {
  const pid = String(providerId || "").trim();
  if (!pid) return;
  const ttlMs = Math.max(1_000, Math.floor((Number.isFinite(ttlSeconds) ? ttlSeconds : 0) * 1000));
  const now = Date.now();
  const models = new Set<string>();
  for (const m0 of Array.isArray(modelNames) ? modelNames : []) {
    const m = String(m0 ?? "").trim();
    if (!m) continue;
    if (m.includes(":")) continue;
    models.add(m);
  }
  discoveredModelsCache.set(pid, { updatedAtMs: now, expiresAtMs: now + ttlMs, models });
}

export function getDiscoveredModelsCacheEntry(providerId: string): DiscoveredModelsCacheEntry | null {
  const pid = String(providerId || "").trim();
  if (!pid) return null;
  const entry = discoveredModelsCache.get(pid);
  if (!entry) return null;
  if (Date.now() > entry.expiresAtMs) return null;
  return entry;
}

export function hasDiscoveredModel(providerId: string, modelName: string): boolean {
  const entry = getDiscoveredModelsCacheEntry(providerId);
  if (!entry) return false;
  const mn = String(modelName || "").trim();
  if (!mn) return false;
  return entry.models.has(mn);
}

export function findProvidersForDiscoveredModel(modelName: string): string[] {
  const mn = String(modelName || "").trim();
  if (!mn) return [];
  const now = Date.now();
  const out: string[] = [];
  for (const [providerId, entry] of discoveredModelsCache.entries()) {
    if (now > entry.expiresAtMs) continue;
    if (entry.models.has(mn)) out.push(providerId);
  }
  return out;
}


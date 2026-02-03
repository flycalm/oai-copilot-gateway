import type { Env } from "./common";
import { parseBoolEnv } from "./common";
import { tokenMetrics } from "./metrics";
import { availabilityMetrics } from "./availability";

type KvLike = {
  get: (key: string) => Promise<unknown>;
  put: (key: string, value: string) => Promise<unknown>;
};

export type ExecutionContextLike = { waitUntil: (p: Promise<unknown>) => void };

function isKvLike(x: unknown): x is KvLike {
  const o = x && typeof x === "object" ? (x as any) : null;
  return Boolean(o && typeof o.get === "function" && typeof o.put === "function");
}

function getKv(env: Env): KvLike | null {
  const anyEnv: any = env as any;
  const kv = anyEnv?.RSP4COPILOT_STATS_KV ?? anyEnv?.RSP4COPILOT_KV_STATS ?? anyEnv?.STATS_KV;
  return isKvLike(kv) ? kv : null;
}

function getKey(env: Env): string {
  const anyEnv: any = env as any;
  const k = typeof anyEnv?.RSP4COPILOT_STATS_KEY === "string" ? String(anyEnv.RSP4COPILOT_STATS_KEY).trim() : "";
  return k || "rsp4copilot:stats:v1";
}

function persistEnabled(env: Env): boolean {
  const anyEnv: any = env as any;
  const raw = anyEnv?.RSP4COPILOT_STATS_PERSIST;
  if (raw == null) return true;
  return parseBoolEnv(String(raw));
}

function getFlushIntervalMs(env: Env): number {
  const anyEnv: any = env as any;
  const raw = anyEnv?.RSP4COPILOT_STATS_FLUSH_INTERVAL_MS ?? anyEnv?.RSP4COPILOT_STATS_FLUSH_MS;
  const n = typeof raw === "number" ? raw : Number(String(raw ?? ""));
  if (!Number.isFinite(n)) return 5000;
  return Math.max(500, Math.min(60_000, Math.floor(n)));
}

let loaded = false;
let loading: Promise<void> | null = null;
let dirty = false;
let lastPersistAt = 0;
let persisting: Promise<void> | null = null;

function safeJsonParse(text: string): any | null {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
}

function snapshotState(): any {
  return {
    v: 1,
    savedAt: Date.now(),
    token: tokenMetrics.exportState(),
    availability: availabilityMetrics.exportState(),
  };
}

export async function ensureStatsLoaded(env: Env): Promise<void> {
  if (loaded) return;
  if (!persistEnabled(env)) {
    loaded = true;
    return;
  }
  const kv = getKv(env);
  if (!kv) {
    loaded = true;
    return;
  }
  if (loading) return loading;
  const key = getKey(env);
  loading = (async () => {
    try {
      const raw = await kv.get(key);
      if (typeof raw !== "string" || !raw.trim()) return;
      const obj = safeJsonParse(raw);
      if (!obj || typeof obj !== "object") return;
      if (Number(obj.v) !== 1) return;
      try {
        tokenMetrics.importState(obj.token);
      } catch {}
      try {
        availabilityMetrics.importState(obj.availability);
      } catch {}
    } finally {
      loaded = true;
    }
  })();
  return loading;
}

export function markStatsDirty(): void {
  dirty = true;
}

async function persistOnce(env: Env): Promise<void> {
  const kv = getKv(env);
  if (!kv) return;
  const key = getKey(env);
  const payload = JSON.stringify(snapshotState());
  await kv.put(key, payload);
}

export function flushStatsIfNeeded(env: Env, ctx?: ExecutionContextLike): void {
  if (!dirty) return;
  if (!persistEnabled(env)) return;
  const kv = getKv(env);
  if (!kv) return;

  const now = Date.now();
  const minInterval = getFlushIntervalMs(env);
  if (persisting) return;
  if (lastPersistAt && now - lastPersistAt < minInterval) return;

  const p = (async () => {
    try {
      await ensureStatsLoaded(env);
      await persistOnce(env);
      dirty = false;
      lastPersistAt = Date.now();
    } catch {
      // keep dirty
    }
  })();

  persisting = p.then(
    () => {
      persisting = null;
    },
    () => {
      persisting = null;
    },
  );

  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(persisting);
}

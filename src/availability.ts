import { jsonError } from "./common";

export type AvailabilityMetricStatus = "ok" | "error";

export type AvailabilityMetricRecord = {
  ts: number;
  reqId: string;
  path: string;
  stream: boolean;
  providerId: string;
  upstreamId: string;
  model: string;
  status: AvailabilityMetricStatus;
  latencyMs?: number;
};

export type AvailabilityMetricAgg = {
  requests: number;
  ok: number;
  error: number;
  latencyMsSum: number;
  latencyMsCount: number;
};

export type AvailabilityMetricsPersistedStateV1 = {
  v: 1;
  recent: AvailabilityMetricRecord[];
  daily: Record<string, Record<string, AvailabilityMetricAgg>>;
};

function dateKeyUtc(ts: number): string {
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch {
    return "1970-01-01";
  }
}

function clampInt(n: number, min: number, max: number): number {
  const x = Number.isFinite(n) ? Math.floor(n) : min;
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function normId(raw: unknown): string {
  return String(raw ?? "").trim();
}

function fineKey(providerId: string, upstreamId: string, model: string): string {
  const p = providerId || "unknown";
  const u = upstreamId || providerId || "unknown";
  const m = model || "";
  return `${p}::${u}::${m}`;
}

function aggEmpty(): AvailabilityMetricAgg {
  return { requests: 0, ok: 0, error: 0, latencyMsSum: 0, latencyMsCount: 0 };
}

function addAgg(dst: AvailabilityMetricAgg, src: AvailabilityMetricAgg): AvailabilityMetricAgg {
  return {
    requests: dst.requests + src.requests,
    ok: dst.ok + src.ok,
    error: dst.error + src.error,
    latencyMsSum: dst.latencyMsSum + src.latencyMsSum,
    latencyMsCount: dst.latencyMsCount + src.latencyMsCount,
  };
}

function okRate(agg: AvailabilityMetricAgg): number {
  if (!(agg.requests > 0)) return 0;
  return Math.max(0, Math.min(1, agg.ok / agg.requests));
}

function avgLatencyMs(agg: AvailabilityMetricAgg): number {
  if (!(agg.latencyMsCount > 0)) return 0;
  return Math.max(0, Math.floor(agg.latencyMsSum / agg.latencyMsCount));
}

export class AvailabilityMetricsStore {
  private recent: AvailabilityMetricRecord[] = [];
  private dailyByUpstreamModel = new Map<string, Map<string, AvailabilityMetricAgg>>();
  private readonly maxRecent: number;
  private readonly retentionDays: number;

  constructor(opts?: { maxRecent?: number; retentionDays?: number }) {
    this.maxRecent = clampInt(Number(opts?.maxRecent ?? 2000), 100, 50000);
    this.retentionDays = clampInt(Number(opts?.retentionDays ?? 60), 1, 3650);
  }

  record(rec: AvailabilityMetricRecord): void {
    const r: AvailabilityMetricRecord = {
      ts: Number.isFinite(rec.ts) ? Math.floor(rec.ts) : Date.now(),
      reqId: normId(rec.reqId),
      path: normId(rec.path),
      stream: Boolean(rec.stream),
      providerId: normId(rec.providerId),
      upstreamId: normId(rec.upstreamId),
      model: normId(rec.model),
      status: rec.status === "error" ? "error" : "ok",
      ...(Number.isFinite(Number(rec.latencyMs)) ? { latencyMs: Math.max(0, Math.floor(Number(rec.latencyMs))) } : {}),
    };

    this.recent.unshift(r);
    if (this.recent.length > this.maxRecent) this.recent.length = this.maxRecent;

    const date = dateKeyUtc(r.ts);
    const k = fineKey(r.providerId, r.upstreamId, r.model);
    const byKey = this.dailyByUpstreamModel.get(date) || new Map<string, AvailabilityMetricAgg>();
    const prev = byKey.get(k) || aggEmpty();
    const isOk = r.status === "ok";
    const latency = Number.isFinite(Number(r.latencyMs)) ? Math.max(0, Math.floor(Number(r.latencyMs))) : 0;
    const next: AvailabilityMetricAgg = {
      requests: prev.requests + 1,
      ok: prev.ok + (isOk ? 1 : 0),
      error: prev.error + (isOk ? 0 : 1),
      latencyMsSum: prev.latencyMsSum + (latency ? latency : 0),
      latencyMsCount: prev.latencyMsCount + (latency ? 1 : 0),
    };
    byKey.set(k, next);
    this.dailyByUpstreamModel.set(date, byKey);

    this.prune();
  }

  private prune(): void {
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    const cutoffDate = dateKeyUtc(cutoff);
    for (const d of Array.from(this.dailyByUpstreamModel.keys())) {
      if (d < cutoffDate) this.dailyByUpstreamModel.delete(d);
    }
  }

  getRecent(opts?: {
    limit?: number;
    sinceTs?: number;
    providerId?: string;
    upstreamId?: string;
    model?: string;
    status?: AvailabilityMetricStatus;
  }): AvailabilityMetricRecord[] {
    const limit = clampInt(Number(opts?.limit ?? 200), 1, 5000);
    const sinceTs = Number.isFinite(Number(opts?.sinceTs)) ? Math.floor(Number(opts?.sinceTs)) : 0;
    const providerId = normId(opts?.providerId);
    const upstreamId = normId(opts?.upstreamId);
    const model = normId(opts?.model);
    const status = opts?.status === "error" ? "error" : opts?.status === "ok" ? "ok" : "";

    const out: AvailabilityMetricRecord[] = [];
    for (const r of this.recent) {
      if (sinceTs && r.ts <= sinceTs) continue;
      if (providerId && r.providerId !== providerId) continue;
      if (upstreamId && r.upstreamId !== upstreamId) continue;
      if (model && r.model !== model) continue;
      if (status && r.status !== status) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  getOverview(opts?: { days?: number; groupBy?: "provider" | "upstream" | "model" | "upstream_model" }): {
    from: string;
    to: string;
    groupBy: "provider" | "upstream" | "model" | "upstream_model";
    totals: AvailabilityMetricAgg & { okRate: number; avgLatencyMs: number };
    groups: Array<{
      key: string;
      providerId?: string;
      upstreamId?: string;
      model?: string;
    } & AvailabilityMetricAgg & { okRate: number; avgLatencyMs: number }>;
    days: Array<
      {
        date: string;
        byGroup: Record<string, AvailabilityMetricAgg & { okRate: number; avgLatencyMs: number }>;
      } & AvailabilityMetricAgg & { okRate: number; avgLatencyMs: number }
    >;
  } {
    const days = clampInt(Number(opts?.days ?? 30), 1, 365);
    const groupBy =
      opts?.groupBy === "provider" || opts?.groupBy === "model" || opts?.groupBy === "upstream_model" ? opts.groupBy : "upstream";

    const to = dateKeyUtc(Date.now());
    const from = dateKeyUtc(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);

    const totalsBase = aggEmpty();
    const groupsAgg = new Map<string, AvailabilityMetricAgg>();
    const groupMeta = new Map<string, { providerId?: string; upstreamId?: string; model?: string }>();
    const byDay: Array<
      {
        date: string;
        byGroup: Record<string, AvailabilityMetricAgg & { okRate: number; avgLatencyMs: number }>;
      } & AvailabilityMetricAgg & { okRate: number; avgLatencyMs: number }
    > = [];

    const dateList = Array.from(this.dailyByUpstreamModel.keys())
      .filter((d) => d >= from && d <= to)
      .sort((a, b) => a.localeCompare(b));

    for (const date of dateList) {
      const dayBase = aggEmpty();
      const dayByGroupBase: Record<string, AvailabilityMetricAgg> = {};
      const m = this.dailyByUpstreamModel.get(date) || new Map<string, AvailabilityMetricAgg>();
      for (const [k, a] of m.entries()) {
        const [providerId, upstreamId, model] = k.split("::");
        const gKey =
          groupBy === "provider"
            ? providerId
            : groupBy === "model"
              ? model || ""
              : groupBy === "upstream_model"
                ? `${providerId}/${upstreamId || providerId}:${model || ""}`
                : `${providerId}/${upstreamId || providerId}`;

        dayByGroupBase[gKey] = addAgg(dayByGroupBase[gKey] || aggEmpty(), a);
        groupsAgg.set(gKey, addAgg(groupsAgg.get(gKey) || aggEmpty(), a));

        if (!groupMeta.has(gKey)) {
          groupMeta.set(gKey, {
            ...(groupBy === "provider" ? { providerId } : null),
            ...(groupBy === "upstream" || groupBy === "upstream_model" ? { providerId, upstreamId: upstreamId || providerId } : null),
            ...(groupBy === "model" || groupBy === "upstream_model" ? { model: model || "" } : null),
          });
        }

        dayBase.requests += a.requests;
        dayBase.ok += a.ok;
        dayBase.error += a.error;
        dayBase.latencyMsSum += a.latencyMsSum;
        dayBase.latencyMsCount += a.latencyMsCount;
      }

      totalsBase.requests += dayBase.requests;
      totalsBase.ok += dayBase.ok;
      totalsBase.error += dayBase.error;
      totalsBase.latencyMsSum += dayBase.latencyMsSum;
      totalsBase.latencyMsCount += dayBase.latencyMsCount;

      const dayByGroup: Record<string, AvailabilityMetricAgg & { okRate: number; avgLatencyMs: number }> = {};
      for (const [gk, ga] of Object.entries(dayByGroupBase)) {
        dayByGroup[gk] = { ...ga, okRate: okRate(ga), avgLatencyMs: avgLatencyMs(ga) };
      }
      byDay.push({ date, ...dayBase, okRate: okRate(dayBase), avgLatencyMs: avgLatencyMs(dayBase), byGroup: dayByGroup });
    }

    const groups = Array.from(groupsAgg.entries())
      .map(([key, a]) => {
        const meta = groupMeta.get(key) || {};
        return { key, ...meta, ...a, okRate: okRate(a), avgLatencyMs: avgLatencyMs(a) };
      })
      .sort((a, b) => b.requests - a.requests);

    return {
      from,
      to,
      groupBy,
      totals: { ...totalsBase, okRate: okRate(totalsBase), avgLatencyMs: avgLatencyMs(totalsBase) },
      groups,
      days: byDay,
    };
  }

  exportState(): AvailabilityMetricsPersistedStateV1 {
    const daily: Record<string, Record<string, AvailabilityMetricAgg>> = {};
    for (const [date, m] of this.dailyByUpstreamModel.entries()) {
      const obj: Record<string, AvailabilityMetricAgg> = {};
      for (const [k, a] of m.entries()) obj[k] = a;
      daily[date] = obj;
    }
    return { v: 1, recent: this.recent.slice(0, this.maxRecent), daily };
  }

  importState(state: unknown): void {
    const s = state && typeof state === "object" ? (state as any) : null;
    if (!s || Number(s.v) !== 1) return;

    const nextRecent: AvailabilityMetricRecord[] = Array.isArray(s.recent) ? (s.recent as any[]).filter((x) => x && typeof x === "object") : [];
    this.recent = nextRecent.slice(0, this.maxRecent) as any;

    const dailyRaw = s.daily && typeof s.daily === "object" ? (s.daily as any) : null;
    const nextDaily = new Map<string, Map<string, AvailabilityMetricAgg>>();
    if (dailyRaw) {
      for (const [date, v] of Object.entries(dailyRaw)) {
        if (typeof date !== "string" || !date) continue;
        const dayObj = v && typeof v === "object" ? (v as any) : null;
        if (!dayObj) continue;
        const mm = new Map<string, AvailabilityMetricAgg>();
        for (const [k, a] of Object.entries(dayObj)) {
          if (typeof k !== "string" || !k) continue;
          const aa = a && typeof a === "object" ? (a as any) : null;
          if (!aa) continue;
          mm.set(k, {
            requests: Number.isFinite(Number(aa.requests)) ? Math.max(0, Math.floor(Number(aa.requests))) : 0,
            ok: Number.isFinite(Number(aa.ok)) ? Math.max(0, Math.floor(Number(aa.ok))) : 0,
            error: Number.isFinite(Number(aa.error)) ? Math.max(0, Math.floor(Number(aa.error))) : 0,
            latencyMsSum: Number.isFinite(Number(aa.latencyMsSum)) ? Math.max(0, Math.floor(Number(aa.latencyMsSum))) : 0,
            latencyMsCount: Number.isFinite(Number(aa.latencyMsCount)) ? Math.max(0, Math.floor(Number(aa.latencyMsCount))) : 0,
          });
        }
        if (mm.size) nextDaily.set(date, mm);
      }
    }
    this.dailyByUpstreamModel = nextDaily;
    this.prune();
  }
}

export const availabilityMetrics = new AvailabilityMetricsStore();

export function availabilityMetricsErrorResponse(message: string, code = "not_found"): any {
  return jsonError(message, code);
}

import { jsonError } from "./common";

export type UsageTokens = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
};

export type TokenMetricStatus = "ok" | "error";

export type TokenMetricRecord = {
  ts: number;
  reqId: string;
  path: string;
  stream: boolean;
  providerId: string;
  upstreamId: string;
  model: string;
  status: TokenMetricStatus;
  latencyMs?: number;
  usage?: UsageTokens;
};

export type TokenMetricAgg = {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
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

function normalizeUsageTokens(raw: unknown): UsageTokens | null {
  const u = raw && typeof raw === "object" ? (raw as any) : null;
  if (!u) return null;

  const prompt = Number.isFinite(Number(u.prompt_tokens)) ? Math.max(0, Math.floor(Number(u.prompt_tokens))) : 0;
  const completion = Number.isFinite(Number(u.completion_tokens)) ? Math.max(0, Math.floor(Number(u.completion_tokens))) : 0;
  const total = Number.isFinite(Number(u.total_tokens)) ? Math.max(0, Math.floor(Number(u.total_tokens))) : prompt + completion;

  const cachedRaw =
    u.cached_tokens ??
    u.prompt_tokens_details?.cached_tokens ??
    u.input_tokens_details?.cached_tokens ??
    u.cache_read_input_tokens ??
    u.cacheReadInputTokens;
  const cached = Number.isFinite(Number(cachedRaw)) ? Math.max(0, Math.floor(Number(cachedRaw))) : 0;

  if (!(prompt || completion || total || cached)) return null;
  const out: UsageTokens = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
  if (cached) out.cached_tokens = cached;
  return out;
}

function normalizeGeminiUsageMetadataToUsageTokens(raw: unknown): UsageTokens | null {
  const u = raw && typeof raw === "object" ? (raw as any) : null;
  if (!u) return null;
  const prompt = Number.isFinite(Number(u.promptTokenCount)) ? Math.max(0, Math.floor(Number(u.promptTokenCount))) : 0;
  const completion = Number.isFinite(Number(u.responseTokenCount))
    ? Math.max(0, Math.floor(Number(u.responseTokenCount)))
    : Number.isFinite(Number(u.candidatesTokenCount))
      ? Math.max(0, Math.floor(Number(u.candidatesTokenCount)))
      : 0;
  const total = Number.isFinite(Number(u.totalTokenCount)) ? Math.max(0, Math.floor(Number(u.totalTokenCount))) : prompt + completion;
  const cached = Number.isFinite(Number(u.cachedContentTokenCount)) ? Math.max(0, Math.floor(Number(u.cachedContentTokenCount))) : 0;
  if (!(prompt || completion || total || cached)) return null;
  const out: UsageTokens = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
  if (cached) out.cached_tokens = cached;
  return out;
}

function extractUsageTokensFromJsonLike(obj: unknown): UsageTokens | null {
  const root = obj && typeof obj === "object" ? (obj as any) : null;
  if (!root) return null;

  const direct = normalizeUsageTokens(root.usage);
  if (direct) return direct;

  const responsesUsage = normalizeUsageTokens(root.response?.usage);
  if (responsesUsage) return responsesUsage;

  const anthropicUsage = normalizeUsageTokens(root.message?.usage ?? root.usage);
  if (anthropicUsage) return anthropicUsage;

  const geminiUsage = normalizeGeminiUsageMetadataToUsageTokens(root.usageMetadata);
  if (geminiUsage) return geminiUsage;

  return null;
}

function parseSseMessages(text: string): Array<{ data: string }> {
  const out: Array<{ data: string }> = [];
  let buf = "";
  const pushBlock = (block: string) => {
    const lines = block.split(/\r?\n/);
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    out.push({ data: dataLines.join("\n") });
  };

  buf = String(text || "");
  const blocks = buf.split(/\n\n/);
  for (const b of blocks) {
    const trimmed = b.trimEnd();
    if (!trimmed) continue;
    pushBlock(trimmed);
  }
  return out;
}

export class TokenMetricsStore {
  private recent: TokenMetricRecord[] = [];
  private dailyByUpstream = new Map<string, Map<string, TokenMetricAgg>>();
  private readonly maxRecent: number;
  private readonly retentionDays: number;

  constructor(opts?: { maxRecent?: number; retentionDays?: number }) {
    this.maxRecent = clampInt(Number(opts?.maxRecent ?? 800), 50, 20000);
    this.retentionDays = clampInt(Number(opts?.retentionDays ?? 60), 1, 3650);
  }

  record(rec: TokenMetricRecord): void {
    const r: TokenMetricRecord = {
      ts: Number.isFinite(rec.ts) ? Math.floor(rec.ts) : Date.now(),
      reqId: String(rec.reqId || ""),
      path: String(rec.path || ""),
      stream: Boolean(rec.stream),
      providerId: String(rec.providerId || ""),
      upstreamId: String(rec.upstreamId || ""),
      model: String(rec.model || ""),
      status: rec.status === "error" ? "error" : "ok",
      ...(Number.isFinite(Number(rec.latencyMs)) ? { latencyMs: Math.max(0, Math.floor(Number(rec.latencyMs))) } : {}),
      ...(rec.usage ? { usage: rec.usage } : {}),
    };

    this.recent.unshift(r);
    if (this.recent.length > this.maxRecent) this.recent.length = this.maxRecent;

    const date = dateKeyUtc(r.ts);
    const groupKey = `${r.providerId}::${r.upstreamId || r.providerId || "unknown"}`;
    const byGroup = this.dailyByUpstream.get(date) || new Map<string, TokenMetricAgg>();
    const prev =
      byGroup.get(groupKey) ||
      ({
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
      } satisfies TokenMetricAgg);

    const usage = r.usage;
    const prompt = usage ? usage.prompt_tokens : 0;
    const completion = usage ? usage.completion_tokens : 0;
    const total = usage ? usage.total_tokens : 0;
    const cached = usage && typeof usage.cached_tokens === "number" ? usage.cached_tokens : 0;

    byGroup.set(groupKey, {
      requests: prev.requests + 1,
      promptTokens: prev.promptTokens + prompt,
      completionTokens: prev.completionTokens + completion,
      totalTokens: prev.totalTokens + total,
      cachedTokens: prev.cachedTokens + cached,
    });
    this.dailyByUpstream.set(date, byGroup);

    this.prune();
  }

  private prune(): void {
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    const cutoffDate = dateKeyUtc(cutoff);
    for (const d of Array.from(this.dailyByUpstream.keys())) {
      if (d < cutoffDate) this.dailyByUpstream.delete(d);
    }
    // recent is bounded by maxRecent, no need to prune by time.
  }

  getRecent(opts?: { limit?: number; sinceTs?: number; providerId?: string; upstreamId?: string }): TokenMetricRecord[] {
    const limit = clampInt(Number(opts?.limit ?? 200), 1, 2000);
    const sinceTs = Number.isFinite(Number(opts?.sinceTs)) ? Math.floor(Number(opts?.sinceTs)) : 0;
    const providerId = typeof opts?.providerId === "string" ? opts.providerId.trim() : "";
    const upstreamId = typeof opts?.upstreamId === "string" ? opts.upstreamId.trim() : "";

    const out: TokenMetricRecord[] = [];
    for (const r of this.recent) {
      if (sinceTs && r.ts <= sinceTs) continue;
      if (providerId && r.providerId !== providerId) continue;
      if (upstreamId && r.upstreamId !== upstreamId) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  getOverview(opts?: { days?: number; groupBy?: "provider" | "upstream" }): {
    from: string;
    to: string;
    totals: TokenMetricAgg;
    groups: Array<{ key: string; providerId: string; upstreamId?: string } & TokenMetricAgg>;
    days: Array<{ date: string } & TokenMetricAgg & { byGroup: Record<string, TokenMetricAgg> }>;
  } {
    const days = clampInt(Number(opts?.days ?? 30), 1, 365);
    const groupBy = opts?.groupBy === "provider" ? "provider" : "upstream";

    const to = dateKeyUtc(Date.now());
    const from = dateKeyUtc(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);

    const totals: TokenMetricAgg = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };
    const groupsAgg = new Map<string, { key: string; providerId: string; upstreamId?: string } & TokenMetricAgg>();
    const byDay: Array<{ date: string } & TokenMetricAgg & { byGroup: Record<string, TokenMetricAgg> }> = [];

    const dateList = Array.from(this.dailyByUpstream.keys())
      .filter((d) => d >= from && d <= to)
      .sort((a, b) => a.localeCompare(b));

    for (const date of dateList) {
      const dayAgg: TokenMetricAgg = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };
      const dayByGroup: Record<string, TokenMetricAgg> = {};

      const m = this.dailyByUpstream.get(date) || new Map<string, TokenMetricAgg>();
      for (const [k, a] of m.entries()) {
        const [providerId, upstreamId] = k.split("::");
        const groupKey = groupBy === "provider" ? providerId : `${providerId}/${upstreamId || providerId}`;

        const prevDay = dayByGroup[groupKey] || { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };
        dayByGroup[groupKey] = {
          requests: prevDay.requests + a.requests,
          promptTokens: prevDay.promptTokens + a.promptTokens,
          completionTokens: prevDay.completionTokens + a.completionTokens,
          totalTokens: prevDay.totalTokens + a.totalTokens,
          cachedTokens: prevDay.cachedTokens + a.cachedTokens,
        };

        dayAgg.requests += a.requests;
        dayAgg.promptTokens += a.promptTokens;
        dayAgg.completionTokens += a.completionTokens;
        dayAgg.totalTokens += a.totalTokens;
        dayAgg.cachedTokens += a.cachedTokens;

        const prevGroup =
          groupsAgg.get(groupKey) ||
          ({
            key: groupKey,
            providerId,
            ...(groupBy === "upstream" ? { upstreamId: upstreamId || providerId } : {}),
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cachedTokens: 0,
          } as any);
        prevGroup.requests += a.requests;
        prevGroup.promptTokens += a.promptTokens;
        prevGroup.completionTokens += a.completionTokens;
        prevGroup.totalTokens += a.totalTokens;
        prevGroup.cachedTokens += a.cachedTokens;
        groupsAgg.set(groupKey, prevGroup);
      }

      totals.requests += dayAgg.requests;
      totals.promptTokens += dayAgg.promptTokens;
      totals.completionTokens += dayAgg.completionTokens;
      totals.totalTokens += dayAgg.totalTokens;
      totals.cachedTokens += dayAgg.cachedTokens;

      byDay.push({ date, ...dayAgg, byGroup: dayByGroup });
    }

    const groups = Array.from(groupsAgg.values()).sort((a, b) => b.totalTokens - a.totalTokens);

    return { from, to, totals, groups, days: byDay };
  }
}

export const tokenMetrics = new TokenMetricsStore();

export function tokenMetricsErrorResponse(message: string, code = "not_found"): any {
  return jsonError(message, code);
}

export async function instrumentResponseAndRecordTokens(
  resp: Response,
  ctx: Omit<TokenMetricRecord, "status"> & { status?: TokenMetricStatus },
): Promise<Response> {
  const base: Omit<TokenMetricRecord, "status"> = {
    ts: ctx.ts,
    reqId: ctx.reqId,
    path: ctx.path,
    stream: ctx.stream,
    providerId: ctx.providerId,
    upstreamId: ctx.upstreamId,
    model: ctx.model,
    ...(typeof ctx.latencyMs === "number" ? { latencyMs: ctx.latencyMs } : {}),
    ...(ctx.usage ? { usage: ctx.usage } : {}),
  };

  const status: TokenMetricStatus = ctx.status === "error" ? "error" : resp && !resp.ok ? "error" : "ok";
  const startedAt = Number.isFinite(Number(ctx.ts)) ? Number(ctx.ts) : Date.now();

  const contentType = (resp.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    let usage: UsageTokens | null = null;
    try {
      const cloned = resp.clone();
      const obj = await cloned.json().catch(() => null);
      usage = extractUsageTokensFromJsonLike(obj);
    } catch {
      usage = null;
    }
    tokenMetrics.record({
      ...base,
      status,
      latencyMs: Math.max(0, Date.now() - startedAt),
      ...(usage ? { usage } : {}),
    });
    return resp;
  }

  if (contentType.includes("text/event-stream") && resp.body) {
    const src = resp.body;
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let lastUsage: UsageTokens | null = null;

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    (async () => {
      const reader = src.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            await writer.write(value);
            buffer += decoder.decode(value, { stream: true });
            const idx = buffer.lastIndexOf("\n\n");
            if (idx < 0) continue;
            const chunk = buffer.slice(0, idx + 2);
            buffer = buffer.slice(idx + 2);
            for (const msg of parseSseMessages(chunk)) {
              const data = msg.data;
              if (!data || data === "[DONE]") continue;
              let obj: unknown = null;
              try {
                obj = JSON.parse(data);
              } catch {
                continue;
              }
              const u = extractUsageTokensFromJsonLike(obj);
              if (u) lastUsage = u;
            }
          }
        }
      } catch {
        // ignore; will still record at end
      } finally {
        try {
          await writer.close();
        } catch {}
        try {
          reader.releaseLock();
        } catch {}
        tokenMetrics.record({
          ...base,
          status,
          latencyMs: Math.max(0, Date.now() - startedAt),
          ...(lastUsage ? { usage: lastUsage } : {}),
        });
      }
    })();

    const headers = new Headers(resp.headers);
    return new Response(readable, { status: resp.status, headers });
  }

  tokenMetrics.record({
    ...base,
    status,
    latencyMs: Math.max(0, Date.now() - startedAt),
  });
  return resp;
}

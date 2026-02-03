import { joinUrls, jsonError, jsonResponse, normalizeAuthValue, parseBoolEnv, parseUpstreamCustomHeaders } from "./common";
import type { Env } from "./common";
import type { GatewayConfig, ModelConfig, ProviderConfig } from "./config";
import { handleClaudeChatCompletions } from "./providers/claude";
import { handleGeminiChatCompletions } from "./providers/gemini";
import { handleOpenAIChatCompletionsUpstream, handleOpenAIRequest } from "./providers/openai";
import { listUpstreamCandidates, shouldTryNextUpstreamCandidateStatus } from "./upstreams";
import { instrumentResponseAndRecordTokens } from "./metrics";

function envWithOverrides(env: Env, overrides: Record<string, string> | null): Env {
  const base = env && typeof env === "object" ? env : {};
  return { ...base, ...(overrides && typeof overrides === "object" ? overrides : {}) };
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || (typeof v === "string" && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase()));
}

function pickNumber(...values: unknown[]): number | null {
  for (const v of values) {
    if (v == null) continue;
    const n = typeof v === "number" ? v : Number(String(v));
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return null;
}

export async function dispatchOpenAIChatToProvider({
  request,
  env,
  config,
  provider,
  model,
  reqJson,
  stream,
  token,
  debug,
  reqId,
  path,
  startedAt,
  extraSystemText,
}: {
  request: Request;
  env: Env;
  config: GatewayConfig;
  provider: ProviderConfig;
  model: ModelConfig;
  reqJson: Record<string, unknown>;
  stream: boolean;
  token: string;
  debug: boolean;
  reqId: string;
  path?: string;
  startedAt?: number;
  extraSystemText: string;
}): Promise<Response> {
  const metricsEnabled = parseBoolEnv((env as any)?.RSP4COPILOT_TOKEN_STATS_ENABLED) || parseBoolEnv((env as any)?.WEB_UI_ENABLED);

  const upstreamCandidates = listUpstreamCandidates({ env, provider, request, reqId });
  if (!upstreamCandidates.length) {
    return jsonResponse(500, jsonError(`Server misconfigured: missing upstream API key for provider ${provider.id}`, "server_error"));
  }

  const inheritedCustomHeaders = parseUpstreamCustomHeaders(env);
  const providerApiMode = typeof provider.apiMode === "string" ? provider.apiMode.trim() : "";

  let lastResp: Response | null = null;
  for (let i = 0; i < upstreamCandidates.length; i++) {
    const upstream = upstreamCandidates[i];
    const apiKey = upstream.apiKey;
    const upstreamHeaders =
      upstream.customHeader && Object.keys(upstream.customHeader).length ? { ...inheritedCustomHeaders, ...upstream.customHeader } : null;
    const upstreamHeadersEnv =
      upstreamHeaders && Object.keys(upstreamHeaders).length ? JSON.stringify(upstreamHeaders) : "";

    if (providerApiMode === "openai-responses") {
      const quirks = upstream.quirks || {};
      const providerOpts = upstream.options || {};
      const modelOpts = model?.options || {};
      const responsesPath =
        (upstream.endpoints && typeof (upstream.endpoints as any).responsesPath === "string" && String((upstream.endpoints as any).responsesPath).trim()) ||
        (upstream.endpoints && typeof (upstream.endpoints as any).responses_path === "string" && String((upstream.endpoints as any).responses_path).trim()) ||
        "";

      const upstreamUrls = joinUrls(upstream.baseURLs);
      const noInstructionsUrls = truthy((quirks as any).noInstructions) ? upstreamUrls : "";
      const noPrevUrls = truthy((quirks as any).noPreviousResponseId) ? upstreamUrls : "";
      const reasoningEffort = typeof (modelOpts as any).reasoningEffort === "string" ? String((modelOpts as any).reasoningEffort).trim() : "";
      const maxInstructionsChars = pickNumber((modelOpts as any).maxInstructionsChars, (providerOpts as any).maxInstructionsChars);

      const env2 = envWithOverrides(env, {
        OPENAI_BASE_URL: upstreamUrls,
        OPENAI_API_KEY: apiKey,
        ...(upstreamHeadersEnv ? { RSP4COPILOT_UPSTREAM_HEADERS: upstreamHeadersEnv } : null),
        ...(responsesPath ? { RESP_RESPONSES_PATH: responsesPath } : null),
        ...(noInstructionsUrls ? { RESP_NO_INSTRUCTIONS_URLS: noInstructionsUrls } : null),
        ...(noPrevUrls ? { RESP_NO_PREVIOUS_RESPONSE_ID_URLS: noPrevUrls } : null),
        ...(reasoningEffort ? { RESP_REASONING_EFFORT: reasoningEffort } : null),
        ...(maxInstructionsChars != null ? { RESP_MAX_INSTRUCTIONS_CHARS: String(maxInstructionsChars) } : null),
      });

      const resp0 = await handleOpenAIRequest({
        request,
        env: env2,
        reqJson,
        model: model.upstreamModel,
        stream,
        token: normalizeAuthValue(token),
        debug,
        reqId,
        path: typeof path === "string" ? path : "",
        startedAt: typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : Date.now(),
        isTextCompletions: false,
        extraSystemText,
      });

      const shouldStop = resp0.ok || !shouldTryNextUpstreamCandidateStatus(resp0.status) || i === upstreamCandidates.length - 1;
      const resp = metricsEnabled && shouldStop
        ? await instrumentResponseAndRecordTokens(resp0, {
            ts: typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : Date.now(),
            reqId,
            path: typeof path === "string" ? path : "",
            stream,
            providerId: provider.id,
            upstreamId: upstream.id || provider.id,
            model: model.name || model.upstreamModel,
          })
        : resp0;

      lastResp = resp;
      if (resp.ok) return resp;
      if (shouldStop) return resp;
      continue;
    }

    if (providerApiMode === "openai-chat-completions") {
      const providerOpts = upstream.options || {};
      const modelOpts = model?.options || {};
      const chatCompletionsPath =
        (upstream.endpoints &&
          typeof (upstream.endpoints as any).chatCompletionsPath === "string" &&
          String((upstream.endpoints as any).chatCompletionsPath).trim()) ||
        (upstream.endpoints &&
          typeof (upstream.endpoints as any).chat_completions_path === "string" &&
          String((upstream.endpoints as any).chat_completions_path).trim()) ||
        "";
      const maxInstructionsChars = pickNumber((modelOpts as any).maxInstructionsChars, (providerOpts as any).maxInstructionsChars);

      const env2 = envWithOverrides(env, {
        OPENAI_BASE_URL: joinUrls(upstream.baseURLs),
        OPENAI_API_KEY: apiKey,
        ...(upstreamHeadersEnv ? { RSP4COPILOT_UPSTREAM_HEADERS: upstreamHeadersEnv } : null),
        ...(chatCompletionsPath ? { OPENAI_CHAT_COMPLETIONS_PATH: chatCompletionsPath } : null),
        ...(maxInstructionsChars != null ? { RESP_MAX_INSTRUCTIONS_CHARS: String(maxInstructionsChars) } : null),
      });

      const resp0 = await handleOpenAIChatCompletionsUpstream({
        request,
        env: env2,
        reqJson,
        model: model.upstreamModel,
        stream,
        token: normalizeAuthValue(token),
        debug,
        reqId,
        path: typeof path === "string" ? path : "",
        startedAt: typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : Date.now(),
        extraSystemText,
      });

      const shouldStop = resp0.ok || !shouldTryNextUpstreamCandidateStatus(resp0.status) || i === upstreamCandidates.length - 1;
      const resp = metricsEnabled && shouldStop
        ? await instrumentResponseAndRecordTokens(resp0, {
            ts: typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : Date.now(),
            reqId,
            path: typeof path === "string" ? path : "",
            stream,
            providerId: provider.id,
            upstreamId: upstream.id || provider.id,
            model: model.name || model.upstreamModel,
          })
        : resp0;

      lastResp = resp;
      if (resp.ok) return resp;
      if (shouldStop) return resp;
      continue;
    }

    if (providerApiMode === "claude") {
      const providerOpts = upstream.options || {};
      const modelOpts = model?.options || {};
      const messagesPath =
        upstream.endpoints && typeof (upstream.endpoints as any).messagesPath === "string" ? String((upstream.endpoints as any).messagesPath).trim() : "";
      const claudeMaxTokens = pickNumber(
        (modelOpts as any).maxTokens,
        (modelOpts as any).maxOutputTokens,
        (providerOpts as any).maxTokens,
        (providerOpts as any).maxOutputTokens,
      );
      const env2 = envWithOverrides(env, {
        CLAUDE_BASE_URL: joinUrls(upstream.baseURLs),
        CLAUDE_API_KEY: apiKey,
        ...(upstreamHeadersEnv ? { RSP4COPILOT_UPSTREAM_HEADERS: upstreamHeadersEnv } : null),
        ...(messagesPath ? { CLAUDE_MESSAGES_PATH: messagesPath } : null),
        ...(claudeMaxTokens != null ? { CLAUDE_MAX_TOKENS: String(claudeMaxTokens) } : null),
      });

      const resp0 = await handleClaudeChatCompletions({
        request,
        env: env2,
        reqJson,
        model: model.upstreamModel,
        stream,
        debug,
        reqId,
        extraSystemText,
      });

      const shouldStop = resp0.ok || !shouldTryNextUpstreamCandidateStatus(resp0.status) || i === upstreamCandidates.length - 1;
      const resp = metricsEnabled && shouldStop
        ? await instrumentResponseAndRecordTokens(resp0, {
            ts: typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : Date.now(),
            reqId,
            path: typeof path === "string" ? path : "",
            stream,
            providerId: provider.id,
            upstreamId: upstream.id || provider.id,
            model: model.name || model.upstreamModel,
          })
        : resp0;

      lastResp = resp;
      if (resp.ok) return resp;
      if (shouldStop) return resp;
      continue;
    }

    if (providerApiMode === "gemini") {
      const env2 = envWithOverrides(env, {
        GEMINI_BASE_URL: joinUrls(upstream.baseURLs),
        GEMINI_API_KEY: apiKey,
        ...(upstreamHeadersEnv ? { RSP4COPILOT_UPSTREAM_HEADERS: upstreamHeadersEnv } : null),
      });

      const resp0 = await handleGeminiChatCompletions({
        request,
        env: env2,
        reqJson,
        model: model.upstreamModel,
        stream,
        token: normalizeAuthValue(token),
        debug,
        reqId,
        extraSystemText,
      });

      const shouldStop = resp0.ok || !shouldTryNextUpstreamCandidateStatus(resp0.status) || i === upstreamCandidates.length - 1;
      const resp = metricsEnabled && shouldStop
        ? await instrumentResponseAndRecordTokens(resp0, {
            ts: typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : Date.now(),
            reqId,
            path: typeof path === "string" ? path : "",
            stream,
            providerId: provider.id,
            upstreamId: upstream.id || provider.id,
            model: model.name || model.upstreamModel,
          })
        : resp0;

      lastResp = resp;
      if (resp.ok) return resp;
      if (shouldStop) return resp;
      continue;
    }

    return jsonResponse(500, jsonError(`Unsupported provider apiMode: ${providerApiMode}`, "server_error"));
  }

  return (
    lastResp ||
    jsonResponse(500, jsonError(`Server misconfigured: missing upstream API key for provider ${provider.id}`, "server_error"))
  );
}

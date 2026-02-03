# rsp4copilot (Cloudflare Worker)

在 Cloudflare Workers 上运行的 **LLM API 互转 / 路由网关**：同一套后端 provider 配置，同时暴露多种“前端协议”入口，方便 VS Code 等客户端按自己支持的协议接入。

主要用途：让 VS Code 的 [OAI Compatible Provider for Copilot](https://marketplace.visualstudio.com/items?itemName=nicepkg.oai-compatible-copilot) 插件可以使用 OpenAI Responses、Gemini、Claude 等上游（通过中转/Relay）。

友情推广：稳定靠谱codex中转: [rightcode](https://www.right.codes/register?aff=D71E64B0)
## 入口协议（多选）

- OpenAI Chat Completions：`POST /v1/chat/completions`
- OpenAI Responses：`POST /v1/responses`（兼容：`/responses`、`/openai/v1/responses`）
- Claude Messages：`POST /claude/v1/messages`、`POST /claude/v1/messages/count_tokens`
- Gemini：`POST /gemini/v1beta/models/{model}:generateContent`、`POST /gemini/v1beta/models/{model}:streamGenerateContent?alt=sse`

## 模型列表

- OpenAI 风格：`GET /v1/models`（同样支持 `/openai/v1/models`、`/claude/v1/models`、`/models`）
- Gemini 风格：`GET /gemini/v1beta/models`

## 统一模型命名（配置驱动）

请求里的 `model` 支持两种写法：
- **短 ID**：直接写 `modelName`（推荐；前提是该名字在所有 provider 里唯一）
- **完整 ID**：写 `providerId.modelName`（显式指定 provider；当短 ID 有歧义时使用）

如果客户端会额外发送 provider 信息，本 Worker 也会尽量识别：
- JSON body 字段：`provider` / `owned_by` / `ownedBy`
- Gemini 兼容：`?provider=`（或 `?owned_by=`）

## 入站鉴权（必须）

所有请求都需要携带你的 Worker 访问密钥（不是上游模型 key）：
- Worker 侧配置：`WORKER_AUTH_KEY` 或 `WORKER_AUTH_KEYS`（逗号分隔）
- 客户端传递方式：
  - `Authorization: Bearer <key>` 或 `Authorization: <key>`
  - `x-api-key: <key>`
  - Gemini 兼容：`x-goog-api-key: <key>` 或 `?key=<key>`（仅当路径以 `/gemini/` 开头）
  - Claude 兼容：`anthropic-api-key: <key>` / `x-anthropic-api-key: <key>`

## 额外安全（可选）

- IP 白名单：设置 `WORKER_ALLOWED_IPS`（逗号分隔；支持 IPv4 CIDR，如 `10.0.0.0/8`），只有来自白名单的请求才会被处理。
- 若在反代后面取真实客户端 IP：再设置 `WORKER_TRUST_PROXY_HEADERS=true`，将使用 `X-Forwarded-For` / `X-Real-IP` 等头部解析来源 IP。
- 内置 Web UI：设置 `WEB_UI_ENABLED=true`，并配置 `WEB_UI_BASIC_USER`/`WEB_UI_BASIC_PASS`（HTTP Basic Auth），访问 `GET /`（或 `/ui`）即可打开一个简单的自检/调试页面。
- Web UI 免填入口 Key（Docker/Node）：页面会优先通过 `/ui/api/*` 由服务端代发网关请求并自动注入 `WORKER_AUTH_KEY`；只有在未检测到该代理时，才需要在页面里手动填入口 Key。
- Web UI 在线编辑配置文件（Docker）：设置 `WEB_UI_CONFIG_WRITE=true` 后，可在页面里通过 `/admin/api/config` 读取/保存 `RSP4COPILOT_CONFIG_FILE`（强烈建议仅在内网/反代鉴权后使用）。
- Web UI 查看密钥（Docker）：设置 `WEB_UI_SECRETS_VIEW=true` 后，可在页面里通过 `/admin/api/secrets` 查看上游/下游 key（默认脱敏；若要明文再设 `WEB_UI_SECRETS_REVEAL=true`；强烈建议仅在内网/反代鉴权后使用）。
- Web UI 修改上游 key（Docker）：设置 `WEB_UI_SECRETS_VIEW=true` + `WEB_UI_SECRETS_WRITE=true` 后，可在页面里通过 `/admin/api/upstream_keys` 写入上游环境变量；默认写入 `RSP4COPILOT_ENV_FILE`（见 `docker-compose.yml`，默认 `/config/rsp4copilot.env`）。

## 配置（RSP4COPILOT_CONFIG）

唯一必需的网关配置是 `RSP4COPILOT_CONFIG`（JSON/JSONC 字符串）。

> 注意：Worker 运行时只读取环境变量，不会从仓库读取 `configs/*.jsonc`；配置里的 `baseURL` 是「上游地址」（不要填本 Worker 的对外地址，否则会自我转发形成循环）。

示例见：
- `.dev.vars.example`
- `wrangler.toml.example`
- `configs/rsp4copilot.config.example.jsonc`
- Web UI 字段说明：`docs/WEB_UI_GUIDE.md`

### RSP4COPILOT_CONFIG 示例（单一 OpenAI Responses 上游）

```jsonc
{
  "version": 1,
  "providers": {
    "openai": {
      "apiMode": "openai-responses",
      "baseURL": "https://your-relay.example/openai",
      "apiKey": "REPLACE_ME",
      // 可选：自动从上游拉取 GET /v1/models，并缓存一段时间（用于前端下拉框/免手写模型名）
      "discoverModels": true,
      "discoverModelsTtlSeconds": 300,
      "quirks": {
        "noInstructions": false,
        "noPreviousResponseId": false
      },
      // 可选：显式映射“对外模型名” -> “上游真实模型名”（需要改名/加默认 options 时才需要）
      "models": { "gpt-5.2": { "upstreamModel": "gpt-5.2" } }
    }
  }
}
```

### 常用 provider.apiMode

> 字段名兼容：推荐 `apiMode`，也支持 `api_mode` / `type`（旧配置兼容）。

- `openai-responses`：上游走 Responses API（支持 reasoning、tool calling、SSE 等）
- `openai-chat-completions`（或 `openai`）：上游走 Chat Completions API（`/v1/chat/completions`）
- `gemini`：上游走 Gemini `generateContent` / `streamGenerateContent`
- `claude`（或 `anthropic`）：上游走 Claude `/v1/messages`

## 多中转站聚合（upstreams）

如果你有多个第三方中转站（各自 `baseURL`/`apiKey` 不同），可以在同一个 provider 下配置 `upstreams[]`，并通过 `routing.strategy` 做聚合/分流与失败切换。

支持的 `routing.strategy`：
- `priority`：按 `upstreams` 顺序优先级（默认）
- `round_robin`：轮询
- `random`：随机（支持 weight）
- `hash`：基于 `x-session-id`（或 IP/reqId）的粘性分流（支持 weight）

示例（OpenAI Responses 上游，多中转站轮询）：

```jsonc
{
  "version": 1,
  "providers": {
    "openai": {
      "apiMode": "openai-responses",
      "routing": { "strategy": "round_robin" },
      "upstreams": [
        { "id": "relay-a", "baseURL": "https://relay-a.example/openai", "apiKeyEnv": "OPENAI_API_KEY_RELAY_A", "weight": 1 },
        { "id": "relay-b", "baseURL": "https://relay-b.example/openai", "apiKeyEnv": "OPENAI_API_KEY_RELAY_B", "weight": 1 }
      ],
      "models": {
        "gpt-5.2": { "upstreamModel": "gpt-5.2" }
      }
    }
  }
}
```

## 上游自定义 Header（customHeader）

部分中转站会套 Cloudflare/风控，需要带特定请求头。你可以在 **provider** 或 **upstream** 上配置 `customHeader`（键值对），网关请求上游时会自动附加：

```jsonc
{
  "customHeader": {
    "user-agent": "codex_cli_rs/0.79.0 (Windows 10.0.26100; x86_64) unknown",
    "originator": "codex_cli_rs"
  }
}
```

> 提示：即使你不配置，网关也会默认自动附加上述 `user-agent`/`originator`；如需改成别的值，使用 `customHeader` 覆盖即可。

## 本地运行（不部署）

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler dev --local --port 8788
```

## Docker 一键部署（自建公网服务器）

本仓库默认是 Cloudflare Worker，但也提供了一个 Node.js runtime 适配层，便于用 Docker 在公网服务器上部署（同一套路由/协议转换逻辑）。

```bash
cp .env.example .env
# 1) 修改 `.env`（至少填 WORKER_AUTH_KEY 与各 upstream key）
# 2) 复制并修改配置文件（baseURL / model / upstreams）
cp configs/rsp4copilot.config.example.jsonc configs/rsp4copilot.config.jsonc
${EDITOR:-vi} configs/rsp4copilot.config.jsonc
docker compose up -d --build
```

默认容器监听：`0.0.0.0:8788`；宿主机对外端口可用 `PUBLIC_PORT` 覆盖（见 `.env.example`）。健康检查：`GET /v1/health`。

## 快速 curl

OpenAI Chat:
```bash
curl -sS http://127.0.0.1:8788/v1/chat/completions \
  -H "Authorization: Bearer REPLACE_ME" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.2","messages":[{"role":"user","content":"hello"}]}'
```

OpenAI Responses:
```bash
curl -sS http://127.0.0.1:8788/v1/responses \
  -H "Authorization: Bearer REPLACE_ME" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.2","input":[{"role":"user","content":[{"type":"input_text","text":"hello"}]}]}'
```

Claude Messages:
```bash
curl -sS http://127.0.0.1:8788/claude/v1/messages \
  -H "Authorization: Bearer REPLACE_ME" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5-20250929","max_tokens":64,"messages":[{"role":"user","content":"hello"}]}'
```

Gemini streaming:
```bash
curl -N "http://127.0.0.1:8788/gemini/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse" \
  -H "x-goog-api-key: REPLACE_ME" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}'
```

## 在 VS Code Copilot 插件中使用

### settings.json 示例

> 重点：`id` 可以填短模型名（例如 `gpt-5.2`），并把 `WORKER_AUTH_KEY` 作为 API Key 填给插件。
> 若出现同名模型（有歧义），再改用 `providerId.modelName`。

```json
{
  "oaicopilot.baseUrl": "https://<your-worker-domain>/v1",
  "oaicopilot.models": [
    { "id": "gpt-5.2", "owned_by": "openai", "context_length": 200000, "max_tokens": 8192, "temperature": 0, "top_p": 1 }
  ]
}
```

### 配置 API Key

1. 打开 VS Code 命令面板（`Ctrl+Shift+P` / `Cmd+Shift+P`）
2. 运行：`OAICopilot: Set OAI Compatible Multi-Provider Apikey`
3. Provider 随便选（如 `openai`/`google`/`anthropic`），API Key 填 `WORKER_AUTH_KEY`

## 在 VS Code Continue 插件中使用

Continue 的 OpenAI provider 可能会直接调用 `POST /v1/responses`；本 Worker 已兼容该路由。

配置要点：
- `apiBase` 填本 Worker 的对外地址（建议 `https://<your-worker-domain>/v1`）
- `apiKey` 填 `WORKER_AUTH_KEY`（不是上游 key）
- `model` 填短模型名（如 `gpt-5.2` / `claude-sonnet-...` / `gemini-...`）

## Thinking/思维链（透传）

- OpenAI Responses：`/v1/responses` 会尽量保持 OpenAI Responses 的输出结构；当上游是非 Responses 协议时，会把 Chat Completions 的 `reasoning_content` 映射为 Responses 的 `type:"reasoning"` 输出项，并在 SSE 中发送 `response.reasoning_text.delta/done`，便于 oai-compatible-copilot 显示 Thinking。
- Gemini：当模型路由到 `apiMode: "gemini"` 的 provider 时，`/gemini/v1beta/models/...:streamGenerateContent?alt=sse` 会直接代理 Gemini 原生 SSE，保留 `thought: true` 的 thought summaries。

## Legacy

已移除无配置的前缀路由/旧环境变量方式；请设置 `RSP4COPILOT_CONFIG`。

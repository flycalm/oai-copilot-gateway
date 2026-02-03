# oai-copilot-gateway 公网服务器部署与使用指南（Docker）

> 说明：本项目核心是一个“多协议 LLM 网关/路由器”，对外提供 OpenAI/Claude/Gemini 兼容接口；对内可接一个或多个第三方中转站（relay）。
>
> 注意：这里说的 VS Code 接入，指能自定义 OpenAI Base URL 的插件（如 `OAI Compatible Provider for Copilot`），不是官方 GitHub Copilot 扩展。

---

## 1. 部署目标与架构

- 客户端（VS Code / Continue / 你的程序）
  - 访问：`https://<你的域名>/v1/...`
  - 鉴权：`WORKER_AUTH_KEY`（入口 Key，不是上游 Key）
- 你的公网服务器
  - Nginx/Caddy 反代（推荐） → Docker 容器（compose service 默认名 `rsp4copilot`，默认 `127.0.0.1:8788`）
- 上游/中转站（可多个）
  - 每个 upstream 配：`baseURL` + `apiKey`（或 `apiKeyEnv` 从环境变量取）

---

## 2. 服务器准备（Ubuntu 示例）

### 2.1 安装 Docker + Compose

按你的系统安装 Docker 与 `docker compose`（略）。

验证：

```bash
docker --version
docker compose version
```

### 2.2 防火墙（强烈建议）

如果你准备走反代 + HTTPS，只开放 80/443：

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

不建议直接对公网开放 8788；若不得不开放，请限制来源 IP。

---

## 3. 拉取代码

```bash
git clone <你的仓库地址> oai-copilot-gateway
cd oai-copilot-gateway
```

---

## 4. 配置（入口鉴权 + 上游聚合）

### 4.1 入口鉴权（必须）

复制并编辑环境变量文件：

```bash
cp .env.example .env
```

至少设置：

- `WORKER_AUTH_KEY=...`（客户端调用你服务器时用的 Key）
- 如果你在配置里用了 `apiKeyEnv`，也要在 `.env` 里补齐对应的上游 Key（例如 `OPENAI_API_KEY_RELAY_A`）

可选增强安全：

- `WORKER_ALLOWED_IPS=...`：IP 白名单（逗号分隔；支持 IPv4 CIDR，如 `10.0.0.0/8`）。建议配合防火墙/反代一起使用。
- `WORKER_TRUST_PROXY_HEADERS=true`：若你在反代（Nginx/Caddy）后面运行容器，并希望按 `X-Forwarded-For` / `X-Real-IP` 识别真实客户端 IP，可开启此项。
- `WEB_UI_ENABLED=true` + `WEB_UI_BASIC_USER/WEB_UI_BASIC_PASS`：启用内置 Web UI（`GET /` 或 `/ui`，HTTP Basic Auth 保护），用于健康检查与简单调试请求。
- `WEB_UI_CONFIG_WRITE=true`：允许 Web UI 通过 `/admin/api/config` 在线写入 `RSP4COPILOT_CONFIG_FILE`（高风险；只建议内网或强反代保护下启用）。
- `WEB_UI_SECRETS_VIEW=true`：允许 Web UI 通过 `/admin/api/secrets` 查看上游/下游 key（默认脱敏）。如需明文再加 `WEB_UI_SECRETS_REVEAL=true`（极高风险；只建议内网或强反代保护下启用）。
- `WEB_UI_SECRETS_WRITE=true`：允许 Web UI 通过 `/admin/api/upstream_keys` 修改配置中 `apiKeyEnv` 引用到的上游 key（写入 `RSP4COPILOT_ENV_FILE`，默认 `/config/rsp4copilot.env`；极高风险；只建议内网或强反代保护下启用）。

### 4.2 网关配置文件（JSONC）

复制并编辑：

```bash
cp configs/rsp4copilot.config.example.jsonc configs/rsp4copilot.config.jsonc
vi configs/rsp4copilot.config.jsonc
```

#### A) 单中转站（最简单）

在 provider 下使用：

- `baseURL`
- `apiKey` 或 `apiKeyEnv`

示例（OpenAI Responses 上游）：

```jsonc
{
  "version": 1,
  "providers": {
    "openai": {
      "apiMode": "openai-responses",
      "baseURL": "https://your-relay.example/openai",
      "apiKeyEnv": "OPENAI_API_KEY",
      "models": {
        "gpt-5.2": { "upstreamModel": "gpt-5.2" }
      }
    }
  }
}
```

#### B) 多中转站聚合（推荐）

在 provider 下使用：

- `routing.strategy`: `priority` / `round_robin` / `random` / `hash`
- `upstreams[]`: 每个 upstream 配自己的 `baseURL`、`apiKey/apiKeyEnv`、可选 `weight`

示例（轮询 + 失败切换）：

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

策略说明：

- `priority`：按 `upstreams` 顺序优先（默认）
- `round_robin`：轮询
- `random`：随机（按 `weight` 加权）
- `hash`：粘性分流（优先用 `x-session-id`，否则用 IP/reqId；按 `weight` 加权）

---

## 5. 启动（Docker Compose 一键）

```bash
docker compose up -d --build
docker compose ps
```

本地健康检查（在服务器上执行）：

```bash
curl -sS http://127.0.0.1:8788/v1/health \
  -H "Authorization: Bearer $WORKER_AUTH_KEY"
```

查看日志：

```bash
docker compose logs -f --tail=200
```

---

## 6. 建议：Nginx 反代 + HTTPS

将 `https://<你的域名>` 反代到 `http://127.0.0.1:8788`。

示例（只展示核心片段）：

```nginx
server {
  listen 80;
  server_name your.domain.com;

  location / {
    proxy_pass http://127.0.0.1:8788;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;

    # SSE/流式：建议关闭缓冲
    proxy_buffering off;
    proxy_read_timeout 3600;
  }
}
```

然后用 Certbot/ACME 配好 443（略）。

---

## 7. 使用指南（API）

### 7.1 鉴权方式

所有请求必须带入口 Key（`WORKER_AUTH_KEY`）之一：

- `Authorization: Bearer <key>`（推荐）
- `Authorization: <key>`
- `x-api-key: <key>`

> Gemini 兼容路径还支持 `?key=`，但不建议对公网使用 URL 传 Key。

### 7.2 模型命名规则

- 短名：`modelName`（全局唯一时推荐）
- 有重名：`providerId.modelName`

查看模型列表：

```bash
curl -sS https://your.domain.com/v1/models \
  -H "Authorization: Bearer $WORKER_AUTH_KEY"
```

### 7.3 OpenAI Chat Completions

`POST /v1/chat/completions`

```bash
curl -sS https://your.domain.com/v1/chat/completions \
  -H "Authorization: Bearer $WORKER_AUTH_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.2","messages":[{"role":"user","content":"hello"}]}'
```

### 7.4 OpenAI Responses

`POST /v1/responses`

```bash
curl -sS https://your.domain.com/v1/responses \
  -H "Authorization: Bearer $WORKER_AUTH_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.2","input":[{"role":"user","content":[{"type":"input_text","text":"hello"}]}]}'
```

### 7.5 Claude Messages（兼容入口）

`POST /claude/v1/messages`

```bash
curl -sS https://your.domain.com/claude/v1/messages \
  -H "Authorization: Bearer $WORKER_AUTH_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5-20250929","max_tokens":128,"messages":[{"role":"user","content":"hello"}]}'
```

### 7.6 Gemini（兼容入口）

`POST /gemini/v1beta/models/{model}:generateContent`

```bash
curl -sS https://your.domain.com/gemini/v1beta/models/gemini-3-pro-preview:generateContent \
  -H "x-goog-api-key: $WORKER_AUTH_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}'
```

---

## 8. VS Code 接入（OAI Compatible Provider for Copilot）

### 8.1 settings.json 示例

```json
{
  "oaicopilot.baseUrl": "https://your.domain.com/v1",
  "oaicopilot.models": [
    { "id": "gpt-5.2", "owned_by": "openai", "context_length": 200000, "max_tokens": 8192, "temperature": 0, "top_p": 1 }
  ]
}
```

- `baseUrl` 一定要以 `/v1` 结尾（对应 OpenAI 路由前缀）。
- `id` 填你 `/v1/models` 里看到的模型名；如果有歧义会显示成 `providerId.modelName`。

### 8.2 设置 API Key

在插件命令里设置 API key：填 `WORKER_AUTH_KEY`（入口 key，不是上游 key）。

---

## 9. 常见问题排查

- 401 Unauthorized：客户端没带 `WORKER_AUTH_KEY`，或 key 不对。
- 500 “missing RSP4COPILOT_CONFIG”：你没在容器里提供配置文件/环境变量。
  - 确认 `docker-compose.yml` 里 `RSP4COPILOT_CONFIG_FILE=/config/rsp4copilot.config.jsonc`
  - 确认 `configs/rsp4copilot.config.jsonc` 已存在且挂载成功
- 上游 4xx/5xx：多半是中转站 URL 路径不对或 key 没额度；多 upstream 时会自动尝试下一个（取决于错误码）。

---

## 10. 安全建议（务必看）

- 不要把 8788 直接暴露公网；用反代 + HTTPS。
- 不要在 URL 里传 key（尽量只用 `Authorization`/`x-api-key`）。
- `WORKER_AUTH_KEY` 建议使用长随机字符串，并定期轮换。
- 如果对外开放，建议再加一层 IP 白名单（只允许你自己的公网 IP 段）。

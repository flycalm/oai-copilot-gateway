# oai-copilot-gateway Web UI 使用说明

本文件解释 Web UI 页面上的各个模块/字段的含义、用途、推荐填写方式与示例（面向 Docker/Node 部署方式）。

> 重要：Web UI 的“配置写入 / 密钥查看 / 密钥修改”属于高风险能力。请尽量只在内网访问，或在 Nginx/Caddy 反代层再加一层鉴权，并使用强密码。

---

## 0. 访问与前置条件

### 0.1 Web UI 登录（必需）

Web UI 使用 **HTTP Basic Auth**（浏览器会弹出登录框）：

- `WEB_UI_ENABLED=true`
- `WEB_UI_BASIC_USER=admin`
- `WEB_UI_BASIC_PASS=一个足够长的随机密码`

> 这套账号密码只保护网页与管理接口；不等同于网关 API 的入口 Key。

### 0.2 网关 API 的入口 Key（必需）

网关对外提供 `/v1/*`、`/claude/*`、`/gemini/*` 等接口时，必须开启入口鉴权：

- `WORKER_AUTH_KEY=...`（或 `WORKER_AUTH_KEYS=key1,key2`）

这是“**下游 key**”：你的客户端/插件调用你这台网关服务器时必须携带的 Key。

### 0.3 Web UI 为什么默认不需要你手动填“入口 Key”

页面会优先使用 **服务端代理**（`/ui/api/*`）来调用网关接口，服务端会自动注入 `WORKER_AUTH_KEY`，因此你无需在浏览器里再填一次入口 Key。

如果你不是用 Docker/Node 运行（例如纯 Cloudflare Worker），或代理接口不可用，页面会退回“手动模式”，这时才会显示“入口 API Key（手动模式才需要）”输入框。

---

## 1. 页面模块说明

## 1.1 顶部：健康检查 / 模型列表

### `GET /v1/health`

用途：检查服务是否正常运行。

返回示例（JSON）：

```json
{ "ok": true, "time": 1730000000 }
```

### `GET /v1/models`

用途：查看你当前配置下对外暴露的模型列表（OpenAI 风格）。

默认情况下，这个列表来自你的 `RSP4COPILOT_CONFIG`（即你映射后的“对外模型名”）。

如果你在某个 provider 上开启了 `discoverModels: true`，Web UI 的“添加 model”会提供一个“从上游拉取候选模型并搜索选择”的入口（上游走 `GET /v1/models` 或兼容的 `/models`）。

注意：
- 这不会自动把所有上游模型暴露到网关 `/v1/models`
- 你仍需要在 UI 里选择并添加你要用的模型（写入到配置的 `models` 映射里）
- 如果候选模型列表为空：请确认 `baseURL/baseURLs` 指向 OpenAI 兼容站点、且 `apiKeyEnv` 对应的环境变量已正确设置（网关需要用该 key 去请求上游的 `/v1/models`）

---

## 1.1.1 Token 统计（/v1/metrics/tokens/*）

用途：在“Token 统计”页查看每次调用的 Token、每日用量趋势，并支持按上游/Provider 分组查看。

前置开关（任一满足即可）：
- `WEB_UI_ENABLED=true`（启用 Web UI 时会自动启用统计）
- 或 `RSP4COPILOT_TOKEN_STATS_ENABLED=true`（不启用 Web UI 也可单独启用统计接口）

相关接口：
- `GET /v1/metrics/tokens/overview?days=30&groupBy=upstream`
- `GET /v1/metrics/tokens/recent?since=0&limit=200`

> 说明：默认内存统计；如开启持久化则重启不会清空。

持久化方式：
- Docker/Node（默认开启）：写入 `RSP4COPILOT_STATS_FILE`（默认 `/config/rsp4copilot.stats.json`），可用 `RSP4COPILOT_STATS_PERSIST=false` 关闭。
- Cloudflare Worker：绑定 KV Namespace 为 `RSP4COPILOT_STATS_KV`（可选：`RSP4COPILOT_STATS_KEY` 自定义存储 key）。

## 1.1.2 上游可用率（/v1/metrics/availability/*）

用途：在“可用率”页查看上游调用成功率（可按 `provider/upstream`、`model` 或二者组合聚合），并展示每日趋势与最近请求。

统计口径：
- 以“上游尝试”为单位记录（包括失败切换/重试过程中的每一次尝试）
- 成功：HTTP 2xx；失败：非 2xx

前置开关（同 Token 统计）：
- `WEB_UI_ENABLED=true` 或 `RSP4COPILOT_TOKEN_STATS_ENABLED=true`

相关接口：
- `GET /v1/metrics/availability/overview?days=30&groupBy=upstream_model`
- `GET /v1/metrics/availability/recent?since=0&limit=200`

> 说明：默认内存统计；如开启持久化则重启不会清空（配置同上）。

## 1.2 服务端配置文件（Docker）

这一块操作的是你容器内的配置文件 `RSP4COPILOT_CONFIG_FILE`（默认 `/config/rsp4copilot.config.jsonc`，在 compose 里挂载到宿主机 `./configs` 目录）。

### 1.2.1 按钮说明

- `加载配置`：读取配置文件内容，显示到下方文本框，同时尝试解析出结构化配置供可视化编辑。
- `保存配置`：把文本框里的内容写回配置文件（需要 `WEB_UI_CONFIG_WRITE=true`）。
- `刷新可视化`：基于当前“已加载的结构化配置”刷新可视化表单。
- `添加 Provider`：新增一个 provider（会提示输入 provider id）。
- `应用到文本`：把可视化表单里的配置生成 JSON（无注释）并覆盖写入到文本框。

> 注意：`应用到文本` 会生成纯 JSON，会覆盖原 JSONC 注释与格式；如果你希望保留注释，请继续使用文本框手工编辑 JSONC。

### 1.2.2 Provider（按分组编辑）

Web UI 的可视化编辑会按 `providerId` 分组，每个 Provider 的常用字段如下。

#### `provider id`

用途：provider 的唯一标识（例如 `openai`/`gemini`/`claude`/`relayA`）。

规则：
- 不能包含 `.`（点号）
- 建议只用字母/数字/`_`/`-`

#### `apiMode`

用途：告诉网关“这个 provider 的上游协议是什么”。

常用值：
- `openai-responses`
- `openai-chat-completions`
- `gemini`
- `claude`

填写示例：
- OpenAI Responses 上游：`openai-responses`
- OpenAI Chat Completions 上游：`openai-chat-completions`

#### `baseURL`

用途：上游/中转站的基础地址。

重要：
- 这里填的是 **上游** 地址，不要填你自己的网关地址（不要填 `http://127.0.0.1:30018` 这类），否则会形成自我转发循环。

示例：
- OpenAI relay：`https://relay-a.example/openai`
- Gemini 官方：`https://generativelanguage.googleapis.com`
- Claude 官方：`https://api.anthropic.com`

#### `apiKeyEnv`

用途：上游 key 从哪个环境变量读取。

示例：
- `OPENAI_API_KEY_RELAY_A`
- `GEMINI_API_KEY`
- `CLAUDE_API_KEY`

推荐用 `apiKeyEnv`，不要把 key 写死在配置文件里（避免泄露与不便轮换）。

#### `customHeader`（可选）

用途：网关请求上游/中转站时附加自定义请求头（用于某些 Cloudflare/风控场景）。

示例：

```json
"customHeader": {
  "user-agent": "codex_cli_rs/0.79.0 (Windows 10.0.26100; x86_64) unknown",
  "originator": "codex_cli_rs"
}
```

说明：
- 即使你不填，网关也会默认自动附加这两个 header
- 你填写 `customHeader` 时会覆盖默认值

#### `使用 upstreams（多上游聚合）`

用途：同一个 provider 下配置多个 upstream（多个 relay），可做轮询/故障切换。

勾选后会出现 `upstreams` 列表，每个 upstream 常用字段：
- `id`：upstream 的标识（便于区分）
- `baseURL`：该 upstream 的上游地址
- `apiKeyEnv`：该 upstream 的 key 环境变量名
- `weight`：权重（用于随机/哈希等策略）

> 当你使用 `upstreams` 时，provider 级别的 `baseURL`/`apiKeyEnv` 会被移除（避免混淆）。

#### `models`

用途：把“对外模型名”映射到“上游真实模型名”。

每个 model 项包含：
- `modelName`（键名）：你希望客户端请求里使用的名字（例如 `gpt-5.2`）
- `upstreamModel`：上游实际模型名（例如 `gpt-5.2`，或上游的其它命名）

示例：

```json
"models": {
  "gpt-5.2": { "upstreamModel": "gpt-5.2" }
}
```

补充：如果开启 `discoverModels: true`，`models` 可以为空（此时网关会把请求里的 `model` 直接透传为 `upstreamModel`）。

---

## 1.3 快速测试（按 Provider/模型）

用途：不用自己拼 JSON，直接按你想要的 **provider + model** 发一条测试请求。

### 字段说明

#### `协议`

可选：
- `openai-chat`：请求 `/v1/chat/completions`
- `openai-responses`：请求 `/v1/responses`
- `claude`：请求 `/claude/v1/messages`
- `gemini`：请求 `/gemini/v1beta/models/{model}:generateContent?provider=...`

#### `Provider` / `Model`

这里会组合为：
- OpenAI/Claude：`model = "<provider>.<model>"`
- Gemini：会走 `?provider=<provider>`，并把 `model` 放到 Gemini path 里

示例：
- Provider：`openai`
- Model：`gpt-5.2`

最终 OpenAI 请求里会用：`"model": "openai.gpt-5.2"`

#### `Prompt`

你要发给模型的文本。

### 按钮说明

- `发送测试请求`：直接发请求并在右侧“响应”框显示结果
- `填充到“自定义请求”`：把生成的 path/method/body 写入“自定义请求”区，便于你再手动微调

---

## 1.4 密钥查看（危险）

用途：在网页里查看当前“上游 key / 下游 key”的状态（默认脱敏）。

### 前置开关（`.env`）

- 开启查看：`WEB_UI_SECRETS_VIEW=true`
- 允许显示明文（极高风险）：`WEB_UI_SECRETS_REVEAL=true`

说明：
- 默认只显示脱敏值（例如 `***abcd12`）
- 勾选“请求明文（reveal=1）”只是“请求明文”，是否真的返回明文取决于服务端是否允许 `WEB_UI_SECRETS_REVEAL=true`

### 上游 key / 下游 key 是什么

- **下游 key**：`WORKER_AUTH_KEY/WORKER_AUTH_KEYS`（客户端调用你网关用）
- **上游 key**：你转发到上游/relay 时使用的 key（通常由配置里的 `apiKeyEnv` 指向某个环境变量）

---

## 1.5 上游 Key 修改（危险）

用途：在网页里直接把上游 key 写入服务器端的覆盖文件（默认 `/config/rsp4copilot.env`），无需手工改 `.env`。

### 前置开关（`.env`）

- `WEB_UI_SECRETS_VIEW=true`（能加载列表）
- `WEB_UI_SECRETS_WRITE=true`（能保存修改）

### 原理说明（你需要知道的）

- 页面“加载可编辑列表”会根据当前配置里用到的 `apiKeyEnv` 变量名来生成表单
- 保存后会写入 `RSP4COPILOT_ENV_FILE`（默认 `/config/rsp4copilot.env`）
- Node 运行时会在每次处理请求时读取该文件作为“环境变量覆盖层”，所以修改通常**立即生效**

> 限制：这里只能修改配置里引用到的 `apiKeyEnv` 对应变量；不能随意写其它环境变量（防误操作/提权）。

---

## 1.6 自定义请求（JSON）

用途：你完全自定义 path/method/body 来调试 API。

字段：
- `路径`：例如 `/v1/chat/completions`
- `方法`：`GET` / `POST`
- `Body`：JSON 字符串

提示：
- SSE 流式返回不会被解析成事件，会原样显示文本。

---

## 2. 推荐示例

### 2.1 最小 `.env`（只开 Web UI + 入口 key）

```env
PUBLIC_PORT=30018
WORKER_AUTH_KEY=your_gateway_key

WEB_UI_ENABLED=true
WEB_UI_BASIC_USER=admin
WEB_UI_BASIC_PASS=very_long_random_password
```

### 2.2 开启“配置写入 + 上游 key 网页修改”

```env
WEB_UI_CONFIG_WRITE=true
WEB_UI_SECRETS_VIEW=true
WEB_UI_SECRETS_WRITE=true
# WEB_UI_SECRETS_REVEAL=false  # 建议保持 false
```

### 2.3 最小配置（单 OpenAI Responses 上游）

`configs/rsp4copilot.config.jsonc`：

```jsonc
{
  "version": 1,
  "providers": {
    "openai": {
      "apiMode": "openai-responses",
      "baseURL": "https://your-relay.example/openai",
      "apiKeyEnv": "OPENAI_API_KEY_RELAY_A",
      "models": {
        "gpt-5.2": { "upstreamModel": "gpt-5.2" }
      }
    }
  }
}
```

然后你可以在 Web UI 的“上游 Key 修改”里填写 `OPENAI_API_KEY_RELAY_A` 的值。

---

## 3. 常见问题

### 3.1 “加载密钥/加载可编辑列表”返回 404

这是预期行为：表示服务端没开启相应能力。

- 只看密钥：需要 `.env` 配 `WEB_UI_SECRETS_VIEW=true`
- 还要能写：再加 `.env` 配 `WEB_UI_SECRETS_WRITE=true`

改完后需要 `docker compose up -d --build`（或至少 `docker compose restart rsp4copilot`）让容器重新读取环境变量。

### 3.2 为什么 baseURL 不能填我自己服务器地址

`baseURL` 代表“上游/中转站地址”。如果填成你自己的网关地址，会导致请求被网关再次转发回自己，形成循环。

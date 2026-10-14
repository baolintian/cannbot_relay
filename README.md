# cannbot relay

将 cannbot 网关转换为标准 **OpenAI Compatible API** 的本地代理，让你在任何 agent 中通过 `baseURL + apiKey` 使用 cannbot 的大模型服务。

## 原理

cannbot 网关（`https://cannbot.hicann.cn/gateway/compatible-mode/v1`）本身响应格式是 OpenAI 兼容的，但要求双重认证头（标准 OpenAI 客户端无法直连）：

| 头 | 值 |
|---|---|
| `x-api-vkey` | 虚拟密钥 VK |
| `Authorization` | `Bearer <JWT>` 访问令牌 |

本代理在本地接收标准 OpenAI 请求，自动注入上述凭据后转发网关。凭据从 `~/.local/share/opencode/auth.json` 自动读取（长期有效，重新登录 cannbot 后自动感知），并按模型注入 per-model VK（对齐 cannwork-auth 插件行为）。

## 快速开始

```bash
node relay.mjs                # 默认监听 http://127.0.0.1:8117/v1
node relay.mjs --port 9000    # 自定义端口
RELAY_API_KEY=my-secret node relay.mjs   # 启用本地密钥校验（推荐）
```

> 要求 Node.js 18+，零依赖，无需 npm install。

## 在其他 agent 中使用

任何支持 OpenAI Compatible 接口的工具，填入：

```
Base URL: http://127.0.0.1:8117/v1
API Key: 任意值（如 sk-relay；若启动时设置了 RELAY_API_KEY 则必须匹配）
Model:   见下方模型列表
```

### Python (openai SDK)

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8117/v1", api_key="sk-relay")
r = client.chat.completions.create(
    model="glm-5.3-flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(r.choices[0].message.content)
```

### Node.js (openai SDK)

```js
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://127.0.0.1:8117/v1", apiKey: "sk-relay" });
const stream = await client.chat.completions.create({
  model: "qwen3.8-max",
  messages: [{ role: "user", content: "你好" }],
  stream: true,
});
for await (const c of stream) process.stdout.write(c.choices?.[0]?.delta?.content || "");
```

### curl

```bash
curl http://127.0.0.1:8117/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-relay" \
  -d '{"model":"glm-5.3","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## 可用端点

| 端点 | 说明 |
|---|---|
| `GET /v1/models` | 模型列表（从 cannbot API 实时拉取，5 分钟缓存；不可达时回退内置列表） |
| `POST /v1/chat/completions` | 对话补全，支持流式（SSE）与非流式 |
| `GET /health` | 健康检查 |

## 可用模型

`deepseek-v4.1-flash` / `deepseek-v4-flash` / `deepseek-v4-pro` / `qwen3.8-flash` / `qwen3.8-max` / `glm-5.3` / `glm-5.3-flash`

以 `GET /v1/models` 实际返回为准（跟随你的 cannbot 账号个人模型列表动态变化）。

## 配置项

| 参数 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `--port` | `RELAY_PORT` | `8117` | 监听端口 |
| `--bind` | `RELAY_BIND` | `127.0.0.1` | 监听地址（`0.0.0.0` 可供局域网访问，务必配合 `RELAY_API_KEY`） |
| — | `RELAY_API_KEY` | 空 | 本地密钥；设置后客户端必须携带 `Authorization: Bearer <key>` |
| — | `CANNBOT_GATEWAY_URL` | 官方网关 | 覆盖网关地址 |
| — | `CANNBOT_MODELS_API_URL` | 官方 API | 覆盖模型列表 API |

## 常驻运行（macOS launchd 示例）

```bash
nohup node /Users/bao/work/cann/cannbot_relay/relay.mjs >> /Users/bao/work/cann/cannbot_relay/relay.log 2>&1 &
```

停止：`pkill -f relay.mjs`

## 安全提示

- 默认只绑定 `127.0.0.1`，仅本机可访问
- 凭据（VK/JWT）保存在本机 `auth.json`，relay 不会向外泄露
- 如需暴露到局域网，务必设置 `RELAY_API_KEY`

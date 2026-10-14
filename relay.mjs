#!/usr/bin/env node
/**
 * cannbot relay — 本地 OpenAI 兼容代理
 *
 * 将 cannbot 网关（https://cannbot.hicann.cn/gateway/compatible-mode/v1）
 * 转换为标准 OpenAI API 形式，供其他 agent 通过 url + key 直接使用。
 *
 * 网关要求双重认证头（标准 OpenAI 客户端无法直连）：
 *   x-api-vkey: vk-xxx                      （虚拟密钥）
 *   Authorization: Bearer <JWT>             （访问令牌）
 *
 * 凭据自动读取 ~/.local/share/opencode/auth.json：
 *   cannbot.key          → VK（个人模型）
 *   cannbot-cli.access   → 长期 JWT（有效期至 2126 年）
 *   cannbot-cli.refresh  → 备用 VK
 *
 * 用法：
 *   node relay.mjs [--port 8117] [--bind 127.0.0.1]
 *
 * 环境变量：
 *   RELAY_API_KEY            本地访问密钥（设置后客户端必须携带 Bearer <key>；不设置则放行）
 *   RELAY_PORT / RELAY_BIND  等效于 --port / --bind
 *   CANNBOT_GATEWAY_URL      覆盖网关地址
 *   CANNBOT_MODELS_API_URL   覆盖模型列表 API
 */

import { createServer } from "node:http";
import { Readable } from "node:stream";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── 配置 ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

const GATEWAY_URL =
  process.env.CANNBOT_GATEWAY_URL || "https://cannbot.hicann.cn/gateway/compatible-mode/v1";
const MODELS_API_URL =
  process.env.CANNBOT_MODELS_API_URL || "https://cannbot.hicann.cn/cannbot/api/models/personal";
const AUTH_JSON_PATH = join(homedir(), ".local", "share", "opencode", "auth.json");
const SESSION_JSON_PATH = join(homedir(), ".local", "share", "opencode", "session.json");

const PORT = Number(argValue("port") || process.env.RELAY_PORT || 8117);
const BIND = argValue("bind") || process.env.RELAY_BIND || "127.0.0.1";
const LOCAL_KEY = process.env.RELAY_API_KEY || "";

// 兜底模型列表（模型列表 API 不可达时使用）
const FALLBACK_MODELS = [
  "qwen3.8-flash", "qwen3.8-max", "glm-5.3", "glm-5.3-flash",
  "deepseek-v4.1-flash", "deepseek-v4-flash", "deepseek-v4-pro",
];

// ── 凭据读取（每次请求直读，自动感知重新登录后的变化）────────────────────────

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function readCreds() {
  const auth = readJson(AUTH_JSON_PATH) || {};
  const vk =
    auth.cannbot?.key ||
    auth["cannbot-cli"]?.refresh ||
    "";
  // 优先长期 JWT（cannbot-cli.access，2126 年过期）；
  // 退回 session.json 的短期 JWT（24h，opencode 运行期间有效）
  const jwt =
    auth["cannbot-cli"]?.access ||
    readJson(SESSION_JSON_PATH)?.accessToken ||
    "";
  return { vk, jwt };
}

// ── 模型列表（带缓存，含 model→VK 映射）─────────────────────────────────────

let modelsCache = { at: 0, list: null, vkMap: {} };
const MODELS_CACHE_TTL = 5 * 60 * 1000;

async function fetchModels(jwt) {
  if (modelsCache.list && Date.now() - modelsCache.at < MODELS_CACHE_TTL) {
    return modelsCache;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(MODELS_API_URL, {
      headers: { Authorization: `Bearer ${jwt}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success || !json.data) throw new Error("bad payload");

    const seen = new Set();
    const list = [];
    const vkMap = {};
    for (const m of [...(json.data.personalModels || []), ...(json.data.builtinModels || [])]) {
      if (!m.model || seen.has(m.model)) continue;
      seen.add(m.model);
      list.push(m.model);
      if (m.apiKey) vkMap[m.model] = m.apiKey; // personal 在前，优先保留 personal 的 VK
    }
    if (list.length === 0) throw new Error("empty list");
    modelsCache = { at: Date.now(), list, vkMap };
  } catch (e) {
    if (!modelsCache.list) {
      modelsCache = {
        at: Date.now(),
        list: FALLBACK_MODELS,
        vkMap: Object.fromEntries(FALLBACK_MODELS.map((m) => [m, null])),
      };
    }
    log(`models API 不可用（${e.message}），使用${modelsCache.list === FALLBACK_MODELS ? "兜底" : "缓存"}列表`);
  }
  return modelsCache;
}

// ── 日志 ─────────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── 工具 ─────────────────────────────────────────────────────────────────────

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function authorized(req) {
  if (!LOCAL_KEY) return true;
  const header = req.headers["authorization"] || "";
  return header === `Bearer ${LOCAL_KEY}`;
}

// ── 转发核心 ─────────────────────────────────────────────────────────────────

async function proxyChat(req, res) {
  const body = await readBody(req);

  let model = "";
  try {
    model = JSON.parse(body.toString("utf-8")).model || "";
  } catch { /* 非 JSON body 原样转发，交给网关报错 */ }

  const { vk, jwt } = readCreds();
  if (!vk || !jwt) {
    sendJson(res, 503, {
      error: {
        message: "缺少 cannbot 凭据（VK/JWT）。请先通过 cannbot 登录，"
          + `确保 ${AUTH_JSON_PATH} 存在 cannbot.key 与 cannbot-cli.access。`,
        type: "relay_auth_error",
      },
    });
    return;
  }

  // per-model VK（优先），回退默认 VK —— 对齐 cannwork-auth 插件行为
  let modelVk = vk;
  if (model) {
    const { vkMap } = await fetchModels(jwt);
    if (vkMap[model]) modelVk = vkMap[model];
  }

  let upstream;
  try {
    upstream = await fetch(`${GATEWAY_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-vkey": modelVk,
        "api-key": modelVk,
        Authorization: `Bearer ${jwt}`,
      },
      body,
    });
  } catch (e) {
    sendJson(res, 502, { error: { message: `网关连接失败: ${e.message}`, type: "relay_upstream_error" } });
    return;
  }

  // 透传状态码与关键头，流式/非流式统一 pipe
  const headers = { "Content-Type": upstream.headers.get("content-type") || "application/json" };
  const rid = upstream.headers.get("x-request-id");
  if (rid) headers["X-Request-Id"] = rid;
  res.writeHead(upstream.status, headers);
  Readable.fromWeb(upstream.body).pipe(res);

  log(`chat model=${model || "?"} status=${upstream.status} bytes=${body.length}`);
}

async function listModels(res) {
  const { vk, jwt } = readCreds();
  const { list } = jwt ? await fetchModels(jwt) : { list: FALLBACK_MODELS };
  sendJson(res, 200, {
    object: "list",
    data: list.map((id) => ({ id, object: "model", created: 0, owned_by: "cannbot" })),
  });
}

// ── server ───────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = (req.url || "").split("?")[0].replace(/\/+$/, "");

  if (url === "/health") {
    sendJson(res, 200, { status: "ok", gateway: GATEWAY_URL });
    return;
  }

  if (!authorized(req)) {
    sendJson(res, 401, { error: { message: "Invalid API key", type: "invalid_request_error" } });
    return;
  }

  try {
    if (req.method === "GET" && (url === "/v1/models" || url === "/models")) {
      await listModels(res);
      return;
    }
    if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      await proxyChat(req, res);
      return;
    }
    sendJson(res, 404, { error: { message: `Not found: ${req.method} ${url}`, type: "invalid_request_error" } });
  } catch (e) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: { message: e.message, type: "relay_error" } });
    } else {
      res.destroy();
    }
  }
});

server.listen(PORT, BIND, () => {
  log(`cannbot relay 已启动: http://${BIND}:${PORT}/v1  (本地密钥: ${LOCAL_KEY ? "已启用" : "未设置，放行所有请求"})`);
  log(`网关: ${GATEWAY_URL}`);
});

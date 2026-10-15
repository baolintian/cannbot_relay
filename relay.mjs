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

  const auth = await resolveAuth(model);
  if (!auth) {
    sendAuthError(res);
    return;
  }

  let upstream;
  try {
    upstream = await fetch(`${GATEWAY_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-vkey": auth.modelVk,
        "api-key": auth.modelVk,
        Authorization: `Bearer ${auth.jwt}`,
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

// ── Responses API 桥接（/v1/responses ↔ chat/completions，供 codex 等使用）────

async function resolveAuth(model) {
  const { vk, jwt } = readCreds();
  if (!vk || !jwt) return null;
  // per-model VK（优先），回退默认 VK —— 对齐 cannwork-auth 插件行为
  let modelVk = vk;
  if (model) {
    const { vkMap } = await fetchModels(jwt);
    if (vkMap[model]) modelVk = vkMap[model];
  }
  return { jwt, modelVk };
}

function sendAuthError(res) {
  sendJson(res, 503, {
    error: {
      message: "缺少 cannbot 凭据（VK/JWT）。请先通过 cannbot 登录，"
        + `确保 ${AUTH_JSON_PATH} 存在 cannbot.key 与 cannbot-cli.access。`,
      type: "relay_auth_error",
    },
  });
}

function randomId(len = 24) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };
}

function sseWrite(res, event) {
  try {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  } catch { /* 客户端已断开 */ }
}

// Responses 请求 → Chat Completions 请求
function responsesToChat(parsed) {
  const messages = [];
  if (parsed.instructions) {
    messages.push({ role: "system", content: parsed.instructions });
  }

  const items = typeof parsed.input === "string"
    ? [{ type: "message", role: "user", content: [{ type: "input_text", text: parsed.input }] }]
    : Array.isArray(parsed.input) ? parsed.input : [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      const role = item.role === "developer" ? "system" : item.role || "user";
      const parts = typeof item.content === "string"
        ? [{ type: "input_text", text: item.content }]
        : Array.isArray(item.content) ? item.content : [];
      const text = parts
        .filter((p) => p && (p.type === "input_text" || p.type === "output_text" || p.type === "text" || p.type === "summary_text"))
        .map((p) => p.text || "")
        .join("");
      const images = parts
        .filter((p) => p && p.type === "input_image" && p.image_url)
        .map((p) => ({ type: "image_url", image_url: { url: p.image_url } }));
      messages.push(images.length
        ? { role, content: [{ type: "text", text }, ...images] }
        : { role, content: text });
    } else if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: item.content || "",
        tool_calls: [{ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments || "{}" } }],
      });
    } else if (item.type === "function_call_output") {
      const out = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
      messages.push({ role: "tool", tool_call_id: item.call_id, content: out });
    }
    // reasoning 等其余条目丢弃：无状态桥接，完整上下文每轮都会重发
  }

  const chatReq = { model: parsed.model || "", messages };

  if (parsed.max_output_tokens != null) chatReq.max_tokens = parsed.max_output_tokens;
  if (parsed.temperature != null) chatReq.temperature = parsed.temperature;
  if (parsed.top_p != null) chatReq.top_p = parsed.top_p;
  if (parsed.parallel_tool_calls != null) chatReq.parallel_tool_calls = parsed.parallel_tool_calls;

  const tools = (Array.isArray(parsed.tools) ? parsed.tools : [])
    .filter((t) => t && t.type === "function" && t.name)
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.parameters || { type: "object", properties: {} },
      },
    }));
  if (tools.length) chatReq.tools = tools;

  if (parsed.tool_choice) {
    const tc = parsed.tool_choice;
    if (tc === "auto" || tc === "none" || tc === "required") chatReq.tool_choice = tc;
    else if (tc.type === "function" && tc.name) chatReq.tool_choice = { type: "function", function: { name: tc.name } };
  }

  return chatReq;
}

// Chat Completions 响应 → Responses 响应（非流式）
function chatToResponses(chat, reqModel) {
  const choice = (chat.choices && chat.choices[0]) || {};
  const msg = choice.message || {};
  const output = [];

  if (msg.reasoning_content) {
    output.push({ type: "reasoning", id: `rs_${randomId()}`, summary: [{ type: "summary_text", text: msg.reasoning_content }] });
  }
  const text = typeof msg.content === "string"
    ? msg.content
    : Array.isArray(msg.content) ? msg.content.map((p) => p?.text || "").join("") : "";
  if (text) {
    output.push({
      type: "message", id: `msg_${randomId()}`, role: "assistant", status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const tc of msg.tool_calls || []) {
    output.push({
      type: "function_call", id: `fc_${randomId()}`, call_id: tc.id,
      name: tc.function?.name || "", arguments: tc.function?.arguments || "", status: "completed",
    });
  }

  const u = chat.usage || {};
  const status = choice.finish_reason === "length" ? "incomplete" : "completed";
  const resp = {
    object: "response",
    id: `resp_${randomId()}`,
    created_at: Math.floor(Date.now() / 1000),
    model: chat.model || reqModel || "",
    status,
    output,
    output_text: text,
    usage: {
      input_tokens: u.prompt_tokens || 0,
      output_tokens: u.completion_tokens || 0,
      total_tokens: u.total_tokens || 0,
      output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens || 0 },
    },
  };
  if (status === "incomplete") resp.incomplete_details = { reason: "max_output_tokens" };
  return resp;
}

// Chat SSE 流 → Responses SSE 流
function translateStream(upstream, res, model) {
  return new Promise((resolve) => {
    res.writeHead(200, sseHeaders());

    const respId = `resp_${randomId()}`;
    const createdAt = Math.floor(Date.now() / 1000);
    let modelName = model || "";
    let outputCount = 0;
    let finished = false;
    let textItem = null;
    let reasoningItem = null;
    const toolItems = {};
    let usage = null;
    let finishReason = null;

    const nextIndex = () => outputCount++;
    const created = () => ({
      id: respId, object: "response", created_at: createdAt, model: modelName, status: "in_progress", output: [],
    });
    sseWrite(res, { type: "response.created", response: created() });
    sseWrite(res, { type: "response.in_progress", response: created() });

    function ensureTextItem() {
      if (textItem) return;
      const id = `msg_${randomId()}`;
      textItem = { id, text: "", index: nextIndex() };
      sseWrite(res, { type: "response.output_item.added", output_index: textItem.index, item: { type: "message", id, role: "assistant", status: "in_progress", content: [] } });
      sseWrite(res, { type: "response.content_part.added", item_id: id, output_index: textItem.index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    }

    function ensureReasoningItem() {
      if (reasoningItem) return;
      const id = `rs_${randomId()}`;
      reasoningItem = { id, text: "", index: nextIndex() };
      sseWrite(res, { type: "response.output_item.added", output_index: reasoningItem.index, item: { type: "reasoning", id, summary: [] } });
      sseWrite(res, { type: "response.reasoning_summary_part.added", item_id: id, output_index: reasoningItem.index, summary_index: 0, part: { type: "summary_text", text: "" } });
    }

    function orderedToolItems() {
      return Object.keys(toolItems).sort((a, b) => Number(a) - Number(b)).map((k) => toolItems[k]);
    }

    function doneText() {
      sseWrite(res, { type: "response.output_text.done", item_id: textItem.id, output_index: textItem.index, content_index: 0, text: textItem.text });
      sseWrite(res, { type: "response.content_part.done", item_id: textItem.id, output_index: textItem.index, content_index: 0, part: { type: "output_text", text: textItem.text, annotations: [] } });
      sseWrite(res, { type: "response.output_item.done", output_index: textItem.index, item: { type: "message", id: textItem.id, role: "assistant", status: "completed", content: [{ type: "output_text", text: textItem.text, annotations: [] }] } });
    }

    function doneReasoning() {
      sseWrite(res, { type: "response.reasoning_summary_text.done", item_id: reasoningItem.id, output_index: reasoningItem.index, summary_index: 0, text: reasoningItem.text });
      sseWrite(res, { type: "response.reasoning_summary_part.done", item_id: reasoningItem.id, output_index: reasoningItem.index, summary_index: 0, part: { type: "summary_text", text: reasoningItem.text } });
      sseWrite(res, { type: "response.output_item.done", output_index: reasoningItem.index, item: { type: "reasoning", id: reasoningItem.id, summary: [{ type: "summary_text", text: reasoningItem.text }] } });
    }

    function doneTool(t) {
      if (t.arguments) sseWrite(res, { type: "response.function_call_arguments.done", item_id: t.id, output_index: t.index, arguments: t.arguments });
      sseWrite(res, { type: "response.output_item.done", output_index: t.index, item: { type: "function_call", id: t.id, call_id: t.call_id, name: t.name, arguments: t.arguments, status: "completed" } });
    }

    function finalOutput() {
      const output = [];
      if (reasoningItem) output.push({ type: "reasoning", id: reasoningItem.id, summary: [{ type: "summary_text", text: reasoningItem.text }] });
      if (textItem) output.push({ type: "message", id: textItem.id, role: "assistant", status: "completed", content: [{ type: "output_text", text: textItem.text, annotations: [] }] });
      for (const t of orderedToolItems()) {
        output.push({ type: "function_call", id: t.id, call_id: t.call_id, name: t.name, arguments: t.arguments, status: "completed" });
      }
      return output;
    }

    function finish() {
      if (finished) return;
      finished = true;
      const dones = [];
      if (reasoningItem) dones.push({ index: reasoningItem.index, run: doneReasoning });
      if (textItem) dones.push({ index: textItem.index, run: doneText });
      for (const t of orderedToolItems()) dones.push({ index: t.index, run: () => doneTool(t) });
      dones.sort((a, b) => a.index - b.index).forEach((d) => d.run());

      const u = usage || {};
      const status = finishReason === "length" ? "incomplete" : "completed";
      const response = {
        id: respId, object: "response", created_at: createdAt, model: modelName, status,
        output: finalOutput(),
        usage: {
          input_tokens: u.prompt_tokens || 0,
          output_tokens: u.completion_tokens || 0,
          total_tokens: u.total_tokens || 0,
          output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens || 0 },
        },
      };
      if (status === "incomplete") response.incomplete_details = { reason: "max_output_tokens" };
      sseWrite(res, { type: status === "incomplete" ? "response.incomplete" : "response.completed", response });
      res.end();
      resolve();
    }

    function fail(err) {
      if (finished) return;
      finished = true;
      sseWrite(res, {
        type: "response.failed",
        response: {
          id: respId, object: "response", created_at: createdAt, model: modelName,
          status: "failed", output: [],
          error: { code: (err && err.code) || "upstream_error", message: (err && err.message) || String(err) },
        },
      });
      res.end();
      resolve();
    }

    function handleChunk(chunk) {
      if (chunk.model) modelName = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      if (chunk.error) { fail(chunk.error); return; }
      const choice = chunk.choices?.[0];
      if (!choice) return;
      const delta = choice.delta || {};
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning) {
        ensureReasoningItem();
        reasoningItem.text += reasoning;
        sseWrite(res, { type: "response.reasoning_summary_text.delta", item_id: reasoningItem.id, output_index: reasoningItem.index, summary_index: 0, delta: reasoning });
      }
      let content = delta.content;
      if (Array.isArray(content)) content = content.map((p) => p?.text || "").join("");
      if (typeof content === "string" && content) {
        ensureTextItem();
        textItem.text += content;
        sseWrite(res, { type: "response.output_text.delta", item_id: textItem.id, output_index: textItem.index, content_index: 0, delta: content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (!tc) continue;
          const i = tc.index ?? 0;
          let item = toolItems[i];
          if (!item) {
            const name = tc.function?.name || "";
            item = toolItems[i] = { id: `fc_${randomId()}`, call_id: tc.id || `call_${randomId()}`, name, arguments: "", index: nextIndex() };
            sseWrite(res, { type: "response.output_item.added", output_index: item.index, item: { type: "function_call", id: item.id, call_id: item.call_id, name: item.name, arguments: "", status: "in_progress" } });
          }
          const argDelta = tc.function?.arguments;
          if (typeof argDelta === "string" && argDelta) {
            item.arguments += argDelta;
            sseWrite(res, { type: "response.function_call_arguments.delta", item_id: item.id, output_index: item.index, delta: argDelta });
          }
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    const nodeStream = Readable.fromWeb(upstream.body);
    res.on("close", () => {
      if (!finished) {
        finished = true;
        nodeStream.destroy();
        resolve();
      }
    });

    let pending = Buffer.alloc(0);
    nodeStream.on("data", (chunk) => {
      if (finished) return;
      pending = Buffer.concat([pending, chunk]);
      let nl;
      while ((nl = pending.indexOf(0x0a)) >= 0) {
        const line = pending.slice(0, nl).toString("utf-8").replace(/\r$/, "");
        pending = pending.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") { finish(); return; }
        try { handleChunk(JSON.parse(data)); } catch { /* 忽略无法解析的块 */ }
        if (finished) return;
      }
    });
    nodeStream.on("end", () => finish());
    nodeStream.on("error", (e) => fail(e));
  });
}

// 已完成的 Responses 对象 → SSE 事件序列（网关忽略 stream 参数时的兜底输出）
function emitResponsesAsSSE(resp, res) {
  res.writeHead(200, sseHeaders());
  const inProgress = { ...resp, status: "in_progress", output: [] };
  sseWrite(res, { type: "response.created", response: inProgress });
  sseWrite(res, { type: "response.in_progress", response: inProgress });
  resp.output.forEach((item, i) => {
    sseWrite(res, { type: "response.output_item.added", output_index: i, item });
    if (item.type === "message") {
      const text = item.content?.[0]?.text || "";
      sseWrite(res, { type: "response.content_part.added", item_id: item.id, output_index: i, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      if (text) sseWrite(res, { type: "response.output_text.delta", item_id: item.id, output_index: i, content_index: 0, delta: text });
      sseWrite(res, { type: "response.output_text.done", item_id: item.id, output_index: i, content_index: 0, text });
      sseWrite(res, { type: "response.content_part.done", item_id: item.id, output_index: i, content_index: 0, part: { type: "output_text", text, annotations: [] } });
    } else if (item.type === "function_call" && item.arguments) {
      sseWrite(res, { type: "response.function_call_arguments.delta", item_id: item.id, output_index: i, delta: item.arguments });
      sseWrite(res, { type: "response.function_call_arguments.done", item_id: item.id, output_index: i, arguments: item.arguments });
    }
    sseWrite(res, { type: "response.output_item.done", output_index: i, item });
  });
  sseWrite(res, { type: resp.status === "incomplete" ? "response.incomplete" : "response.completed", response: resp });
  res.end();
}

function sendResponsesError(res, wantStream, status, message) {
  if (wantStream) {
    res.writeHead(200, sseHeaders());
    sseWrite(res, {
      type: "response.failed",
      response: {
        id: `resp_${randomId()}`, object: "response", created_at: Math.floor(Date.now() / 1000),
        status: "failed", output: [],
        error: { code: String(status), message },
      },
    });
    res.end();
  } else {
    sendJson(res, status, { error: { message, code: String(status), type: "relay_upstream_error" } });
  }
}

async function proxyResponses(req, res) {
  const body = await readBody(req);

  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf-8"));
  } catch (e) {
    sendJson(res, 400, { error: { message: `Invalid JSON body: ${e.message}`, type: "invalid_request_error" } });
    return;
  }

  const chatReq = responsesToChat(parsed);
  const wantStream = parsed.stream === true;
  chatReq.stream = wantStream;

  const auth = await resolveAuth(chatReq.model);
  if (!auth) {
    sendAuthError(res);
    return;
  }

  let upstream;
  try {
    upstream = await fetch(`${GATEWAY_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-vkey": auth.modelVk,
        "api-key": auth.modelVk,
        Authorization: `Bearer ${auth.jwt}`,
      },
      body: JSON.stringify(chatReq),
    });
  } catch (e) {
    sendResponsesError(res, wantStream, 502, `网关连接失败: ${e.message}`);
    return;
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    let message = text;
    try { message = JSON.parse(text).error?.message || JSON.parse(text).message || text; } catch { /* 非 JSON 错误体 */ }
    sendResponsesError(res, wantStream, upstream.status, message || `网关返回 HTTP ${upstream.status}`);
    return;
  }

  if (!wantStream) {
    const chat = await upstream.json().catch(() => null);
    if (!chat || chat.error) {
      sendResponsesError(res, false, 502, (chat && chat.error && chat.error.message) || "网关返回异常");
      return;
    }
    sendJson(res, 200, chatToResponses(chat, chatReq.model));
    log(`responses model=${chatReq.model || "?"} stream=false status=200 bytes=${body.length}`);
    return;
  }

  const ct = upstream.headers.get("content-type") || "";
  if (!ct.includes("text/event-stream")) {
    // 网关忽略 stream 参数时，整体读取后按 Responses SSE 事件序列输出
    const chat = await upstream.json().catch(() => null);
    if (!chat || chat.error) {
      sendResponsesError(res, true, 502, (chat && chat.error && chat.error.message) || "网关返回异常");
      return;
    }
    emitResponsesAsSSE(chatToResponses(chat, chatReq.model), res);
    log(`responses model=${chatReq.model || "?"} stream=true(non-sse) status=200 bytes=${body.length}`);
    return;
  }

  await translateStream(upstream, res, chatReq.model);
  log(`responses model=${chatReq.model || "?"} stream=true status=200 bytes=${body.length}`);
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
    if (req.method === "POST" && (url === "/v1/responses" || url === "/responses")) {
      await proxyResponses(req, res);
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

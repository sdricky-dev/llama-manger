'use strict';
/**
 * Anthropic Messages API 适配层
 *
 * 让 llama-server 的 /v1/messages 端点能用 OpenAI Chat Completions 的
 * 客户端代码风格调用。两个协议的差异：
 *
 *   1. system 角色 → 顶层 system 字段（OpenAI 仍用 messages[0].role=system）
 *   2. max_tokens 必填（Anthropic 默认 4096；OpenAI 可省略）
 *   3. stream 字段名一致；stop_reason 字符串值不一样（end_turn / max_tokens / tool_use）
 *   4. SSE 数据形态完全不同：
 *
 *      OpenAI:  data: {"choices":[{"delta":{"content":"hi","reasoning_content":"..."}}]}
 *      Anthropic:
 *        - message_start → content_block_start
 *        - content_block_delta: {"delta":{"type":"text_delta","text":"hi"}}
 *          → 还有 "thinking_delta"（reasoning）
 *        - content_block_stop → message_delta → message_stop
 *
 * 第三方客户端（Claude Code / Continue.dev / Cursor 等）只认 Anthropic 风格；
 * 加上这层后用户可以把 llamaManger 当本地 Claude backend 用。
 */

/**
 * OpenAI Chat → Anthropic Messages 请求体
 *
 * @param {object} o { model, messages, stream, temperature, topK, topP, minP,
 *                     repeatPenalty, maxTokens?, system? }
 * @returns {object} Anthropic 风格请求体
 */
function toAnthropicRequest(o) {
  const out = { model: o.model };
  const msgs = Array.isArray(o.messages) ? o.messages : [];
  const anthropicMsgs = [];
  let system = typeof o.system === 'string' ? o.system : '';
  for (const m of msgs) {
    const role = m && m.role;
    const content = m && m.content;
    if (role === 'system') {
      // system 字段：累加（多 system 消息罕见但要兼容）
      system = system ? `${system}\n\n${content}` : String(content || '');
      continue;
    }
    if (role !== 'user' && role !== 'assistant') continue;
    anthropicMsgs.push({ role, content: String(content || '') });
  }
  if (system) out.system = system;
  out.messages = anthropicMsgs;
  // max_tokens 必填；未指定则取 4096（与 Anthropic 默认一致）
  out.max_tokens = Number.isFinite(o.maxTokens) && o.maxTokens > 0 ? o.maxTokens : 4096;
  if (Number.isFinite(o.temperature)) out.temperature = o.temperature;
  if (Number.isFinite(o.topP)) out.top_p = o.topP;
  if (Number.isFinite(o.topK) && o.topK > 0) out.top_k = o.topK;
  if (Number.isFinite(o.minP) && o.minP >= 0) // Anthropic 没原生 min_p，省略
    out.top_p = o.minP < (out.top_p || 1) ? o.minP : out.top_p;
  if (Number.isFinite(o.repeatPenalty) && o.repeatPenalty !== 1.0) {
    // llama-server 自定义参数；非 Anthropic 标准但 llama.cpp 接受
    // Anthropic 协议本身没有 repeat_penalty，这里保留给 llama-server
    out.repetition_penalty = o.repeatPenalty;
  }
  if (o.stream) out.stream = true;
  return out;
}

/**
 * 解析 Anthropic Messages 的单条 SSE 行。
 * 只关心 text_delta 与 thinking_delta；其他事件返回 null。
 *
 * @param {string} line 形如 'data: {...}'
 * @returns {{content?:string, reasoning?:string, stopReason?:string, type?:string}|null}
 */
function parseAnthropicStream(line) {
  if (typeof line !== 'string') return null;
  const t = line.trim();
  if (!t.startsWith('data:')) return null;
  const body = t.slice(5).trim();
  if (!body || body === '[DONE]') return null;
  let j;
  try { j = JSON.parse(body); } catch { return null; }
  const type = j && j.type;
  if (!type) return null;
  if (type === 'content_block_delta' && j.delta) {
    if (j.delta.type === 'text_delta' && typeof j.delta.text === 'string') {
      return { type, content: j.delta.text };
    }
    if (j.delta.type === 'thinking_delta' && typeof j.delta.thinking === 'string') {
      return { type, reasoning: j.delta.thinking };
    }
  }
  if (type === 'message_delta' && j.delta && j.delta.stop_reason) {
    return { type, stopReason: j.delta.stop_reason };
  }
  return { type };
}

const ANTHROPIC_API_STYLES = [
  { value: 'openai', label: 'OpenAI Chat (/v1/chat/completions)', path: '/v1/chat/completions' },
  { value: 'anthropic', label: 'Anthropic Messages (/v1/messages)', path: '/v1/messages' },
  { value: 'openai-responses', label: 'OpenAI Responses (/v1/responses)', path: '/v1/responses' },
];

/**
 * 当前选中的 API 风格对应的 URL 路径
 */
function pathForStyle(style) {
  const s = ANTHROPIC_API_STYLES.find((x) => x.value === style);
  return s ? s.path : ANTHROPIC_API_STYLES[0].path;
}

/**
 * 构建请求体（按风格分发）
 */
function buildRequestBody(style, base) {
  if (style === 'anthropic') return toAnthropicRequest(base);
  // openai / openai-responses 共用 OpenAI Chat 体；后续可加 Responses 转换
  return { ...base };
}

/**
 * 解析流式响应行（按风格分发）
 *
 * @returns {{content?:string, reasoning?:string, stopReason?:string}|null}
 */
function parseStreamLine(style, line) {
  if (style === 'anthropic') {
    const r = parseAnthropicStream(line);
    if (!r) return null;
    return {
      content: r.content,
      reasoning: r.reasoning,
      stopReason: r.stopReason,
    };
  }
  // OpenAI Chat：data: {"choices":[{"delta":{"content":"...", "reasoning_content":"..."}}]}
  const trimmed = trimmed5(line);
  if (!trimmed || trimmed === '[DONE]') return null;
  try {
    const j = JSON.parse(trimmed);
    const d = j.choices && j.choices[0] && j.choices[0].delta;
    if (!d) return null;
    return {
      content: typeof d.content === 'string' ? d.content : undefined,
      reasoning: typeof d.reasoning_content === 'string' ? d.reasoning_content : undefined,
    };
  } catch {
    return null;
  }
}

function trimmed5(line) {
  const t = (typeof line === 'string' ? line : '').trim();
  if (!t.startsWith('data:')) return null;
  return t.slice(5).trim();
}

module.exports = {
  toAnthropicRequest,
  parseAnthropicStream,
  ANTHROPIC_API_STYLES,
  pathForStyle,
  buildRequestBody,
  parseStreamLine,
};
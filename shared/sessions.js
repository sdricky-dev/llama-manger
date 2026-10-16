'use strict';
/**
 * 会话存档（轻量 JSONL）— 仿 llamafile agentfile 的 pi session v3 风格
 *
 * 与 --slot-save-path 的关系：
 *   --slot-save-path  → 把 KV 权重 + 提示词缓存写到磁盘（恢复时无需重新 prefill）
 *   本文件（sessions）→ 把对话历史（含 tool_calls）以 JSONL 形式写到磁盘（轻量、可分享、可导出）
 *
 * 文件格式（每行一个 JSON 对象）：
 *   {"type":"header","version":1,"id":"...","timestamp":"ISO","model":"...",
 *    "params":{...},"apiStyle":"openai"}
 *   {"type":"message","role":"user","content":"..."}
 *   {"type":"message","role":"assistant","content":"...","reasoning_content":"...","tool_calls":[...]}
 *   {"type":"message","role":"tool","tool_call_id":"...","content":"..."}
 *
 * 字段说明：
 *   - 必填：type
 *   - message 必填：role
 *   - assistant 角色的 tool_calls 保留，tool 角色的 tool_call_id 必须能配对
 *   - 解析失败的单行 → 跳过（不抛错），保证部分损坏的文件仍可读
 */

const fs = require('fs');
const path = require('path');

const SESSION_VERSION = 1;
const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/** 生成存档文件名（不含扩展名）：<timestamp>-<rand> */
function genSessionFilename(now = new Date()) {
  const ts = now.toISOString().replace(/[:.]/g, '-').replace(/T/, '_').replace(/Z$/, '');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

/** 构造 header 记录（第一行） */
function buildHeader({ model, apiStyle, params, id, timestamp }) {
  return {
    type: 'header',
    version: SESSION_VERSION,
    id: id || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: timestamp || new Date().toISOString(),
    model: model || null,
    apiStyle: apiStyle || 'openai',
    params: params || {},
  };
}

/** 校验一条消息记录是否符合存档 schema */
function isValidMessage(rec) {
  if (!rec || rec.type !== 'message') return false;
  if (!VALID_ROLES.has(rec.role)) return false;
  // content 可以是字符串（普通）或数组（多模态）；但 tool 角色只可能是字符串
  if (rec.role === 'tool') {
    if (typeof rec.tool_call_id !== 'string' || !rec.tool_call_id) return false;
  }
  // assistant 角色可以有 tool_calls（数组）
  return true;
}

/**
 * 把 header + messages 数组写成 JSONL 文本
 *
 * @param {object} o { header:object, messages:Array }
 * @returns {string} JSONL（行间用 '\n' 分隔，末尾带换行）
 */
function serialize({ header, messages }) {
  if (!header || header.type !== 'header') throw new Error('serialize: header 必须以 type:"header" 开头');
  const lines = [JSON.stringify(header)];
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) {
    if (!m || !m.role) continue;
    const rec = { type: 'message', role: m.role };
    if (m.content !== undefined) rec.content = m.content;
    if (m.reasoning_content) rec.reasoning_content = m.reasoning_content;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) rec.tool_calls = m.tool_calls;
    if (m.tool_call_id) rec.tool_call_id = m.tool_call_id;
    lines.push(JSON.stringify(rec));
  }
  return lines.join('\n') + '\n';
}

/**
 * 解析 JSONL 文本 → { header, messages, errors }
 *
 * @param {string} text
 * @returns {{header:object|null, messages:object[], errors:string[]}}
 */
function parse(text) {
  const out = { header: null, messages: [], errors: [] };
  if (typeof text !== 'string') {
    out.errors.push('parse: 输入不是字符串');
    return out;
  }
  let first = true;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/^\uFEFF/, '').trim();
    if (!raw) continue;
    let rec;
    try {
      rec = JSON.parse(raw);
    } catch (err) {
      out.errors.push(`第 ${i + 1} 行 JSON 解析失败: ${err.message}`);
      continue;
    }
    if (first) {
      first = false;
      if (rec && rec.type === 'header') {
        out.header = rec;
        continue;
      }
      // 没 header 也允许；把第一条当 header 容错
      if (rec) {
        out.header = {
          type: 'header',
          version: 0,
          id: undefined,
          timestamp: undefined,
          model: null,
          apiStyle: 'openai',
          params: {},
          _legacy: true,
          _originalFirst: rec,
        };
      }
    }
    if (isValidMessage(rec)) {
      out.messages.push(rec);
    } else {
      out.errors.push(`第 ${i + 1} 行不是合法 message：${raw.slice(0, 80)}`);
    }
  }
  return out;
}

/**
 * 把存档导出为可读的 Markdown（方便分享 / 复制到笔记）
 *
 * @param {object} parsed { header, messages }
 * @returns {string} Markdown
 */
function exportMarkdown({ header, messages }) {
  const h = header || {};
  const lines = [];
  lines.push(`# LlamaManger 会话存档`);
  if (h.timestamp) lines.push(`- 时间：${h.timestamp}`);
  if (h.model) lines.push(`- 模型：${h.model}`);
  if (h.apiStyle) lines.push(`- API：${h.apiStyle}`);
  if (h.id) lines.push(`- ID：${h.id}`);
  lines.push('');
  for (const m of messages || []) {
    if (m.role === 'system') {
      lines.push(`> **System**: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`);
      lines.push('');
    } else if (m.role === 'user') {
      lines.push(`## 👤 User`);
      lines.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2));
      lines.push('');
    } else if (m.role === 'assistant') {
      lines.push(`## 🤖 Assistant`);
      if (m.reasoning_content) {
        lines.push(`*💭 ${m.reasoning_content}*`);
        lines.push('');
      }
      lines.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2));
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = (tc && tc.function) || {};
          lines.push(`\n\`\`\`json\n// tool_call: ${fn.name || tc.type}\n${typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}, null, 2)}\n\`\`\``);
        }
      }
      lines.push('');
    } else if (m.role === 'tool') {
      lines.push(`> 🔧 **Tool** (\`${m.tool_call_id}\`): \`\`\`\n${m.content || ''}\n\`\`\``);
      lines.push('');
    }
  }
  return lines.join('\n');
}

/**
 * 估算消息数量（与 listSessions 一同使用）
 */
function countMessages(parsed) {
  return parsed && parsed.messages ? parsed.messages.length : 0;
}

/**
 * 校验存档文件路径合法性
 */
function validateSessionName(name) {
  const s = String(name || '');
  if (!s.length) return { ok: false, reason: '文件名为空' };
  if (s.length > 255) return { ok: false, reason: '文件名过长' };
  if (s === '.' || s === '..') return { ok: false, reason: '非法文件名' };
  if (/[\u0000-\u001F\u007F-\u009F]/.test(s)) return { ok: false, reason: '含控制字符' };
  if (/[\\/:*?"<>|]/.test(s)) return { ok: false, reason: '含非法字符' };
  return { ok: true };
}

/**
 * 把存档文件解析出"轻量元数据"（用于列表 UI 显示）
 * 不读全部内容，只看 header + 前 8 条消息估算
 */
function summarize(parsed) {
  const h = parsed && parsed.header ? parsed.header : {};
  const msgs = (parsed && parsed.messages) || [];
  const last = msgs[msgs.length - 1];
  return {
    id: h.id || null,
    timestamp: h.timestamp || null,
    model: h.model || null,
    apiStyle: h.apiStyle || 'openai',
    messageCount: msgs.length,
    lastRole: last ? last.role : null,
    titleGuess: msgs.find((m) => m.role === 'user')?.content?.slice(0, 60) || null,
  };
}

/** 默认存档目录 */
function defaultSessionsDir(appUserData) {
  return path.join(appUserData || '', 'sessions');
}

module.exports = {
  SESSION_VERSION,
  genSessionFilename,
  buildHeader,
  isValidMessage,
  serialize,
  parse,
  exportMarkdown,
  countMessages,
  validateSessionName,
  summarize,
  defaultSessionsDir,
};
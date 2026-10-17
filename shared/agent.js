'use strict';
/**
 * Agent 模式（仿 llamafile agentfile + llama.cpp server tools）
 *
 * llama-server 通过 --tools 启动后，模型可在响应中发起 tool_call；
 * 客户端拦截后让用户确认 / 执行工具 / 把结果回填给模型，如此循环
 * 直到模型返回普通 answer 为止。
 *
 * 这个文件只放**纯函数**（无 IO / 无 spawn），所有副作用都在调用方：
 *   1. agentStep() 决定下一步是请求更多 / 还是把工具结果回填
 *   2. isReadOnlyTool() / categorizeTools() 决定是否需要弹确认框
 *   3. applyToolResult() 把工具结果合并进 chat history
 */

/* ---------- 工具分类（仿 llamafile docs/built-in-tools.md）---------- */

/**
 * 工具的"危险等级"
 *   - 'read'    只读，agent 模式下默认放行
 *   - 'write'   写文件，需要用户确认
 *   - 'execute' 执行 shell 命令，必须用户确认
 *   - 'network' 网络访问，需要用户确认
 *
 * 这里只列 llama-server **真实内置**的工具（与 SERVER_TOOLS 一致）。
 * get_datetime 在上游 666f8898a 被移到 UI 侧、http_fetch/web_search 从来不在
 * server 工具表里，把它们留在分类表里只会让"自动放行集合"和实际下发的
 * --tools 名单不一致，所以已删除；未知名字仍按 execute（最严格）处理。
 */
const TOOL_CATEGORIES = {
  read_file: 'read',
  file_glob_search: 'read',
  grep_search: 'read',
  get_info: 'read',
  write_file: 'write',
  edit_file: 'write',
  exec_shell_command: 'execute',
};

/**
 * llama-server 真正认识的内置工具名。
 *
 * 对照上游 `common/arg.cpp` 里 --tools 的帮助文本（"available tools: ..."）：
 *   read_file, file_glob_search, grep_search, exec_shell_command, write_file, edit_file, get_info
 *
 * 注意 get_datetime 在上游 666f8898a 被移到 UI 侧、http_fetch/web_search 也从来不在
 * server 工具表里：这类名字传给 --tools，引擎会在启动时直接抛 "unknown tool ..." 退出，
 * 所以 TOOL_CATEGORIES 与 expandToolsArg() 都只保留下面这 7 个。
 */
const SERVER_TOOLS = [
  'read_file',
  'file_glob_search',
  'grep_search',
  'exec_shell_command',
  'write_file',
  'edit_file',
  'get_info',
];

/** 给定工具名，返回危险等级；未知工具按 execute 等级（最严格） */
function categorizeTool(name) {
  return TOOL_CATEGORIES[name] || 'execute';
}

/** 工具是否需要弹确认框 */
function toolRequiresConfirm(name) {
  const cat = categorizeTool(name);
  return cat === 'write' || cat === 'execute' || cat === 'network';
}

/** 给定 --tools 配置，返回「不需确认的工具集」 */
function autoApproveSet(toolsArg) {
  const set = new Set();
  if (!toolsArg || toolsArg === 'none') return set;
  const list = String(toolsArg).split(',').map((s) => s.trim()).filter(Boolean);
  for (const name of list) {
    if (name === 'all') {
      for (const k of Object.keys(TOOL_CATEGORIES)) {
        if (!toolRequiresConfirm(k)) set.add(k);
      }
      return set;
    }
    if (name === 'read_only') {
      for (const k of Object.keys(TOOL_CATEGORIES)) {
        if (categorizeTool(k) === 'read') set.add(k);
      }
      return set;
    }
    // 单个工具名：只在该工具不需要确认时放行
    if (!toolRequiresConfirm(name)) set.add(name);
  }
  return set;
}

/**
 * 把 UI 的 --tools 取值展开成**引擎真正接受**的名字列表。
 *
 * llama-server 只认 "all" 和具体工具名，不认 "read_only"（上游从来没有这个取值），
 * 所以必须在这里展开，否则 `--tools read_only` 会让 server 启动即失败。
 *
 *   'none' / ''        → []（调用方直接不下发 --tools）
 *   'read_only'        → 只读、且确实是 server 工具的那几个
 *   'all'              → ['all']
 *   'a,b'              → 逐个校验，丢掉引擎不认识的名字（宁可不启用，也不要启动失败）
 *
 * @param {string} value
 * @returns {string[]}
 */
function expandToolsArg(value) {
  const v = value == null ? '' : String(value).trim();
  if (!v || v === 'none') return [];
  if (v === 'all') return ['all'];

  const out = [];
  const push = (name) => {
    if (SERVER_TOOLS.includes(name) && !out.includes(name)) out.push(name);
  };
  for (const raw of v.split(',')) {
    const name = raw.trim();
    if (!name) continue;
    if (name === 'all') return ['all'];
    if (name === 'read_only') {
      for (const t of SERVER_TOOLS) {
        if (categorizeTool(t) === 'read') push(t);
      }
      continue;
    }
    push(name);
  }
  return out;
}

/* ---------- Agent 步骤状态机 ---------- */

/**
 * 把 OpenAI Chat 响应里的 tool_calls 标准化成统一数组
 *
 * 输入：assistant message 对象（来自 stream 最后一条 / 非流式响应）
 * 输出：[{ id, name, args }] 数组
 */
function extractToolCalls(assistantMessage) {
  if (!assistantMessage) return [];
  const tc = assistantMessage.tool_calls;
  if (!Array.isArray(tc)) return [];
  const out = [];
  for (const c of tc) {
    if (!c || c.type !== 'function') continue;
    const fn = c.function || {};
    if (!fn.name) continue;
    let args = {};
    if (typeof fn.arguments === 'string') {
      try { args = JSON.parse(fn.arguments); } catch { args = { _raw: fn.arguments }; }
    } else if (fn.arguments && typeof fn.arguments === 'object') {
      args = fn.arguments;
    }
    out.push({ id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: fn.name, args });
  }
  return out;
}

/**
 * 判断响应是否"还有工具调用"——是 → 进入工具执行步骤；否 → 流式显示普通答案
 */
function hasToolCalls(assistantMessage) {
  return extractToolCalls(assistantMessage).length > 0;
}

/**
 * 把工具结果列表合成 OpenAI Chat 的 tool 消息数组
 *
 * 输入：[{ id, name, content, isError? }]
 * 输出：[ { role:'tool', tool_call_id, content } ]
 */
function buildToolMessages(results) {
  if (!Array.isArray(results)) return [];
  const out = [];
  for (const r of results) {
    if (!r || !r.id) continue;
    out.push({
      role: 'tool',
      tool_call_id: r.id,
      content: typeof r.content === 'string' ? r.content : (r.content == null ? '' : String(r.content)),
    });
  }
  return out;
}

/**
 * 给非流式响应构造"下一步"的请求体
 *
 * 关键：如果当前 assistant 消息带 tool_calls，要把整段历史喂回去：
 *   [system?, user, assistant(tool_calls), tool, tool, ..., user, ...]
 * 这样 llama.cpp 知道上一个工具调用结果，回到决策循环。
 */
function nextAgentRequest({ baseMessages, assistantMessage, toolResults }) {
  const history = Array.isArray(baseMessages) ? baseMessages.slice() : [];
  // 把"刚返回的 assistant 消息（含 tool_calls）"加入
  if (assistantMessage) history.push(assistantMessage);
  // 再追加 tool 消息们
  for (const m of buildToolMessages(toolResults)) history.push(m);
  return history;
}

/**
 * 过滤"用户没允许的工具"——只保留允许列表里的工具调用。
 * 没开启的工具的 tool_calls 必须丢弃，否则 llama-server 会报错或执行失败。
 *
 * @param {Array<{id,name,args}>} calls
 * @param {Set<string>} allowed  --tools 解析出的允许集合（包含 read_only 展开）
 * @returns {{allowed:Array, denied:Array}}
 */
function partitionByAllow(calls, allowed) {
  const allow = new Set(Array.isArray(allowed) ? allowed : []);
  const out = { allowed: [], denied: [] };
  for (const c of calls || []) {
    if (allow.has(c.name)) out.allowed.push(c);
    else out.denied.push(c);
  }
  return out;
}

/**
 * 给被拒绝的工具调用合成一条 tool 消息，
 * 让模型知道"这个工具没开"，而不是循环重试。
 */
function deniedToolResults(denied) {
  return (denied || []).map((c) => ({
    id: c.id,
    name: c.name,
    isError: true,
    content: `工具 ${c.name} 未在本会话中启用（llama-server 启动参数 --tools）。请改用其他方式。`,
  }));
}

/**
 * 检查请求体里的 tools 字段是否符合 llama.cpp 的格式
 *
 * @param {Array|undefined} tools
 * @returns {boolean}
 */
function isValidToolsField(tools) {
  if (tools === undefined || tools === null) return true; // 不带 tools 字段也算合法
  if (!Array.isArray(tools)) return false;
  for (const t of tools) {
    if (!t || t.type !== 'function' || !t.function || !t.function.name) return false;
  }
  return true;
}

module.exports = {
  TOOL_CATEGORIES,
  SERVER_TOOLS,
  categorizeTool,
  toolRequiresConfirm,
  autoApproveSet,
  expandToolsArg,
  extractToolCalls,
  hasToolCalls,
  buildToolMessages,
  nextAgentRequest,
  partitionByAllow,
  deniedToolResults,
  isValidToolsField,
};
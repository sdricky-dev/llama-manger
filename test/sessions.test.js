'use strict';
/**
 * 会话存档（shared/sessions.js）单元测试
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
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
} = require('../shared/sessions');

/* ---------- genSessionFilename ---------- */

test('genSessionFilename：格式正确且唯一', () => {
  const a = genSessionFilename();
  const b = genSessionFilename();
  assert.match(a, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}-[a-z0-9]{6}$/);
  assert.notEqual(a, b);
});

test('genSessionFilename：注入固定时间戳', () => {
  const t = new Date('2024-05-01T10:30:00.123Z');
  const name = genSessionFilename(t);
  assert.match(name, /^2024-05-01/);
});

/* ---------- buildHeader ---------- */

test('buildHeader：必填字段', () => {
  const h = buildHeader({ model: '/m.gguf', apiStyle: 'openai', params: { ctx: 4096 } });
  assert.equal(h.type, 'header');
  assert.equal(h.version, SESSION_VERSION);
  assert.equal(h.model, '/m.gguf');
  assert.equal(h.apiStyle, 'openai');
  assert.equal(h.params.ctx, 4096);
  assert.match(h.id, /^sess_/);
  assert.match(h.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('buildHeader：传入 id / timestamp 时使用给定值', () => {
  const h = buildHeader({ id: 'fixed', timestamp: '2024-01-01T00:00:00Z' });
  assert.equal(h.id, 'fixed');
  assert.equal(h.timestamp, '2024-01-01T00:00:00Z');
});

/* ---------- isValidMessage ---------- */

test('isValidMessage：合法 user/assistant/system/tool', () => {
  assert.equal(isValidMessage({ type: 'message', role: 'user', content: 'hi' }), true);
  assert.equal(isValidMessage({ type: 'message', role: 'assistant', content: 'ok' }), true);
  assert.equal(isValidMessage({ type: 'message', role: 'system', content: 'sys' }), true);
  assert.equal(isValidMessage({ type: 'message', role: 'tool', tool_call_id: 'c1' }), true);
});

test('isValidMessage：tool 缺 tool_call_id → false', () => {
  assert.equal(isValidMessage({ type: 'message', role: 'tool', content: 'x' }), false);
});

test('isValidMessage：未知 role → false', () => {
  assert.equal(isValidMessage({ type: 'message', role: 'toolx', content: 'x' }), false);
});

test('isValidMessage：缺 type 或 role → false', () => {
  assert.equal(isValidMessage({ role: 'user' }), false);
  assert.equal(isValidMessage({ type: 'message' }), false);
});

/* ---------- serialize + parse 往返 ---------- */

test('serialize + parse：基本对话往返', () => {
  const header = buildHeader({ model: '/m.gguf', apiStyle: 'openai', params: { ctx: 4096 } });
  const messages = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'how are you?' },
    { role: 'assistant', content: 'good' },
  ];
  const text = serialize({ header, messages });
  const parsed = parse(text);
  assert.equal(parsed.header.model, '/m.gguf');
  assert.equal(parsed.header.apiStyle, 'openai');
  assert.equal(parsed.header.params.ctx, 4096);
  assert.equal(parsed.messages.length, 5);
  assert.equal(parsed.messages[0].role, 'system');
  assert.equal(parsed.messages[4].content, 'good');
  assert.deepEqual(parsed.errors, []);
});

test('serialize + parse：tool_calls 保留', () => {
  const header = buildHeader({});
  const messages = [
    { role: 'user', content: 'time?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'get_datetime', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: '2024-01-01' },
    { role: 'assistant', content: 'It is 2024-01-01' },
  ];
  const text = serialize({ header, messages });
  const parsed = parse(text);
  assert.equal(parsed.messages.length, 4);
  assert.ok(Array.isArray(parsed.messages[1].tool_calls));
  assert.equal(parsed.messages[1].tool_calls[0].function.name, 'get_datetime');
  assert.equal(parsed.messages[2].tool_call_id, 'c1');
});

test('serialize + parse：reasoning_content 保留', () => {
  const header = buildHeader({});
  const messages = [
    { role: 'user', content: '?' },
    { role: 'assistant', content: '42', reasoning_content: 'thinking...' },
  ];
  const parsed = parse(serialize({ header, messages }));
  assert.equal(parsed.messages[1].reasoning_content, 'thinking...');
});

test('serialize + parse：跳过空消息', () => {
  const header = buildHeader({});
  const messages = [
    { role: 'user', content: 'hi' },
    null,
    undefined,
    { role: 'no_role' },
    { role: 'assistant', content: 'hello' },
  ];
  const parsed = parse(serialize({ header, messages }));
  assert.equal(parsed.messages.length, 2);
});

/* ---------- parse 容错 ---------- */

test('parse：JSON 解析失败单行跳过', () => {
  const text = [
    JSON.stringify({ type: 'header', version: 1, id: 'a', timestamp: 't', model: null, apiStyle: 'openai', params: {} }),
    'this is not json',
    JSON.stringify({ type: 'message', role: 'user', content: 'hi' }),
  ].join('\n');
  const r = parse(text);
  assert.equal(r.messages.length, 1);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /JSON 解析失败/);
});

test('parse：非法 message 单行跳过', () => {
  const text = [
    JSON.stringify({ type: 'header', version: 1, id: 'a', timestamp: 't', model: null, apiStyle: 'openai', params: {} }),
    JSON.stringify({ type: 'message', role: 'unknown' }),
    JSON.stringify({ type: 'message', role: 'user', content: 'hi' }),
  ].join('\n');
  const r = parse(text);
  assert.equal(r.messages.length, 1);
  assert.equal(r.errors.length, 1);
});

test('parse：缺 header 时容错（legacy）', () => {
  const text = JSON.stringify({ type: 'message', role: 'user', content: 'hi' });
  const r = parse(text);
  assert.notEqual(r.header, null);
  assert.equal(r.header._legacy, true);
});

test('parse：空字符串返回空', () => {
  const r = parse('');
  assert.equal(r.header, null);
  assert.equal(r.messages.length, 0);
});

test('parse：去 BOM + 空白行', () => {
  const text = '\uFEFF\n' + JSON.stringify({ type: 'message', role: 'user', content: 'hi' }) + '\n\n';
  const r = parse(text);
  assert.equal(r.messages.length, 1);
});

/* ---------- exportMarkdown ---------- */

test('exportMarkdown：基本导出含标题与对话', () => {
  const header = buildHeader({ model: '/m.gguf', apiStyle: 'openai', id: 'fixed', timestamp: '2024-01-01T00:00:00Z' });
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ];
  const md = exportMarkdown({ header, messages });
  assert.match(md, /# LlamaManger 会话存档/);
  assert.match(md, /时间：2024-01-01/);
  assert.match(md, /模型：\/m\.gguf/);
  assert.match(md, /## 👤 User/);
  assert.match(md, /hi/);
  assert.match(md, /## 🤖 Assistant/);
  assert.match(md, /hello/);
});

test('exportMarkdown：tool_calls 块被格式化', () => {
  const header = buildHeader({});
  const messages = [
    { role: 'user', content: 'time?' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_datetime', arguments: '{}' } }],
    },
  ];
  const md = exportMarkdown({ header, messages });
  assert.match(md, /tool_call: get_datetime/);
});

test('exportMarkdown：reasoning_content 单独显示', () => {
  const md = exportMarkdown({
    header: buildHeader({}),
    messages: [{ role: 'assistant', content: '42', reasoning_content: 'thinking...' }],
  });
  assert.match(md, /💭 thinking\.\.\./);
  assert.match(md, /42/);
});

/* ---------- countMessages / summarize ---------- */

test('countMessages：空 parsed 返回 0', () => {
  assert.equal(countMessages({}), 0);
  assert.equal(countMessages(null), 0);
  assert.equal(countMessages({ messages: [] }), 0);
});

test('summarize：从首条 user 消息猜标题', () => {
  const parsed = {
    header: { model: '/m.gguf', apiStyle: 'openai', timestamp: '2024-01-01T00:00:00Z', id: 'a' },
    messages: [
      { role: 'user', content: 'Tell me a joke' },
    ],
  };
  const s = summarize(parsed);
  assert.equal(s.messageCount, 1);
  assert.match(s.titleGuess, /Tell me a joke/);
  assert.equal(s.model, '/m.gguf');
});

test('summarize：标题截断 60 字符', () => {
  const parsed = {
    header: {},
    messages: [{ role: 'user', content: 'a'.repeat(200) }],
  };
  const s = summarize(parsed);
  assert.equal(s.titleGuess.length, 60);
});

test('summarize：无 user 消息时 titleGuess 为 null', () => {
  const parsed = {
    header: {},
    messages: [{ role: 'assistant', content: 'hi' }],
  };
  assert.equal(summarize(parsed).titleGuess, null);
});

/* ---------- validateSessionName ---------- */

test('validateSessionName：合法名放行', () => {
  assert.equal(validateSessionName('normal.jsonl').ok, true);
  assert.equal(validateSessionName('带中文.jsonl').ok, true);
  assert.equal(validateSessionName('a.b.c.jsonl').ok, true);
});

test('validateSessionName：路径穿越与非法字符拒绝', () => {
  assert.equal(validateSessionName('../etc').ok, false);
  assert.equal(validateSessionName('a/b').ok, false);
  assert.equal(validateSessionName('a\\b').ok, false);
  assert.equal(validateSessionName('a:b').ok, false);
  assert.equal(validateSessionName('').ok, false);
  assert.equal(validateSessionName('.').ok, false);
  assert.equal(validateSessionName('..').ok, false);
});

test('validateSessionName：长度上限', () => {
  assert.equal(validateSessionName('a'.repeat(256)).ok, false);
  assert.equal(validateSessionName('a'.repeat(255)).ok, true);
});

test('validateSessionName：控制字符拒绝', () => {
  assert.equal(validateSessionName('a\x00b').ok, false);
  assert.equal(validateSessionName('a\nb').ok, false);
});

/* ---------- defaultSessionsDir ---------- */

test('defaultSessionsDir：拼到 userData 下', () => {
  const p = defaultSessionsDir('/Users/x/AppData');
  assert.equal(p, path.join('/Users/x/AppData', 'sessions'));
});

test('defaultSessionsDir：空 userData → 相对路径', () => {
  const p = defaultSessionsDir('');
  assert.equal(p, path.join('', 'sessions'));
});

/* ---------- 端到端：写入磁盘 → 读回 → 解析 ---------- */

test('端到端：写 JSONL → 读 → 解析成功', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmanger-sess-'));
  const file = path.join(tmp, 'a.jsonl');
  const header = buildHeader({ model: '/m', apiStyle: 'anthropic', params: { ctx: 8192 } });
  const messages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'world' },
  ];
  fs.writeFileSync(file, serialize({ header, messages }), 'utf8');
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = parse(raw);
  assert.equal(parsed.header.apiStyle, 'anthropic');
  assert.equal(parsed.header.params.ctx, 8192);
  assert.equal(parsed.messages.length, 2);
  fs.rmSync(tmp, { recursive: true });
});
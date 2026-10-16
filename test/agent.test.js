'use strict';
/**
 * Agent 模式（shared/agent.js）单元测试
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('../shared/agent');

/* ---------- categorizeTool / toolRequiresConfirm ---------- */

test('categorizeTool：已知工具返回正确分类', () => {
  assert.equal(categorizeTool('read_file'), 'read');
  assert.equal(categorizeTool('write_file'), 'write');
  assert.equal(categorizeTool('exec_shell_command'), 'execute');
  assert.equal(categorizeTool('http_fetch'), 'network');
});

test('categorizeTool：未知工具默认视为 execute（最严格）', () => {
  assert.equal(categorizeTool('rm_rf'), 'execute');
  assert.equal(categorizeTool('format_disk'), 'execute');
});

test('toolRequiresConfirm：read 类不需确认', () => {
  assert.equal(toolRequiresConfirm('read_file'), false);
  assert.equal(toolRequiresConfirm('grep_search'), false);
  assert.equal(toolRequiresConfirm('get_datetime'), false);
});

test('toolRequiresConfirm：write / execute / network 都需确认', () => {
  assert.equal(toolRequiresConfirm('write_file'), true);
  assert.equal(toolRequiresConfirm('edit_file'), true);
  assert.equal(toolRequiresConfirm('exec_shell_command'), true);
  assert.equal(toolRequiresConfirm('http_fetch'), true);
  assert.equal(toolRequiresConfirm('web_search'), true);
});

/* ---------- autoApproveSet ---------- */

test('autoApproveSet：none → 空集', () => {
  assert.equal(autoApproveSet('none').size, 0);
  assert.equal(autoApproveSet('').size, 0);
  assert.equal(autoApproveSet(undefined).size, 0);
});

test('autoApproveSet：read_only → 5 个只读工具', () => {
  const s = autoApproveSet('read_only');
  assert.equal(s.size, 5);
  assert.ok(s.has('read_file'));
  assert.ok(s.has('file_glob_search'));
  assert.ok(s.has('grep_search'));
  assert.ok(s.has('get_datetime'));
  assert.ok(s.has('get_info'));
  assert.ok(!s.has('write_file'));
  assert.ok(!s.has('exec_shell_command'));
});

test('autoApproveSet：all → 所有"不需确认"的工具（即 read 类）', () => {
  const s = autoApproveSet('all');
  // "all" 仍要确认 write/execute/network；只放行 read
  assert.ok(s.has('read_file'));
  assert.ok(!s.has('write_file'));
  assert.ok(!s.has('exec_shell_command'));
});

test('autoApproveSet：写单个 read 工具名 → 放行；写一个 write → 不放行', () => {
  assert.ok(autoApproveSet('read_file').has('read_file'));
  assert.equal(autoApproveSet('write_file').size, 0);
});

/* ---------- expandToolsArg：--tools 下发前的展开 ---------- */

test('SERVER_TOOLS：只包含上游 --tools 帮助文本里的名字', () => {
  assert.deepEqual(SERVER_TOOLS, [
    'read_file', 'file_glob_search', 'grep_search', 'exec_shell_command', 'write_file', 'edit_file', 'get_info',
  ]);
  // 前端侧工具（get_datetime 已被上游移到 UI）不在 server 工具表里
  assert.ok(!SERVER_TOOLS.includes('get_datetime'));
  assert.ok(!SERVER_TOOLS.includes('http_fetch'));
  assert.ok(!SERVER_TOOLS.includes('web_search'));
});

test('expandToolsArg：none / 空 → 空数组（调用方不下发 --tools）', () => {
  assert.deepEqual(expandToolsArg('none'), []);
  assert.deepEqual(expandToolsArg(''), []);
  assert.deepEqual(expandToolsArg(undefined), []);
  assert.deepEqual(expandToolsArg(null), []);
});

test('expandToolsArg：read_only 展开成 4 个只读 server 工具', () => {
  assert.deepEqual(expandToolsArg('read_only'), ['read_file', 'file_glob_search', 'grep_search', 'get_info']);
});

test('expandToolsArg：all 原样保留', () => {
  assert.deepEqual(expandToolsArg('all'), ['all']);
});

test('expandToolsArg：过滤引擎不认识的名字（否则 server 启动即抛 unknown tool）', () => {
  assert.deepEqual(expandToolsArg('read_file,get_datetime,http_fetch,edit_file'), ['read_file', 'edit_file']);
  assert.deepEqual(expandToolsArg('nonsense'), []);
});

test('expandToolsArg：去重、去空格，混入 read_only / all 也正确', () => {
  assert.deepEqual(expandToolsArg(' read_file , read_file '), ['read_file']);
  assert.deepEqual(expandToolsArg('read_only,write_file'), ['read_file', 'file_glob_search', 'grep_search', 'get_info', 'write_file']);
  assert.deepEqual(expandToolsArg('read_file,all'), ['all']);
});

test('autoApproveSet：多个工具名以逗号分隔', () => {
  const s = autoApproveSet('read_file, get_datetime');
  assert.equal(s.size, 2);
});

/* ---------- extractToolCalls ---------- */

test('extractToolCalls：从 OpenAI 风格的 tool_calls 提取', () => {
  const msg = {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_abc',
        type: 'function',
        function: {
          name: 'read_file',
          arguments: '{"path":"/etc/hostname"}',
        },
      },
    ],
  };
  const out = extractToolCalls(msg);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'call_abc');
  assert.equal(out[0].name, 'read_file');
  assert.deepEqual(out[0].args, { path: '/etc/hostname' });
});

test('extractToolCalls：arguments 是对象时直接采用', () => {
  const msg = {
    tool_calls: [{
      id: 'x', type: 'function',
      function: { name: 'get_datetime', arguments: { tz: 'UTC' } },
    }],
  };
  const out = extractToolCalls(msg);
  assert.deepEqual(out[0].args, { tz: 'UTC' });
});

test('extractToolCalls：arguments 解析失败时回退到 { _raw }', () => {
  const msg = {
    tool_calls: [{ id: 'x', type: 'function', function: { name: 'read_file', arguments: 'not json' } }],
  };
  const out = extractToolCalls(msg);
  assert.equal(out[0].args._raw, 'not json');
});

test('extractToolCalls：缺 id 时自动生成 call_xxx', () => {
  const msg = {
    tool_calls: [{ type: 'function', function: { name: 'get_datetime', arguments: '{}' } }],
  };
  const out = extractToolCalls(msg);
  assert.match(out[0].id, /^call_[a-z0-9]+$/);
});

test('extractToolCalls：type 非 function 跳过', () => {
  const msg = {
    tool_calls: [
      { id: '1', type: 'other' },
      { id: '2', type: 'function', function: { name: 'get_info', arguments: '{}' } },
    ],
  };
  const out = extractToolCalls(msg);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, '2');
});

test('extractToolCalls：无 tool_calls 字段返回 []', () => {
  assert.deepEqual(extractToolCalls({ role: 'assistant', content: 'hi' }), []);
  assert.deepEqual(extractToolCalls(null), []);
});

test('hasToolCalls：tool_calls 非空 → true', () => {
  assert.equal(hasToolCalls({ tool_calls: [{ id: 'x', type: 'function', function: { name: 'get_info', arguments: '{}' } }] }), true);
  assert.equal(hasToolCalls({ tool_calls: [] }), false);
  assert.equal(hasToolCalls({ role: 'assistant', content: 'ok' }), false);
});

/* ---------- buildToolMessages ---------- */

test('buildToolMessages：tool 结果 → OpenAI tool 消息', () => {
  const out = buildToolMessages([
    { id: 'a', name: 'read_file', content: 'linux' },
    { id: 'b', name: 'grep_search', content: 'match\n', isError: false },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { role: 'tool', tool_call_id: 'a', content: 'linux' });
  assert.deepEqual(out[1], { role: 'tool', tool_call_id: 'b', content: 'match\n' });
});

test('buildToolMessages：缺 id 的跳过', () => {
  const out = buildToolMessages([{ name: 'x', content: 'y' }, { id: 'a', content: 'z' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].tool_call_id, 'a');
});

test('buildToolMessages：content 非字符串强转', () => {
  const out = buildToolMessages([{ id: 'x', content: 12345 }]);
  assert.equal(out[0].content, '12345');
});

/* ---------- nextAgentRequest ---------- */

test('nextAgentRequest：合成下一步 messages 数组', () => {
  const hist = [
    { role: 'user', content: 'hi' },
  ];
  const asst = {
    role: 'assistant',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_datetime', arguments: '{}' } }],
  };
  const toolResults = [
    { id: 'c1', name: 'get_datetime', content: '2024-01-01' },
  ];
  const next = nextAgentRequest({ baseMessages: hist, assistantMessage: asst, toolResults });
  assert.equal(next.length, 3);
  assert.equal(next[0].role, 'user');
  assert.deepEqual(next[1], asst);
  assert.equal(next[2].role, 'tool');
  assert.equal(next[2].tool_call_id, 'c1');
  assert.equal(next[2].content, '2024-01-01');
});

test('nextAgentRequest：多 tool 结果按顺序追加', () => {
  const next = nextAgentRequest({
    baseMessages: [{ role: 'user', content: 'q' }],
    assistantMessage: {
      role: 'assistant',
      tool_calls: [
        { id: 'a', type: 'function', function: { name: 'r1', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'r2', arguments: '{}' } },
      ],
    },
    toolResults: [
      { id: 'a', content: 'A' },
      { id: 'b', content: 'B' },
    ],
  });
  assert.equal(next[2].tool_call_id, 'a');
  assert.equal(next[3].tool_call_id, 'b');
});

/* ---------- partitionByAllow ---------- */

test('partitionByAllow：按允许集合拆分', () => {
  const calls = [
    { id: 'a', name: 'read_file', args: {} },
    { id: 'b', name: 'exec_shell_command', args: {} },
    { id: 'c', name: 'get_datetime', args: {} },
  ];
  const out = partitionByAllow(calls, ['read_file', 'get_datetime']);
  assert.equal(out.allowed.length, 2);
  assert.equal(out.denied.length, 1);
  assert.equal(out.denied[0].name, 'exec_shell_command');
});

test('partitionByAllow：允许集合为空时全部 deny', () => {
  const out = partitionByAllow([{ id: 'a', name: 'read_file', args: {} }], []);
  assert.equal(out.allowed.length, 0);
  assert.equal(out.denied.length, 1);
});

/* ---------- deniedToolResults ---------- */

test('deniedToolResults：合成"未启用"错误消息', () => {
  const r = deniedToolResults([{ id: 'a', name: 'exec_shell_command', args: {} }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'a');
  assert.equal(r[0].isError, true);
  assert.match(r[0].content, /exec_shell_command/);
  assert.match(r[0].content, /未启用|--tools/);
});

test('deniedToolResults：空数组返回空', () => {
  assert.deepEqual(deniedToolResults([]), []);
});

/* ---------- isValidToolsField ---------- */

test('isValidToolsField：undefined / null 合法', () => {
  assert.equal(isValidToolsField(undefined), true);
  assert.equal(isValidToolsField(null), true);
});

test('isValidToolsField：合法数组', () => {
  assert.equal(isValidToolsField([]), true);
  assert.equal(isValidToolsField([{
    type: 'function',
    function: { name: 'read_file', description: '...', parameters: {} },
  }]), true);
});

test('isValidToolsField：缺 type / name → false', () => {
  assert.equal(isValidToolsField([{ function: { name: 'x' } }]), false);
  assert.equal(isValidToolsField([{ type: 'function', function: {} }]), false);
  assert.equal(isValidToolsField([{ type: 'other' }]), false);
});

test('isValidToolsField：非数组 → false', () => {
  assert.equal(isValidToolsField('foo'), false);
  assert.equal(isValidToolsField({}), false);
});
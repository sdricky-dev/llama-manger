'use strict';
/**
 * Anthropic Messages API 适配层单元测试
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  toAnthropicRequest,
  parseAnthropicStream,
  ANTHROPIC_API_STYLES,
  pathForStyle,
  buildRequestBody,
  parseStreamLine,
} = require('../shared/anthropic');

/* ---------- toAnthropicRequest ---------- */

test('toAnthropicRequest：单条 user 消息', () => {
  const out = toAnthropicRequest({
    model: '/m.gguf',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  });
  assert.equal(out.model, '/m.gguf');
  assert.deepEqual(out.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(out.system, undefined); // 无 system 就不带这个字段
  assert.equal(out.stream, true);
  // max_tokens 必填
  assert.equal(out.max_tokens, 4096);
});

test('toAnthropicRequest：system 角色提到顶层 system 字段', () => {
  const out = toAnthropicRequest({
    model: 'm',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ],
  });
  assert.equal(out.system, 'You are helpful.');
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].role, 'user');
});

test('toAnthropicRequest：多个 system 消息合并', () => {
  const out = toAnthropicRequest({
    model: 'm',
    messages: [
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
      { role: 'user', content: 'x' },
    ],
  });
  assert.equal(out.system, 'A\n\nB');
});

test('toAnthropicRequest：max_tokens 显式传入则覆盖默认', () => {
  const out = toAnthropicRequest({
    model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1024,
  });
  assert.equal(out.max_tokens, 1024);
});

test('toAnthropicRequest：max_tokens 0/负/NaN 走默认 4096', () => {
  assert.equal(toAnthropicRequest({ model: 'm', messages: [], maxTokens: 0 }).max_tokens, 4096);
  assert.equal(toAnthropicRequest({ model: 'm', messages: [], maxTokens: -10 }).max_tokens, 4096);
});

test('toAnthropicRequest：采样参数正确映射', () => {
  const out = toAnthropicRequest({
    model: 'm',
    messages: [],
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
    repeatPenalty: 1.1,
  });
  assert.equal(out.temperature, 0.7);
  assert.equal(out.top_p, 0.9);
  assert.equal(out.top_k, 40);
  assert.equal(out.repetition_penalty, 1.1);
});

test('toAnthropicRequest：repeatPenalty=1.0 不下发（默认值）', () => {
  const out = toAnthropicRequest({
    model: 'm', messages: [], repeatPenalty: 1.0,
  });
  assert.equal(out.repetition_penalty, undefined);
});

test('toAnthropicRequest：assistant 消息保留', () => {
  const out = toAnthropicRequest({
    model: 'm',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'bye' },
    ],
  });
  assert.equal(out.messages.length, 3);
  assert.deepEqual(out.messages[1], { role: 'assistant', content: 'hello' });
});

test('toAnthropicRequest：未知角色（如 tool）丢弃', () => {
  const out = toAnthropicRequest({
    model: 'm',
    messages: [
      { role: 'tool', content: 'result' },
      { role: 'user', content: 'hi' },
    ],
  });
  assert.equal(out.messages.length, 1);
});

/* ---------- parseAnthropicStream ---------- */

test('parseAnthropicStream：text_delta 解析为 content', () => {
  const r = parseAnthropicStream('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}');
  assert.deepEqual(r, { type: 'content_block_delta', content: 'hi' });
});

test('parseAnthropicStream：thinking_delta 解析为 reasoning', () => {
  const r = parseAnthropicStream('data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"考虑中..."}}');
  assert.deepEqual(r, { type: 'content_block_delta', reasoning: '考虑中...' });
});

test('parseAnthropicStream：message_delta 的 stop_reason 被识别', () => {
  const r = parseAnthropicStream('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}');
  assert.deepEqual(r, { type: 'message_delta', stopReason: 'end_turn' });
});

test('parseAnthropicStream：message_start 等其他事件返回 type 字段', () => {
  const r = parseAnthropicStream('data: {"type":"message_start","message":{}}');
  assert.deepEqual(r, { type: 'message_start' });
});

test('parseAnthropicStream：空行 / [DONE] / 非 data 行 → null', () => {
  assert.equal(parseAnthropicStream(''), null);
  assert.equal(parseAnthropicStream('event: ping'), null);
  assert.equal(parseAnthropicStream('data: [DONE]'), null);
});

test('parseAnthropicStream：非法 JSON → null', () => {
  assert.equal(parseAnthropicStream('data: not json'), null);
});

test('parseAnthropicStream：前后空白被消化', () => {
  const r = parseAnthropicStream('   data:   {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}  ');
  assert.equal(r.content, 'x');
});

/* ---------- ANTHROPIC_API_STYLES / pathForStyle ---------- */

test('ANTHROPIC_API_STYLES：含三种风格', () => {
  const values = ANTHROPIC_API_STYLES.map((s) => s.value);
  assert.ok(values.includes('openai'));
  assert.ok(values.includes('anthropic'));
  assert.ok(values.includes('openai-responses'));
});

test('pathForStyle：各风格返回正确路径', () => {
  assert.equal(pathForStyle('openai'), '/v1/chat/completions');
  assert.equal(pathForStyle('anthropic'), '/v1/messages');
  assert.equal(pathForStyle('openai-responses'), '/v1/responses');
  assert.equal(pathForStyle('unknown'), '/v1/chat/completions'); // 默认
});

/* ---------- buildRequestBody ---------- */

test('buildRequestBody：anthropic 走转换器', () => {
  const r = buildRequestBody('anthropic', {
    model: 'm',
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
  });
  assert.equal(r.system, 'sys');
  assert.equal(r.max_tokens, 4096);
});

test('buildRequestBody：openai / responses 原样返回', () => {
  const base = { model: 'm', messages: [], stream: true };
  assert.deepEqual(buildRequestBody('openai', base), base);
  assert.deepEqual(buildRequestBody('openai-responses', base), base);
});

/* ---------- parseStreamLine ---------- */

test('parseStreamLine：OpenAI Chat 文本增量', () => {
  const r = parseStreamLine('openai', 'data: {"choices":[{"delta":{"content":"hi"}}]}');
  assert.equal(r.content, 'hi');
  assert.equal(r.reasoning, undefined);
});

test('parseStreamLine：OpenAI Chat reasoning_content', () => {
  const r = parseStreamLine('openai', 'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}');
  assert.deepEqual(r, { content: undefined, reasoning: 'thinking...' });
});

test('parseStreamLine：Anthropic text_delta', () => {
  const r = parseStreamLine('anthropic', 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}');
  assert.equal(r.content, 'hi');
  assert.equal(r.reasoning, undefined);
});

test('parseStreamLine：[DONE] 行返回 null（不抛错）', () => {
  assert.equal(parseStreamLine('openai', 'data: [DONE]'), null);
});

test('parseStreamLine：不是 data: 前缀 → null', () => {
  assert.equal(parseStreamLine('openai', 'event: ping'), null);
});
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildArgs, argsToString } = require('../shared/args');

const BASE = {
  ngl: 'all',
  nCpuMoe: 0,
  cpuMoe: false,
  flashAttn: 'on',
  ctx: 8192,
  cacheTypeK: 'f16',
  cacheTypeV: 'f16',
  parallel: 1,
  swaFull: false,
  threads: 6,
  threadsBatch: 18,
  batch: 2048,
  ubatch: 512,
  temp: 0.7,
  topK: 40,
  topP: 0.95,
  minP: 0.05,
  repeatPenalty: 1.1,
  seed: -1,
  ropeScaling: 'none',
  yarnOrigCtx: 0,
  mlock: false,
  loadMode: 'auto',
  splitMode: 'layer',
  tensorSplit: '',
  mainGpu: 0,
  lora: '',
  samplers: 'default',
  mirostat: 0,
  mirostatLr: 0.1,
  ignoreEos: false,
  host: '127.0.0.1',
  port: 9931,
  apiKey: '',
  metrics: false,
};

function hasPair(args, flag, value) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] === String(value);
}

test('cli 模式：核心参数存在、无 server 参数', () => {
  const a = buildArgs(BASE, '/tmp/m.gguf', 'cli');
  assert.deepEqual(a.slice(0, 2), ['-m', '/tmp/m.gguf']);
  assert.ok(hasPair(a, '-ngl', 'all'));
  assert.ok(hasPair(a, '-fa', 'on'));
  assert.ok(hasPair(a, '-c', 8192));
  assert.ok(hasPair(a, '-t', 6));
  assert.ok(hasPair(a, '-tb', 18));
  assert.ok(hasPair(a, '--temp', 0.7));
  assert.ok(hasPair(a, '--top-k', 40));
  assert.ok(hasPair(a, '--top-p', 0.95));
  assert.ok(hasPair(a, '-s', -1));
  // 默认值省略
  assert.ok(!a.includes('-b'), 'batch=2048 省略');
  assert.ok(!a.includes('-ub'), 'ubatch=512 省略');
  assert.ok(!a.includes('-ctk'), 'f16 KV 省略');
  assert.ok(!a.includes('--host'), 'cli 无 --host');
  assert.ok(!a.includes('--port'), 'cli 无 --port');
});

test('server 模式：host/port/api-key/metrics', () => {
  const a = buildArgs({ ...BASE, apiKey: 'sk-test', metrics: true }, '/tmp/m.gguf', 'server');
  assert.ok(hasPair(a, '--host', '127.0.0.1'));
  assert.ok(hasPair(a, '--port', 9931));
  assert.ok(hasPair(a, '--api-key', 'sk-test'));
  assert.ok(a.includes('--metrics'));
});

test('MoE 参数与非默认 KV', () => {
  const a = buildArgs({ ...BASE, nCpuMoe: 32, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', parallel: 2 }, '/tmp/m.gguf', 'server');
  assert.ok(hasPair(a, '-ncmoe', 32));
  assert.ok(hasPair(a, '-ctk', 'q8_0'));
  assert.ok(hasPair(a, '-ctv', 'q8_0'));
  assert.ok(hasPair(a, '-np', 2));
});

test('YaRN 与高级参数', () => {
  const a = buildArgs({ ...BASE, ropeScaling: 'yarn', yarnOrigCtx: 32768, mlock: true, mirostat: 2 }, '/tmp/m.gguf', 'cli');
  assert.ok(hasPair(a, '--rope-scaling', 'yarn'));
  assert.ok(hasPair(a, '--yarn-orig-ctx', 32768));
  assert.ok(a.includes('--mlock'));
  assert.ok(hasPair(a, '--mirostat', 2));
  assert.ok(hasPair(a, '--mirostat-lr', 0.1));
});

test('ngl=auto 时省略 -ngl', () => {
  const a = buildArgs({ ...BASE, ngl: 'auto' }, '/tmp/m.gguf', 'cli');
  assert.ok(!a.includes('-ngl'));
});

test('argsToString 转义含空格路径', () => {
  const a = argsToString(['-m', '/tmp/my models/x.gguf', '-c', '8192']);
  assert.equal(a, `-m '/tmp/my models/x.gguf' -c 8192`);
});

test('argsToString 转义单引号', () => {
  const a = argsToString(['-m', "a'b.gguf"]);
  assert.ok(a.includes("'a'"), `got: ${a}`);
});

// ---------- 会话存盘（--slot-save-path，server 专属） ----------

test('会话存盘：server 模式生成 --slot-save-path，cli 模式不带', () => {
  const p = { ...BASE, slotSavePath: '/tmp/slots' };
  const srv = buildArgs(p, '/tmp/m.gguf', 'server');
  assert.ok(hasPair(srv, '--slot-save-path', '/tmp/slots'));
  const cli = buildArgs(p, '/tmp/m.gguf', 'cli');
  assert.ok(!cli.includes('--slot-save-path'), 'cli 不支持该参数，不能下发');
});

test('会话存盘：未填目录时不生成标志', () => {
  const a = buildArgs({ ...BASE, slotSavePath: '' }, '/tmp/m.gguf', 'server');
  assert.ok(!a.includes('--slot-save-path'));
  const b = buildArgs(BASE, '/tmp/m.gguf', 'server');
  assert.ok(!b.includes('--slot-save-path'), '未定义该键时同样不生成');
});

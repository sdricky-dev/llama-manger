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
  const a = buildArgs({ ...BASE, ropeScaling: 'yarn', yarnOrigCtx: 32768, loadMode: 'mlock', mirostat: 2 }, '/tmp/m.gguf', 'cli');
  assert.ok(hasPair(a, '--rope-scaling', 'yarn'));
  assert.ok(hasPair(a, '--yarn-orig-ctx', 32768));
  assert.ok(hasPair(a, '--load-mode', 'mlock'));
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

// ---------- 投机解码（--spec-type / -md / -ngld / --spec-draft-n-max） ----------

test('投机解码：草稿模型 → -md + -ngld + --spec-type', () => {
  const p = { ...BASE, specDraft: '/tmp/d.gguf', specDraftNgl: 'all', specType: 'draft-dflash' };
  const a = buildArgs(p, '/tmp/m.gguf', 'server');
  assert.ok(hasPair(a, '-md', '/tmp/d.gguf'));
  assert.ok(hasPair(a, '-ngld', 'all'));
  assert.ok(hasPair(a, '--spec-type', 'draft-dflash'));
});

test('投机解码：none 不下发 --spec-type', () => {
  const a = buildArgs({ ...BASE, specType: 'none' }, '/tmp/m.gguf', 'server');
  assert.ok(!a.includes('--spec-type'));
});

test('投机解码：MTP 模式不需要 -md', () => {
  const a = buildArgs({ ...BASE, specType: 'draft-mtp' }, '/tmp/m.gguf', 'server');
  assert.ok(hasPair(a, '--spec-type', 'draft-mtp'));
  assert.ok(!a.includes('-md'));
});

test('草稿长度：默认 3 不下发，改了才下发', () => {
  const base = { ...BASE, specType: 'draft-dflash', specDraft: '/tmp/d.gguf' };
  assert.ok(!buildArgs({ ...base, specDraftNMax: 3 }, '/tmp/m.gguf', 'server').includes('--spec-draft-n-max'));
  assert.ok(!buildArgs(base, '/tmp/m.gguf', 'server').includes('--spec-draft-n-max'));
  assert.ok(hasPair(buildArgs({ ...base, specDraftNMax: 8 }, '/tmp/m.gguf', 'server'), '--spec-draft-n-max', '8'));
  // cli 模式同样支持
  assert.ok(hasPair(buildArgs({ ...base, specDraftNMax: 8 }, '/tmp/m.gguf', 'cli'), '--spec-draft-n-max', '8'));
});

// ---------- 加载模式（上游 14a9d09f7 起 --mlock/--mmap/-dio 已被删除） ----------

/** 已从 llama.cpp 删除的加载 flag：一个都不允许再下发，否则引擎 "invalid argument" 退出 */
const REMOVED_LOAD_FLAGS = ['--mlock', '--mmap', '--no-mmap', '--direct-io', '--no-direct-io', '-dio', '-ndio'];

test('加载模式：旧字段被翻译，且绝不出现已删除的 flag', () => {
  const a = buildArgs({ mmap: true, mlock: true, directIo: true }, '/tmp/m.gguf', 'server');
  for (const gone of REMOVED_LOAD_FLAGS) {
    assert.ok(!a.includes(gone), `${gone} 已从引擎删除，不能下发`);
  }
  assert.ok(hasPair(a, '--load-mode', 'dio'), 'dio 优先级最高');
});

test('加载模式：mlock=true 单独出现 → --load-mode mlock', () => {
  const a = buildArgs({ mlock: true }, '/tmp/m.gguf', 'cli');
  assert.ok(!a.includes('--mlock'));
  assert.ok(hasPair(a, '--load-mode', 'mlock'));
});

test('加载模式：loadMode 为默认 auto 时，旧字段仍然生效（不被静默丢弃）', () => {
  const a = buildArgs({ ...BASE, mlock: true }, '/tmp/m.gguf', 'cli');
  assert.ok(hasPair(a, '--load-mode', 'mlock'));
});

test('加载模式：用户明确选过 loadMode 时以它为准（旧字段不覆盖）', () => {
  const a = buildArgs({ ...BASE, mlock: true, loadMode: 'dio' }, '/tmp/m.gguf', 'cli');
  assert.ok(hasPair(a, '--load-mode', 'dio'));
});

test('加载模式：没有任何加载字段时不下发 --load-mode', () => {
  assert.ok(!buildArgs(BASE, '/tmp/m.gguf', 'cli').includes('--load-mode'));
});

test('加载模式：迁移结果真的被采用（旧字段被剥离后不再参与拼接）', () => {
  // mmap=false 在新旧模型里都应变成 --load-mode none
  assert.ok(hasPair(buildArgs({ ...BASE, mmap: false }, '/tmp/m.gguf', 'cli'), '--load-mode', 'none'));
  // 迁移不应污染调用方传入的对象（除 _migrations 日志外）
  const p = { ...BASE, mmap: false };
  buildArgs(p, '/tmp/m.gguf', 'cli');
  assert.equal(p.mmap, false, '原对象保持原样，避免二次调用时迁移状态错乱');
});

// ---------- Agent 工具（--tools） ----------

test('tools：read_only 展开成引擎认识的具体工具名', () => {
  const a = buildArgs({ ...BASE, tools: 'read_only' }, '/tmp/m.gguf', 'server');
  assert.ok(!a.includes('read_only'), 'read_only 不是引擎取值，原样下发会让 server 启动失败');
  assert.ok(hasPair(a, '--tools', 'read_file,file_glob_search,grep_search,get_info'));
});

test('tools：none / 未设置时不下发 --tools', () => {
  assert.ok(!buildArgs({ ...BASE, tools: 'none' }, '/tmp/m.gguf', 'server').includes('--tools'));
  assert.ok(!buildArgs(BASE, '/tmp/m.gguf', 'server').includes('--tools'));
});

test('tools：all 原样下发', () => {
  assert.ok(hasPair(buildArgs({ ...BASE, tools: 'all' }, '/tmp/m.gguf', 'server'), '--tools', 'all'));
});

test('tools：引擎不认识的名字（get_datetime / http_fetch）被过滤掉', () => {
  const a = buildArgs({ ...BASE, tools: 'read_file,get_datetime,http_fetch' }, '/tmp/m.gguf', 'server');
  assert.ok(hasPair(a, '--tools', 'read_file'));
});

test('tools：cli 模式不下发 --tools', () => {
  assert.ok(!buildArgs({ ...BASE, tools: 'all' }, '/tmp/m.gguf', 'cli').includes('--tools'));
});

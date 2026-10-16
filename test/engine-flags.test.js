'use strict';
/**
 * 引擎参数漂移检查的解析层（shared/engine-flags.js）单元测试
 *
 * 这一层只做纯文本解析，因此可以用夹具覆盖各种边界；
 * 真实引擎的对照由 scripts/check-engine-flags.js 跑（需要本地 llama.cpp 构建）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractEmittedFlags, extractSupportedFlags, diffFlags } = require('../shared/engine-flags');

/* ---------- extractEmittedFlags ---------- */

test('extractEmittedFlags：两种写法都认（初始化数组 + push）', () => {
  const src = `
    const a = ['-m', String(modelPath)];
    if (x) a.push('-ngl', 'all');
    a.push('--temp', fmt(o.temp));
  `;
  const s = extractEmittedFlags(src);
  assert.ok(s.has('-m'), '初始化数组里的 flag');
  assert.ok(s.has('-ngl'));
  assert.ok(s.has('--temp'));
  assert.equal(s.size, 3);
});

test('extractEmittedFlags：参数值不会被当成 flag（-s -1 的坑）', () => {
  const s = extractEmittedFlags(`a.push('-s', fmt(o.seed)); a.push('--host', o.host || '127.0.0.1');`);
  assert.deepEqual([...s].sort(), ['--host', '-s']);
  assert.ok(!s.has('-1'), '数值 -1 不是 flag');
});

test('extractEmittedFlags：动态拼接不误收', () => {
  const s = extractEmittedFlags(`a.push(fmt(someFlag)); const b = [dynamicFlag, '-m'];`);
  assert.equal(s.size, 0);
});

test('extractEmittedFlags：空/非字符串输入安全', () => {
  assert.equal(extractEmittedFlags('').size, 0);
  assert.equal(extractEmittedFlags(null).size, 0);
  assert.equal(extractEmittedFlags(undefined).size, 0);
});

test('extractEmittedFlags：对真实的 shared/args.js —— 包含关键 flag、不含已删除的 --mlock', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'args.js'), 'utf8');
  const s = extractEmittedFlags(src);
  for (const f of ['-m', '-ngl', '--load-mode', '--spec-draft-n-ubatch', '--tools', '--slot-save-path']) {
    assert.ok(s.has(f), `应包含 ${f}`);
  }
  // 上游 14a9d09f7 已删除 --mlock/--mmap/-dio：args.js 里绝不能再出现
  for (const gone of ['--mlock', '--mmap', '--no-mmap', '-dio', '-ndio', '--direct-io']) {
    assert.ok(!s.has(gone), `${gone} 已从引擎删除，不该再下发`);
  }
});

test('extractEmittedFlags：对真实的 main/bench.js —— 不含 -c（llama-bench 没这个参数）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'bench.js'), 'utf8');
  const s = extractEmittedFlags(src);
  assert.ok(s.has('-m') && s.has('-o'), '基本参数应在');
  assert.ok(!s.has('-c'), 'llama-bench 不接受 -c，下发会让它只打印用法');
});

/* ---------- extractSupportedFlags ---------- */

test('extractSupportedFlags：解析 llama.cpp 风格帮助行', () => {
  const help = [
    'usage: llama-server [options]',
    '',
    '-m, --model FNAME                    model path to load',
    '-ngl, --n-gpu-layers N              number of layers to store in VRAM',
    '--spec-draft-n-max N                 number of tokens to draft (default: 3)',
    '--load-mode MODE                     model loading mode (default: auto)',
    '  -fa, --flash-attn [on|off|auto]    flash attention',
  ].join('\n');
  const s = extractSupportedFlags(help);
  for (const f of ['-m', '--model', '-ngl', '--n-gpu-layers', '--spec-draft-n-max', '--load-mode', '-fa', '--flash-attn']) {
    assert.ok(s.has(f), `应解析出 ${f}`);
  }
});

test('extractSupportedFlags：不把词内连字符/负数当 flag', () => {
  const s = extractSupportedFlags('well-known issue, see the 3-4 range; value -1 means random; /v1/chat/completions');
  assert.equal(s.size, 0);
});

test('extractSupportedFlags：空输入安全', () => {
  assert.equal(extractSupportedFlags('').size, 0);
  assert.equal(extractSupportedFlags(null).size, 0);
});

/* ---------- diffFlags ---------- */

test('diffFlags：全部认识 → ok', () => {
  const r = diffFlags(new Set(['-m', '--temp']), new Set(['-m', '--temp', '--other']));
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
  assert.equal(r.checked, 2);
});

test('diffFlags：报出引擎不认识的 flag（排序）', () => {
  const r = diffFlags(new Set(['--mlock', '-m', '-dio']), new Set(['-m']));
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['--mlock', '-dio']);
});

test('diffFlags：接受数组输入', () => {
  const r = diffFlags(['-c'], ['-m', '-o']);
  assert.deepEqual(r.missing, ['-c']);
});

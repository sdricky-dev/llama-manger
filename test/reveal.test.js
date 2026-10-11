'use strict';
/**
 * 「在文件夹中显示 / 打开所在文件夹」的目标解析（main/reveal.js）。
 * 纯逻辑，不触碰 fs / electron。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { containingDir, revealPlan } = require('../main/reveal');

const ABS = (p) => path.resolve(p);

test('containingDir：返回父目录的绝对路径', () => {
  assert.equal(containingDir('/models/qwen.gguf'), ABS('/models'));
  assert.equal(containingDir('/models/sub/qwen.gguf'), ABS('/models/sub'));
  assert.equal(containingDir('/models/'), ABS('/'));
});

test('containingDir：空值不抛异常', () => {
  for (const v of ['', '   ', null, undefined, 0]) {
    assert.equal(containingDir(v), '', JSON.stringify(v));
  }
});

test('revealPlan：普通文件 → 打开父目录并高亮该文件', () => {
  const p = '/models/qwen.gguf';
  const r = revealPlan(p, { exists: true, isFile: true, isDirectory: false });
  assert.equal(r.action, 'select');
  assert.equal(r.path, ABS(p));
  assert.equal(r.dir, ABS('/models'));
});

test('revealPlan：目录 → 直接打开该目录', () => {
  const r = revealPlan('/models', { exists: true, isDirectory: true });
  assert.equal(r.action, 'open');
  assert.equal(r.path, ABS('/models'));
});

test('revealPlan：文件已消失 → 报错并带上父目录（便于排查）', () => {
  const p = '/models/gone.gguf';
  const r = revealPlan(p, { exists: false });
  assert.equal(r.action, 'error');
  assert.match(r.error, /不存在/);
  assert.ok(r.error.includes(ABS(p)), '错误信息里应含完整路径');
  assert.equal(r.dir, ABS('/models'));
});

test('revealPlan：空路径 → 报错而不是崩溃', () => {
  for (const v of ['', '   ', null, undefined, 42, {}]) {
    const r = revealPlan(v, { exists: true, isFile: true });
    assert.equal(r.action, 'error', JSON.stringify(v));
  }
});

test('revealPlan：相对路径会被解析为绝对路径，首尾空格被清理', () => {
  const r = revealPlan('  models/qwen.gguf  ', { exists: true, isFile: true });
  assert.equal(r.action, 'select');
  assert.ok(path.isAbsolute(r.path));
  assert.equal(r.path, ABS('models/qwen.gguf'));
});

test('revealPlan：stat 缺失时按“不存在”处理（避免误报成功）', () => {
  assert.equal(revealPlan('/models/x.gguf', null).action, 'error');
  assert.equal(revealPlan('/models/x.gguf', undefined).action, 'error');
});

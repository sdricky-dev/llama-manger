'use strict';
/**
 * CLI 参数迁移层（shared/migrate.js）单元测试
 *
 * 覆盖 llama.cpp b11100 的 --mmap/--mlock/-dio → --load-mode 翻译
 * 与 llamafile/llamafile/args.cpp legacy_load_flag 一致
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeLoadFlags, migrateParams, migrateArgv } = require('../shared/migrate');

/* ---------- mergeLoadFlags ---------- */

test('mergeLoadFlags：dio 优先级最高', () => {
  assert.equal(mergeLoadFlags({ dio: true }), 'dio');
  assert.equal(mergeLoadFlags({ dio: true, mmap: false }), 'dio');
  assert.equal(mergeLoadFlags({ dio: true, mlock: true }), 'dio');
});

test('mergeLoadFlags：mlock + mmap → mmap+mlock', () => {
  assert.equal(mergeLoadFlags({ mlock: true, mmap: true }), 'mmap+mlock');
});

test('mergeLoadFlags：mlock 不带 mmap → mlock', () => {
  // llama.cpp 文档：--mlock 隐含 mmap，但显式 --no-mmap 时只 mlock
  assert.equal(mergeLoadFlags({ mlock: true, mmap: false }), 'mlock');
});

test('mergeLoadFlags：mmap true 显式 → mmap', () => {
  assert.equal(mergeLoadFlags({ mmap: true }), 'mmap');
});

test('mergeLoadFlags：mmap false 显式 → none', () => {
  assert.equal(mergeLoadFlags({ mmap: false }), 'none');
});

test('mergeLoadFlags：全空 → mmap（默认）', () => {
  assert.equal(mergeLoadFlags({}), 'mmap');
  assert.equal(mergeLoadFlags(), 'mmap');
});

test('mergeLoadFlags：dio=false 退回 mmap（即使 mmap 没显式）', () => {
  // -ndio 的语义：关闭 DIO，恢复默认 mmap
  assert.equal(mergeLoadFlags({ dio: false, mlock: true }), 'mmap+mlock');
});

/* ---------- migrateParams ---------- */

test('migrateParams：空对象返回空迁移', () => {
  const r = migrateParams({});
  assert.deepEqual(r.migrations, []);
  assert.equal(r.hasBreakingChanges, false);
});

test('migrateParams：null / 非对象', () => {
  const r = migrateParams(null);
  assert.deepEqual(r.migrations, []);
});

test('migrateParams：已有 loadMode 不翻译', () => {
  const r = migrateParams({ mmap: true, loadMode: 'mmap+mlock' });
  // loadMode 优先；旧的 + mmap 字段会被翻译覆盖到 loadMode，但因 loadMode 已存在不应改写
  // 但 migrateParams 的策略是：只在没有 loadMode 时才翻译旧字段
  assert.equal(r.params.loadMode, 'mmap+mlock');
  assert.equal(r.migrations.length, 0);
  // 旧字段也会被清掉（避免 buildArgs 二次处理）
  assert.equal('mmap' in r.params, false);
});

test('migrateParams：mmap true → loadMode=mmap', () => {
  const r = migrateParams({ mmap: true });
  assert.equal(r.params.loadMode, 'mmap');
  assert.ok(r.migrations.some((m) => m.from === 'mmap'));
});

test('migrateParams：mmap false → loadMode=none', () => {
  const r = migrateParams({ mmap: false });
  assert.equal(r.params.loadMode, 'none');
});

test('migrateParams：loadMode=auto 视为「没选过」，旧字段仍然生效', () => {
  // 老版本 settings.json 会同时存下 mlock 与 loadMode:'auto'，
  // 若把 auto 当成明确选择，用户的 mlock 意图会被静默丢掉
  const r = migrateParams({ mlock: true, loadMode: 'auto' });
  assert.equal(r.params.loadMode, 'mlock');
  assert.ok(r.migrations.some((m) => m.from === 'mlock'));
});

test('migrateParams：loadMode 是明确的非 auto 值时不被旧字段覆盖', () => {
  const r = migrateParams({ mlock: true, loadMode: 'dio' });
  assert.equal(r.params.loadMode, 'dio');
  assert.equal(r.migrations.length, 0);
});

test('migrateParams：mlock true + mmap true → loadMode=mmap+mlock', () => {
  const r = migrateParams({ mlock: true, mmap: true });
  assert.equal(r.params.loadMode, 'mmap+mlock');
  assert.equal(r.migrations.length, 2);
});

test('migrateParams：directIo true → loadMode=dio', () => {
  const r = migrateParams({ directIo: true });
  assert.equal(r.params.loadMode, 'dio');
});

test('migrateParams：dio 别名也认', () => {
  const r = migrateParams({ dio: true });
  assert.equal(r.params.loadMode, 'dio');
});

test('migrateParams：ndio=true 等价于 dio=false', () => {
  const r = migrateParams({ ndio: true, mlock: true });
  // ndio 关掉 dio；mlock 仍生效 → mmap+mlock
  assert.equal(r.params.loadMode, 'mmap+mlock');
});

test('migrateParams：cmoeInCpu → cpuMoe', () => {
  const r = migrateParams({ cmoeInCpu: true });
  assert.equal(r.params.cpuMoe, true);
  assert.equal(r.params.cmoeInCpu, undefined);
  assert.ok(r.migrations.some((m) => m.from === 'cmoeInCpu'));
});

test('migrateParams：旧字段被清除（避免二次翻译）', () => {
  const r = migrateParams({ mmap: true, mlock: true, directIo: false });
  assert.equal(r.params.mmap, undefined);
  assert.equal(r.params.mlock, undefined);
  assert.equal(r.params.directIo, undefined);
});

test('migrateParams：hasBreakingChanges 反映迁移存在', () => {
  assert.equal(migrateParams({}).hasBreakingChanges, false);
  assert.equal(migrateParams({ mmap: true }).hasBreakingChanges, true);
});

test('migrateParams：不影响无关字段', () => {
  const r = migrateParams({ ctx: 4096, temp: 0.7, mmap: true });
  assert.equal(r.params.ctx, 4096);
  assert.equal(r.params.temp, 0.7);
  assert.equal(r.params.loadMode, 'mmap');
});

/* ---------- migrateArgv ---------- */

test('migrateArgv：空数组', () => {
  const r = migrateArgv([]);
  assert.deepEqual(r.argv, []);
  assert.deepEqual(r.warnings, []);
});

test('migrateArgv：纯新 flag 不动', () => {
  const r = migrateArgv(['-m', '/m', '-c', '4096']);
  assert.deepEqual(r.argv, ['-m', '/m', '-c', '4096']);
  assert.deepEqual(r.warnings, []);
});

test('migrateArgv：--mmap 被替换为 --load-mode mmap', () => {
  const r = migrateArgv(['-m', '/m', '--mmap']);
  assert.deepEqual(r.argv, ['-m', '/m', '--load-mode', 'mmap']);
  assert.equal(r.warnings.length, 1);
});

test('migrateArgv：--no-mmap → --load-mode none', () => {
  const r = migrateArgv(['-m', '/m', '--no-mmap']);
  assert.deepEqual(r.argv, ['-m', '/m', '--load-mode', 'none']);
});

test('migrateArgv：--mlock 单独 → mlock', () => {
  // llama.cpp 语义：--mlock 不隐含 --mmap（与用户预期一致；只有显式 -mmap + -mlock 才 mmap+mlock）
  const r = migrateArgv(['-m', '/m', '--mlock']);
  assert.deepEqual(r.argv, ['-m', '/m', '--load-mode', 'mlock']);
});

test('migrateArgv：--mmap + --mlock → mmap+mlock', () => {
  const r = migrateArgv(['-m', '/m', '--mmap', '--mlock']);
  assert.deepEqual(r.argv, ['-m', '/m', '--load-mode', 'mmap+mlock']);
});

test('migrateArgv：-dio 覆盖 mmap/mlock', () => {
  const r = migrateArgv(['-m', '/m', '--mmap', '--mlock', '-dio']);
  assert.deepEqual(r.argv, ['-m', '/m', '--load-mode', 'dio']);
});

test('migrateArgv：--direct-io 长格式也认', () => {
  const r = migrateArgv(['--direct-io']);
  assert.deepEqual(r.argv, ['--load-mode', 'dio']);
});

test('migrateArgv：--no-direct-io 关闭 DIO', () => {
  const r = migrateArgv(['--mlock', '--no-direct-io']);
  assert.deepEqual(r.argv, ['--load-mode', 'mmap+mlock']);
});

test('migrateArgv：无老 flag 时不附加 --load-mode', () => {
  const r = migrateArgv(['-m', '/m']);
  assert.ok(!r.argv.includes('--load-mode'));
});

test('migrateArgv：警告信息含原 flag 名', () => {
  const r = migrateArgv(['--mmap']);
  assert.match(r.warnings[0], /--mmap/);
});
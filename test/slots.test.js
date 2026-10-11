'use strict';
/**
 * 会话存盘的磁盘侧操作（main/slots.js）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validateName, resolveInDir, list, remove } = require('../main/slots');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lm-slots-'));
}

test('validateName：合法名放行（含中文与点号）', () => {
  for (const n of ['doc-256k.bin', 'slot_save_file.bin', '文档 1.bin', 'a.b.c']) {
    assert.equal(validateName(n).ok, true, n);
  }
});

test('validateName：路径穿越与非法字符一律拒绝', () => {
  for (const n of ['', '.', '..', '../x', 'a/b', 'a\\b', 'x*y', 'a:b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'x\u0000y']) {
    assert.equal(validateName(n).ok, false, `应拒绝: ${JSON.stringify(n)}`);
  }
  assert.equal(validateName('x'.repeat(256)).ok, false, '超长拒绝');
});

test('resolveInDir：只能落在目录内', () => {
  const dir = tmpDir();
  assert.equal(resolveInDir(dir, 'a.bin'), path.join(dir, 'a.bin'));
  assert.throws(() => resolveInDir(dir, '../escape.bin'), /非法|越出/);
  assert.throws(() => resolveInDir(dir, '/etc/passwd'), /非法|越出/);
});

test('list：列出文件（按修改时间倒序）并忽略隐藏文件与子目录', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'old.bin'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(dir, 'new.bin'), Buffer.alloc(2500));
  fs.writeFileSync(path.join(dir, '.hidden.bin'), Buffer.alloc(10));
  fs.mkdirSync(path.join(dir, 'subdir'));
  // 调整 mtime 保证顺序确定
  const t0 = Date.now() / 1000 - 100;
  fs.utimesSync(path.join(dir, 'old.bin'), t0, t0);

  const r = list(dir);
  assert.equal(r.exists, true);
  assert.deepEqual(r.files.map((f) => f.name), ['new.bin', 'old.bin']);
  assert.equal(r.files[0].sizeBytes, 2500);
  assert.ok(r.files[0].sizeGB > 0);
  assert.ok(r.files[0].mtimeMs > r.files[1].mtimeMs);
});

test('list：目录不存在时返回 exists=false，不抛错', () => {
  const r = list(path.join(tmpDir(), 'nope'));
  assert.equal(r.exists, false);
  assert.deepEqual(r.files, []);
  assert.deepEqual(list('').files, []);
});

test('remove：删除目录内文件，拒绝穿越', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'kill.bin');
  fs.writeFileSync(f, 'x');
  remove(dir, 'kill.bin');
  assert.equal(fs.existsSync(f), false);
  assert.throws(() => remove(dir, '../outside.bin'));
});

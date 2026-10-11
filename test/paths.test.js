'use strict';
/**
 * 渲染层路径工具（renderer/paths.js，ESM）。
 * 重点覆盖 Windows 反斜杠路径 —— 这类路径在本机（macOS）上无法靠 fs 验证，
 * 但右键菜单要拼出正确路径交给系统文件管理器。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/paths.js');

test('baseName：POSIX 与 Windows 路径都能取到文件名', async () => {
  const { baseName } = await load();
  assert.equal(baseName('/Users/me/models/qwen.gguf'), 'qwen.gguf');
  assert.equal(baseName('C:\\Models\\qwen.gguf'), 'qwen.gguf');
  assert.equal(baseName('qwen.gguf'), 'qwen.gguf');
  assert.equal(baseName(''), '');
  assert.equal(baseName(null), '');
});

test('dirOf：POSIX 与 Windows 路径都能取到目录', async () => {
  const { dirOf } = await load();
  assert.equal(dirOf('/Users/me/models/qwen.gguf'), '/Users/me/models');
  assert.equal(dirOf('C:\\Models\\sub\\qwen.gguf'), 'C:\\Models\\sub');
  assert.equal(dirOf("/Users/me/models/"), "/Users/me/models", "末尾有分隔符 → 视为目录本身");
  assert.equal(dirOf('C:\\Models\\'), 'C:\\Models');
});

test('joinPath：沿用目录本身的分隔符风格', async () => {
  const { joinPath } = await load();
  assert.equal(joinPath('/Users/me/llama-slots', 'doc-256k.bin'), '/Users/me/llama-slots/doc-256k.bin');
  assert.equal(joinPath('C:\\Users\\me\\llama-slots', 'doc-256k.bin'), 'C:\\Users\\me\\llama-slots\\doc-256k.bin');
  assert.equal(joinPath('/Users/me/llama-slots/', 'a.bin'), '/Users/me/llama-slots/a.bin', '不产生双斜杠');
  assert.equal(joinPath('C:\\slots\\', 'a.bin'), 'C:\\slots\\a.bin');
});

test('joinPath + dirOf 往返一致（鼠标右键存盘文件时用得到）', async () => {
  const { dirOf, joinPath, baseName } = await load();
  for (const dir of ['/Users/me/llama-slots', 'C:\\Users\\me\\llama-slots']) {
    const full = joinPath(dir, 'chat.bin');
    assert.equal(dirOf(full), dir, dir);
    assert.equal(baseName(full), 'chat.bin', dir);
  }
});

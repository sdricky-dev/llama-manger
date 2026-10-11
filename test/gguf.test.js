'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseModelFile, parseGguf, extractModelInfo } = require('../main/gguf');
const { buildGguf } = require('./helpers');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-gguf-'));

test('parseGguf 读取合成 GGUF v3 头部', () => {
  const f = buildGguf(
    { arch: 'qwen2', nLayer: 48, ctxTrain: 32768, nEmb: 2560, nHead: 32, nKvHead: 8, headDim: 128, fileType: 23 },
    path.join(tmp, 'm1.gguf')
  );
  const g = parseGguf(f);
  assert.equal(g.version, 3);
  assert.equal(g.tensorCount, 0);
  assert.equal(g.kv['general.architecture'], 'qwen2');
  assert.equal(g.kv['qwen2.block_count'], 48);
  assert.equal(g.kv['qwen2.context_length'], 32768);
});

test('extractModelInfo 完整字段（dense 模型）', () => {
  const f = buildGguf(
    { arch: 'llama', nLayer: 32, ctxTrain: 131072, nEmb: 4096, nHead: 32, nKvHead: 4, headDim: 128, fileType: 23 },
    path.join(tmp, 'm2.gguf')
  );
  const meta = parseGguf(f);
  const info = extractModelInfo(meta, f, null);
  assert.equal(info.arch, 'llama');
  assert.equal(info.nLayer, 32);
  assert.equal(info.ctxTrain, 131072);
  assert.equal(info.nEmb, 4096);
  assert.equal(info.nHead, 32);
  assert.equal(info.nKvHead, 4);
  assert.equal(info.headDim, 128);
  assert.equal(info.isMoe, false);
  assert.equal(info.quant, 'Q4_K_M');
  assert.equal(Math.round(info.sizeGB * 100) / 100, 0); // 空张量文件 ≈ 0
});

test('extractModelInfo MoE 字段', () => {
  const f = buildGguf(
    { arch: 'qwen2moe', nLayer: 64, expertCount: 64, expertShared: 0, fileType: 23 },
    path.join(tmp, 'm3.gguf')
  );
  const info = extractModelInfo(parseGguf(f), f, null);
  assert.equal(info.isMoe, true);
  assert.equal(info.expertCount, 64);
  assert.equal(info.expertShared, 0);
});

test('parseModelFile 组合 + nameOverride', () => {
  const f = buildGguf({ arch: 'llama', nLayer: 10 }, path.join(tmp, 'my-model.gguf'));
  const info = parseModelFile(f, 'override-name');
  assert.equal(info.name, 'override-name');
  assert.ok(info.path.endsWith('my-model.gguf'));
});

test('非 GGUF 文件抛错', () => {
  const f = path.join(tmp, 'notgguf.bin');
  fs.writeFileSync(f, Buffer.from('hello world, definitely not gguf'));
  assert.throws(() => parseGguf(f), /GGUF/);
});

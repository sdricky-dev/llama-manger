'use strict';
/**
 * 引擎 Metal 能力哨兵（shared/engine-caps.js）单元测试
 *
 * 覆盖：日志解析 / 芯片白名单 / 界面判定（正常、降级、不该打扰的机型）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { chipExpectsTensor, parseEngineCaps, metalVerdict } = require('../shared/engine-caps');

const M5_LOG = [
  'ggml_metal_device_init: GPU name:   MTL0 (Apple M5 Max)',
  'ggml_metal_device_init: has bfloat            = true',
  'ggml_metal_device_init: has tensor            = true',
  'ggml_metal_library_init: using embedded metal library',
].join('\n');

test('parseEngineCaps：解析 GPU 名 / tensor / bfloat / 内嵌 metallib', () => {
  const c = parseEngineCaps(M5_LOG);
  assert.equal(c.gpuName, 'Apple M5 Max');
  assert.equal(c.hasTensor, true);
  assert.equal(c.hasBfloat, true);
  assert.equal(c.embeddedMetal, true);
});

test('parseEngineCaps：has tensor = false 也认', () => {
  assert.equal(parseEngineCaps('ggml_metal_device_init: has tensor            = false').hasTensor, false);
});

test('parseEngineCaps：无关日志返回 null', () => {
  assert.equal(parseEngineCaps('llama_model_loader: loaded meta data'), null);
  assert.equal(parseEngineCaps(''), null);
});

test('chipExpectsTensor：与上游白名单一致（M5/M6/A19/A20）', () => {
  for (const chip of ['Apple M5', 'Apple M5 Max', 'Apple M6 Pro', 'iPhone A19', 'Apple A20']) {
    assert.equal(chipExpectsTensor(chip), true, chip);
  }
  for (const chip of ['Apple M4 Max', 'Apple M2 Ultra', 'Apple A18', 'AMD Ryzen 9']) {
    assert.equal(chipExpectsTensor(chip), false, chip);
  }
});

test('metalVerdict：M5 + tensor 开 → ok', () => {
  const v = metalVerdict({ platform: 'darwin', chip: 'Apple M5 Max', caps: parseEngineCaps(M5_LOG) });
  assert.equal(v.level, 'ok');
  assert.match(v.text, /神经加速器/);
});

test('metalVerdict：M5 + tensor 关 → 红色警告（说明会慢约 2.8×）', () => {
  const v = metalVerdict({ platform: 'darwin', chip: 'Apple M5 Max', caps: { hasTensor: false } });
  assert.equal(v.level, 'bad');
  assert.match(v.title, /2\.8×/);
  assert.match(v.title, /GGML_METAL_TENSOR_DISABLE/);
});

test('metalVerdict：M2/M4 关闭是上游默认，不打扰', () => {
  assert.equal(metalVerdict({ platform: 'darwin', chip: 'Apple M4 Max', caps: { hasTensor: false } }).level, 'none');
});

test('metalVerdict：非 macOS 一律不显示', () => {
  assert.equal(metalVerdict({ platform: 'win32', chip: 'RTX 4090', caps: { hasTensor: true } }).level, 'none');
  assert.equal(metalVerdict({}).level, 'none');
});

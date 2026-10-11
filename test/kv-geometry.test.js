'use strict';
/**
 * KV 缓存的「层数与几何」推导（main/gguf.js + main/recommend.js）。
 *
 * 背景：这类模型如果按「全部层 × 每层 KV 头数 × 头维」估 KV，会错好几倍。
 * 三类真实情况（都用引擎日志核对过）：
 *   1. Qwen3.8/3.5 混合 SSM：65 层里只有 16 层存 KV，另有 1 层是 MTP
 *   2. 只有 full_attention_interval、没有 recurrent_layers 的同族模型
 *   3. gemma4 滑动窗口：逐层 KV 头数不同 + SWA 层头维更小
 * 期望值来源：llama-server -v 日志里的
 *   "llama_kv_cache: size = ... (N cells, 16 layers, ...), K (q8_0): ..., V (q8_0): ..."
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseModelFile } = require('../main/gguf');
const { kvBytesPerToken, KV_ELEM_BYTES } = require('../main/recommend');
const { buildGguf } = require('./helpers');

function tmp(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-kv-')), name);
}

/** 构造 Qwen3.8 风格的交替数组：每 interval 层的最后一层是全注意力层 */
function hybridFlags(nLayer, interval) {
  return Array.from({ length: nLayer }, (_, i) => (i + 1) % interval !== 0); // true = SSM
}

/** 与真实 Swift-1.5-Qwen3.8 文件一致：末尾那层（MTP 层）也被标成非 recurrent */
function realSwiftFlags(nLayer, interval) {
  return Array.from(
    { length: nLayer },
    (_, i) => !((i + 1) % interval === 0 || i === nLayer - 1)
  );
}

test('recurrent_layers：数的是「非 recurrent」层（不能数 true）', () => {
  const nLayer = 65;
  const recurrent = realSwiftFlags(nLayer, 4); // 48 个 true（SSM）+ 17 个 false
  const p = tmp('hybrid.gguf');
  buildGguf(
    {
      arch: 'qwen35',
      nLayer,
      nEmb: 5120,
      nHead: 24,
      nKvHead: 4,
      headDim: 256,
      extraKv: {
        'qwen35.attention.recurrent_layers': { type: 9, elem: 7, values: recurrent },
        'qwen35.attention.key_length': { type: 10, value: 256 },
      },
    },
    p
  );
  const m = parseModelFile(p);
  assert.equal(recurrent.filter(Boolean).length, 48, '前置条件：48 个 SSM 层');
  assert.equal(m.nAttnLayer, 17, 'KV 层 = false 的个数（17）');
  assert.equal(m.kvGeometry.layers, 65);
});

test('nextn(MTP) 层不占主模型 KV', () => {
  const nLayer = 65;
  const p = tmp('mtp.gguf');
  buildGguf(
    {
      arch: 'qwen35',
      nLayer,
      nEmb: 5120,
      nHead: 24,
      nKvHead: 4,
      headDim: 256,
      extraKv: {
        'qwen35.attention.recurrent_layers': { type: 9, elem: 7, values: hybridFlags(nLayer, 4) },
        'qwen35.nextn_predict_layers': { type: 10, value: 1 },
      },
    },
    p
  );
  const m = parseModelFile(p);
  assert.equal(m.nextnLayers, 1);
  assert.equal(m.kvGeometry.layers, 64, '参与 KV 的层 = 65 - 1');
  assert.equal(m.nAttnLayer, 16, '与引擎日志一致：16 层');
});

test('没有 recurrent_layers 时按 full_attention_interval 推 KV 层数', () => {
  const nLayer = 65;
  const p = tmp('interval.gguf');
  buildGguf(
    {
      arch: 'qwen35',
      nLayer,
      nEmb: 5120,
      nHead: 24,
      nKvHead: 4,
      headDim: 256,
      extraKv: {
        'qwen35.full_attention_interval': { type: 10, value: 4 },
        'qwen35.nextn_predict_layers': { type: 10, value: 1 },
      },
    },
    p
  );
  const m = parseModelFile(p);
  assert.equal(m.nAttnLayer, 16, '64 / 4 = 16（引擎日志同样是 16 层）');
  assert.equal(m.kvGeometry.interval, 4);
});

test('Swift 实机口径：256K q8_0 KV = 8704 MiB（与引擎日志一致）', () => {
  const nLayer = 65;
  const p = tmp('swift.gguf');
  buildGguf(
    {
      arch: 'qwen35',
      nLayer,
      nEmb: 5120,
      nHead: 24,
      nKvHead: 4,
      headDim: 256,
      extraKv: {
        'qwen35.attention.recurrent_layers': { type: 9, elem: 7, values: hybridFlags(nLayer, 4) },
        'qwen35.nextn_predict_layers': { type: 10, value: 1 },
        'qwen35.attention.key_length': { type: 10, value: 256 },
      },
    },
    p
  );
  const m = parseModelFile(p);
  const perTok = kvBytesPerToken(m, 'q8_0', 'q8_0');
  // 引擎：262144 cells → K 4352 MiB + V 4352 MiB
  assert.equal(perTok, 1088 * 32, '每 token 34.8KB');
  const mib = (perTok * 262144) / (1024 * 1024);
  assert.ok(Math.abs(mib - 8704) < 1, `256K q8_0 ≈ 8704 MiB，实际 ${mib.toFixed(1)}`);
  // f16 应为 q8_0 的 2/1.0625 倍
  const f16 = kvBytesPerToken(m, 'f16', 'f16') * 262144;
  assert.ok(Math.abs(f16 / 1e9 - 17.18) < 0.05, `f16 ≈ 17.18GB，实际 ${(f16 / 1e9).toFixed(2)}`);
});

test('gemma4 滑动窗口：逐层 KV 头数 + SWA 头维都要算进去', () => {
  const nLayer = 30;
  // 每 6 层一层全注意力：KV 头 2、头维 512；其余 SWA：KV 头 8、头维 256
  const heads = Array.from({ length: nLayer }, (_, i) => ((i + 1) % 6 === 0 ? 2 : 8));
  const swa = Array.from({ length: nLayer }, (_, i) => (i + 1) % 6 !== 0);
  const p = tmp('gemma4.gguf');
  buildGguf(
    {
      arch: 'gemma4',
      nLayer,
      nEmb: 2816,
      nHead: 16,
      nKvHead: 8,
      headDim: 512,
      extraKv: {
        'gemma4.attention.head_count_kv': { type: 9, elem: 10, values: heads },
        'gemma4.attention.sliding_window_pattern': { type: 9, elem: 7, values: swa },
        'gemma4.attention.key_length': { type: 10, value: 512 },
        'gemma4.attention.key_length_swa': { type: 10, value: 256 },
        'gemma4.attention.value_length': { type: 10, value: 512 },
        'gemma4.attention.value_length_swa': { type: 10, value: 256 },
      },
    },
    p
  );
  const m = parseModelFile(p);
  assert.equal(m.nAttnLayer, 30, 'gemma4 每层都有 KV');
  assert.equal(m.kvGeometry.perLayerHeads, true);
  assert.equal(m.kvGeometry.swa, 25, '25 个 SWA 层');
  assert.equal(m.nKvHead, 8, '展示用取逐层最大值');
  // 25×8×256 + 5×2×512 = 51200 + 5120 = 56320 元素/token
  assert.equal(m.kvUnitsK, 56320);
  assert.equal(m.kvUnitsV, 56320);
  const perTok = kvBytesPerToken(m, 'f16', 'f16');
  assert.equal(perTok, 56320 * 4, 'f16：K+V 各 2 字节');
  // 若按旧的「全层 × nKvHead × headDim」会高估到 30×16×512×4 = 983040 B/token
  const old = 30 * 16 * 512 * 4;
  assert.ok(perTok < old / 4, `修正后应显著低于旧口径（${perTok} vs ${old}）`);
});

test('普通稠密模型不受影响：KV 层数 = 层数', () => {
  const p = tmp('llama.gguf');
  buildGguf({ arch: 'llama', nLayer: 32, nEmb: 4096, nHead: 32, nKvHead: 8, headDim: 128 }, p);
  const m = parseModelFile(p);
  assert.equal(m.nAttnLayer, 32);
  assert.equal(m.nextnLayers, 0);
  assert.equal(kvBytesPerToken(m, 'f16', 'f16'), 32 * 8 * 128 * 4);
});

test('KV_ELEM_BYTES 用 ggml 块量化的精确值', () => {
  assert.equal(KV_ELEM_BYTES.f16, 2);
  assert.equal(KV_ELEM_BYTES.f32, 4);
  assert.equal(KV_ELEM_BYTES.q8_0, 34 / 32); // 1.0625（引擎实测一致）
  assert.equal(KV_ELEM_BYTES.q4_0, 18 / 32);
  assert.equal(KV_ELEM_BYTES.q5_1, 24 / 32);
});

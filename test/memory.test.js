'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryBreakdown } = require('../main/recommend');

const HW = { ramGB: 64, freeGB: 40, pCores: 6, eCores: 12, totalCores: 18, isAppleSilicon: true };

const MODEL = {
  nLayer: 32,
  nKvHead: 8,
  headDim: 128,
  sizeBytes: 8e9,
  isMoe: false,
};

test('ngl=all：全部权重驻 GPU', () => {
  const m = memoryBreakdown({
    model: MODEL,
    params: { ngl: 'all', ctx: 8192, parallel: 1, cacheTypeK: 'f16', cacheTypeV: 'f16', batch: 2048 },
    hw: HW,
  });
  assert.equal(m.wGpu, 8e9);
  assert.equal(m.wCpu, 0);
  assert.ok(m.ok, '8GB 模型应装得下');
  // KV = 32×8×128×4×8192 = 1 GiB
  assert.equal(m.kv, 32 * 8 * 128 * 4 * 8192);
});

test('ngl 部分卸载按比例', () => {
  const m = memoryBreakdown({
    model: MODEL,
    params: { ngl: 16, ctx: 4096, parallel: 1, cacheTypeK: 'f16', cacheTypeV: 'f16', batch: 2048 },
    hw: HW,
  });
  assert.equal(m.wGpu, 4e9);
  assert.equal(m.wCpu, 4e9);
});

test('MoE：ncpuMoe=nLayer 时 GPU 只留 15% 权重', () => {
  const moe = { ...MODEL, isMoe: true, sizeBytes: 30e9 };
  const m = memoryBreakdown({
    model: moe,
    params: { ngl: 'all', nCpuMoe: 32, ctx: 8192, parallel: 1, cacheTypeK: 'f16', cacheTypeV: 'f16', batch: 2048 },
    hw: HW,
  });
  assert.ok(Math.abs(m.wGpu - 30e9 * 0.15) / 30e9 < 0.001, `wGpu=${m.wGpu}`);
  assert.ok(Math.abs(m.wCpu - 30e9 * 0.85) / 30e9 < 0.001);
});

test('并行数放大 KV', () => {
  const a = memoryBreakdown({
    model: MODEL,
    params: { ngl: 'all', ctx: 8192, parallel: 1, cacheTypeK: 'f16', cacheTypeV: 'f16', batch: 2048 },
    hw: HW,
  });
  const b = memoryBreakdown({
    model: MODEL,
    params: { ngl: 'all', ctx: 8192, parallel: 4, cacheTypeK: 'f16', cacheTypeV: 'f16', batch: 2048 },
    hw: HW,
  });
  assert.equal(b.kv, a.kv * 4);
});

test('内存不足 → ok=false 且 free 为负', () => {
  const big = { ...MODEL, sizeBytes: 55e9 };
  const m = memoryBreakdown({
    model: big,
    params: { ngl: 'all', ctx: 131072, parallel: 1, cacheTypeK: 'f16', cacheTypeV: 'f16', batch: 2048 },
    hw: HW,
  });
  assert.equal(m.ok, false);
  assert.ok(m.free < 0);
  assert.ok(m.total > m.usable);
});

test('q8_0 KV 比 f16 省约一半', () => {
  const f16 = memoryBreakdown({
    model: MODEL,
    params: { ngl: 'all', ctx: 32768, parallel: 1, cacheTypeK: 'f16', cacheTypeV: 'f16', batch: 2048 },
    hw: HW,
  });
  const q8 = memoryBreakdown({
    model: MODEL,
    params: { ngl: 'all', ctx: 32768, parallel: 1, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', batch: 2048 },
    hw: HW,
  });
  assert.ok(q8.kv < f16.kv * 0.6, `q8=${q8.kv} f16=${f16.kv}`);
});

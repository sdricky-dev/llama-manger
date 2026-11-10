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

test('并行数：KV 池总量不变（-c 即池大小，引擎按槽切分）', () => {
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
  assert.equal(b.kv, a.kv, '并行 4：4 槽 × 2048 cells = 8192，总量与串行一致');
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

const MIB = 1024 * 1024;

test('moeCacheMib：MoE 专家留 CPU 时 GPU 缓存独立计入总占用（统一内存）', () => {
  const moe = { ...MODEL, isMoe: true, sizeBytes: 30e9 };
  const base = { ngl: 'all', nCpuMoe: 32, ctx: 8192, parallel: 1, cacheTypeK: 'f16', cacheTypeV: 'f16', batch: 2048 };
  const off = memoryBreakdown({ model: moe, params: base, hw: HW });
  const on = memoryBreakdown({ model: moe, params: { ...base, moeCacheMib: 1024 }, hw: HW });
  assert.equal(off.moeCache || 0, 0);
  assert.equal(on.moeCache, 1024 * MIB);
  assert.equal(on.total, off.total + 1024 * MIB, '缓存计入总占用');
  assert.equal(on.free, off.free - 1024 * MIB);
});

test('moeCacheMib：非 MoE / 专家全在 GPU 时不计入', () => {
  const base = { ngl: 'all', nCpuMoe: 32, ctx: 8192, parallel: 1, cacheTypeK: 'f16', cacheTypeV: 'f16', batch: 2048, moeCacheMib: 1024 };
  const dense = memoryBreakdown({ model: MODEL, params: base, hw: HW });
  assert.equal(dense.moeCache || 0, 0, '稠密模型不计 MoE 缓存');
  const moeNoCpu = memoryBreakdown({ model: { ...MODEL, isMoe: true, sizeBytes: 30e9 }, params: { ...base, nCpuMoe: 0 }, hw: HW });
  assert.equal(moeNoCpu.moeCache || 0, 0, '专家全在 GPU 时不需要缓存');
});

test('moeCacheMib：独立显卡计入显存侧 vram.used', () => {
  const moe = { ...MODEL, isMoe: true, sizeBytes: 30e9 };
  const pcHw = { ramGB: 64, isAppleSilicon: false, unifiedMemory: false, gpu: { vramGB: 24 } };
  const base = { ngl: 'all', nCpuMoe: 32, ctx: 8192, parallel: 1, cacheTypeK: 'f16', cacheTypeV: 'f16', batch: 2048, kvOffload: true };
  const off = memoryBreakdown({ model: moe, params: base, hw: pcHw });
  const on = memoryBreakdown({ model: moe, params: { ...base, moeCacheMib: 1024 }, hw: pcHw });
  assert.equal(on.vram.moeCache, 1024 * MIB);
  assert.equal(on.vram.used, off.vram.used + 1024 * MIB);
  assert.equal(on.total, off.total + 1024 * MIB);
});

test('nCpuFfn：稠密模型前 N 层 FFN 权重移到 CPU（统一内存改占比、总量不变）', () => {
  const base = { ngl: 'all', ctx: 8192, parallel: 1, cacheTypeK: 'f16', cacheTypeV: 'f16', batch: 2048 };
  const off = memoryBreakdown({ model: MODEL, params: base, hw: HW });
  const on = memoryBreakdown({ model: MODEL, params: { ...base, nCpuFfn: 16 }, hw: HW });
  // FFN 比例 0.65 × (16/32) = 0.325 的权重从 GPU 移到 CPU → wGpu = 全量时的 0.675
  assert.ok(Math.abs(on.wGpu - off.wGpu * 0.675) < 1e6, `wGpu=${on.wGpu} 期望≈${off.wGpu * 0.675}`);
  assert.ok(Math.abs((off.wGpu - on.wGpu) - (on.wCpu - off.wCpu)) < 1e6, '移出=移入');
  assert.equal(on.total, off.total, '统一内存总量不随卸载改变');
});

test('nCpuFfn：独立显卡把稠密 FFN 权重折到内存侧', () => {
  const pcHw = { ramGB: 64, isAppleSilicon: false, unifiedMemory: false, gpu: { vramGB: 24 } };
  const base = { ngl: 'all', ctx: 8192, parallel: 1, cacheTypeK: 'f16', cacheTypeV: 'f16', batch: 2048, kvOffload: true };
  const off = memoryBreakdown({ model: MODEL, params: base, hw: pcHw });
  const on = memoryBreakdown({ model: MODEL, params: { ...base, nCpuFfn: 16 }, hw: pcHw });
  assert.ok(on.wGpu < off.wGpu, '显存权重下降');
  assert.ok(on.wCpu > off.wCpu, '内存权重上升');
  assert.equal(on.total, off.total, '总量不变');
});

test('nCpuFfn：MoE 模型忽略（FFN 卸载只作用于稠密模型）', () => {
  const moe = { ...MODEL, isMoe: true, sizeBytes: 30e9 };
  const base = { ngl: 'all', nCpuMoe: 32, ctx: 8192, parallel: 1, cacheTypeK: 'f16', cacheTypeV: 'f16', batch: 2048, nCpuFfn: 16 };
  const m = memoryBreakdown({ model: moe, params: base, hw: HW });
  assert.ok(Math.abs(m.wGpu - 30e9 * 0.15) / 30e9 < 0.001, `MoE 的 wGpu 只应由 nCpuMoe 决定：${m.wGpu}`);
});

const draftModel = () => ({
  ...MODEL,
  isMoe: false,
  companions: { mmproj: [], draft: [{ path: '/tmp/d.gguf', sizeBytes: 2e9, nLayer: 16 }] },
});

test('草稿 MoE 卸载：specDraftCpuMoe 把草稿专家权重折到内存侧（独立显卡）', () => {
  const pcHw = { ramGB: 64, isAppleSilicon: false, unifiedMemory: false, gpu: { vramGB: 24 } };
  const withDraft = draftModel();
  const base = { ngl: 'all', ctx: 8192, parallel: 1, cacheTypeK: 'f16', cacheTypeV: 'f16', batch: 2048, kvOffload: true, specDraft: '/tmp/d.gguf', specDraftNgl: 'all' };
  const onGpu = memoryBreakdown({ model: withDraft, params: base, hw: pcHw });
  const off = memoryBreakdown({ model: withDraft, params: { ...base, specDraftCpuMoe: true }, hw: pcHw });
  assert.ok(Math.abs((onGpu.vram.used - off.vram.used) - 2e9 * 0.85) < 1e6, `显存少 ${onGpu.vram.used - off.vram.used}`);
  assert.equal(off.total, onGpu.total, '总量不变');
});

test('草稿 MoE 卸载：specDraftNCpuMoe 按层比例折减', () => {
  const pcHw = { ramGB: 64, isAppleSilicon: false, unifiedMemory: false, gpu: { vramGB: 24 } };
  const withDraft = draftModel();
  const base = { ngl: 'all', ctx: 8192, parallel: 1, cacheTypeK: 'f16', cacheTypeV: 'f16', batch: 2048, kvOffload: true, specDraft: '/tmp/d.gguf', specDraftNgl: 'all' };
  const onGpu = memoryBreakdown({ model: withDraft, params: base, hw: pcHw });
  const half = memoryBreakdown({ model: withDraft, params: { ...base, specDraftNCpuMoe: 8 }, hw: pcHw });
  assert.ok(Math.abs((onGpu.vram.used - half.vram.used) - 2e9 * 0.85 * 0.5) < 1e6, `显存少 ${onGpu.vram.used - half.vram.used}`);
});

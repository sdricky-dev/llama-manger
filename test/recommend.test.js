'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  kvBytesPerToken,
  kvCacheBytes,
  usableRamGB,
  fits,
  recommend,
  companionBytes,
} = require('../main/recommend');

// M5 Max 64GB
const HW = {
  platform: 'darwin',
  chip: 'Apple M5 Max',
  pCores: 6,
  eCores: 12,
  totalCores: 18,
  ramGB: 64,
  freeGB: 40,
  isAppleSilicon: true,
  gpu: { name: 'Apple M5 Max', cores: 40, metal: 'Metal 4' },
};

// 8GB dense 模型（32 层 / 8 KV 头 / 头维 128 / 训练 32K）
const DENSE = {
  path: '/tmp/d.gguf',
  arch: 'llama',
  nLayer: 32,
  ctxTrain: 32768,
  nEmb: 4096,
  nHead: 32,
  nKvHead: 8,
  headDim: 128,
  isMoe: false,
  expertCount: 0,
  expertShared: 0,
  quant: 'Q4_K_M',
  sizeBytes: 8e9,
  sizeGB: 8,
};

test('kvBytesPerToken f16 = 层×KV头×头维×4', () => {
  assert.equal(kvBytesPerToken(DENSE, 'f16', 'f16'), 32 * 8 * 128 * 4); // 128KB
});

test('kvBytesPerToken q8_0 比 f16 省约一半', () => {
  const q8 = kvBytesPerToken(DENSE, 'q8_0', 'q8_0');
  const f16 = kvBytesPerToken(DENSE, 'f16', 'f16');
  assert.ok(q8 < f16 * 0.6 && q8 > f16 * 0.4, `q8=${q8} f16=${f16}`);
});

test('kvCacheBytes 随 ctx 与 parallel 线性', () => {
  const p1 = kvCacheBytes(DENSE, { ctx: 8192, parallel: 1, cacheTypeK: 'f16', cacheTypeV: 'f16' });
  const p2 = kvCacheBytes(DENSE, { ctx: 16384, parallel: 2, cacheTypeK: 'f16', cacheTypeV: 'f16' });
  assert.equal(p2, p1 * 4);
});

test('usableRamGB 保留 8GB 或 20%', () => {
  assert.equal(usableRamGB({ ramGB: 64 }), 64 - 12.8); // 20% > 8GB
  assert.equal(usableRamGB({ ramGB: 32 }), 32 - 8); // 8GB = 25%
});

test('fits 判断', () => {
  const small = { ...DENSE, sizeBytes: 4e9 };
  assert.ok(fits({ model: small, ctx: 4096, kType: 'f16', vType: 'f16', parallel: 1, usableGB: 8 }));
  assert.ok(!fits({ model: DENSE, ctx: 131072, kType: 'f16', vType: 'f16', parallel: 8, usableGB: 8 }));
});

test('recommend：dense 模型 → ngl=all / 上下文封顶在训练长度（不超出，无 YaRN）', () => {
  const { params, notes, ropeSuggested } = recommend({ hw: HW, model: DENSE });
  assert.equal(params.ngl, 'all');
  assert.equal(params.threads, 6); // P 核
  assert.equal(params.threadsBatch, 18); // 总核
  assert.equal(params.nCpuMoe, 0);
  assert.equal(params.parallel, 1);
  // 训练长度只有 32K：不再盲目顶到 128K，避免超出训练长度
  assert.equal(params.ctx, 32768);
  assert.equal(params.cacheTypeK, 'f16');
  assert.equal(ropeSuggested, false, '未超训练长度，不应建议 YaRN');
  assert.equal(params.ropeScaling, 'none');
  assert.ok(notes.some((n) => n.includes('已用满模型训练长度')));
});

test('recommend：256K 训练长度的模型 → 优先拉满 256K，KV 自动降到 q8_0', () => {
  // 27B / 65 层（48 注意力层）/ 4 KV 头 / 头维 256 / 训练 256K —— 对应真实模型
  const long = {
    ...DENSE,
    nLayer: 65,
    nAttnLayer: 48,
    nHead: 24,
    nKvHead: 4,
    headDim: 256,
    ctxTrain: 262144,
    sizeBytes: 12.12e9,
    sizeGB: 12.12,
  };
  const { params, notes, ropeSuggested } = recommend({ hw: HW, model: long });
  assert.equal(params.ctx, 262144, '应拉满到训练长度 256K');
  assert.equal(params.cacheTypeK, 'q8_0', 'f16 KV 放不下 256K，应降到 q8_0');
  assert.equal(params.cacheTypeV, 'q8_0');
  assert.equal(ropeSuggested, false);
  assert.ok(notes.some((n) => n.includes('q8_0') && n.includes('256K')), '应说明为何降 KV 精度');
  assert.ok(notes.some((n) => n.includes('已用满模型训练长度')));
});

test('recommend：附属文件（mmproj）计入内存后上下文会相应变小', () => {
  const long = {
    ...DENSE,
    nLayer: 65,
    nAttnLayer: 48,
    nKvHead: 4,
    headDim: 256,
    ctxTrain: 262144,
    sizeBytes: 12.12e9,
    sizeGB: 12.12,
  };
  const mmproj = { path: '/tmp/mm.gguf', name: 'mm', quant: 'bf16', sizeBytes: 20e9, sizeGB: 20 };
  const withMm = { ...long, companions: { mmproj: [mmproj], draft: [] } };
  const a = recommend({ hw: HW, model: long });
  const b = recommend({ hw: HW, model: withMm, params: { mmproj: mmproj.path } });
  assert.equal(a.params.ctx, 262144);
  // 多占 20GB 后 256K 装不下 → 上下文必须退档
  assert.ok(b.params.ctx < a.params.ctx, `带 mmproj 的 ctx(${b.params.ctx}) 应小于不带(${a.params.ctx})`);
  assert.equal(b.params.ctx, 131072);
  assert.ok(b.notes.some((n) => n.includes('q8_0')));
  // companionBytes 能正确累加
  assert.equal(companionBytes(withMm, { mmproj: mmproj.path }), 20e9);
  assert.equal(companionBytes(withMm, {}), 0, '未启用时不计入');
});

test('recommend：超大 MoE → 专家层留 CPU + q8_0 KV 降级', () => {
  const moe = {
    ...DENSE,
    nLayer: 48,
    isMoe: true,
    expertCount: 128,
    expertShared: 8,
    sizeBytes: 35e9,
    sizeGB: 35,
    ctxTrain: 262144,
  };
  const { params, notes } = recommend({ hw: HW, model: moe });
  assert.equal(params.nCpuMoe, 48, '35GB > 0.6×51.2GB → 专家全留 CPU');
  // f16@131072: 35+25.8+2=62.8 装不下；q8_0@131072: 35+13.3+2=50.3 ≤ 51.2 → 选 q8_0 + 128K
  assert.equal(params.ctx, 131072);
  assert.equal(params.cacheTypeK, 'q8_0');
  assert.ok(notes.some((n) => n.includes('MoE')));
});

test('recommend：内存紧张 → q8_0 KV 降级并提示', () => {
  const small = { ...DENSE, sizeBytes: 44e9, sizeGB: 44, nLayer: 32, ctxTrain: 262144 };
  const { params, notes } = recommend({ hw: HW, model: small });
  // f16/q8_0 在 98304 及以上都超；q8_0 @65536: 44+4.4+2=50.4 ≤ 51.2 ✓
  assert.equal(params.cacheTypeK, 'q8_0');
  assert.equal(params.cacheTypeV, 'q8_0');
  assert.equal(params.ctx, 65536);
  assert.ok(notes.some((n) => n.includes('q8_0')));
});

test('recommend：投机解码按模型能力给默认值', () => {
  const withMtp = { ...DENSE, hasMtp: true, companions: { mmproj: [], draft: [] } };
  const plain = { ...DENSE, hasMtp: false, companions: { mmproj: [], draft: [] } };
  assert.equal(recommend({ hw: HW, model: withMtp }).params.specType, 'draft-mtp');
  assert.equal(recommend({ hw: HW, model: plain }).params.specType, 'none');
  const draft = { path: '/tmp/draft.gguf', name: 'd', arch: 'dflash', quant: 'Q4_K_S', sizeBytes: 1.1e9, sizeGB: 1.1 };
  const withDraft = { ...DENSE, hasMtp: false, companions: { mmproj: [], draft: [draft] } };
  const r = recommend({ hw: HW, model: withDraft });
  assert.equal(r.params.specType, 'draft-dflash');
  assert.equal(r.params.specDraft, draft.path);
  assert.ok(r.notes.some((n) => n.includes('草稿模型')));
});

test('recommend：小模型不触发 MoE 卸载', () => {
  const tiny = { ...DENSE, sizeBytes: 2e9, sizeGB: 2, isMoe: true, expertCount: 32 };
  const { params } = recommend({ hw: HW, model: tiny });
  assert.equal(params.nCpuMoe, 0, '2GB < 0.6×51.2GB');
});

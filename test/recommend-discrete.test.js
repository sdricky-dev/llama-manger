'use strict';
/**
 * 独立显卡（PC）的显存/内存双预算推荐。
 * 用假的 Windows 硬件数据驱动，验证各策略分支与参数落地。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { planDiscreteGpu, recommend } = require('../main/recommend');
const { buildArgs } = require('../shared/args');

// 27B IQ3_S：12.12GB / 65 层（48 注意力层）/ 4 KV 头 / 头维 256 / 训练 256K
const MODEL = {
  path: '/m.gguf',
  arch: 'qwen35',
  nLayer: 65,
  nAttnLayer: 48,
  nHead: 24,
  nKvHead: 4,
  headDim: 256,
  ctxTrain: 262144,
  isMoe: false,
  expertCount: 0,
  sizeBytes: 12.12e9,
  sizeGB: 12.12,
  quant: 'IQ3_S',
};
const MOE_MODEL = { ...MODEL, isMoe: true, expertCount: 128, sizeBytes: 35e9, sizeGB: 35 };

const winHw = (vramGB, ramGB) => ({
  platform: 'win32',
  arch: 'x64',
  chip: 'AMD Ryzen 9 7950X',
  pCores: 16,
  eCores: 0,
  totalCores: 32,
  ramGB,
  freeGB: ramGB * 0.6,
  gpu: { name: 'NVIDIA GeForce RTX', cores: null, vramGB, vendor: 'nvidia' },
  isAppleSilicon: false,
  unifiedMemory: false,
  hasDiscreteGpu: true,
});

test('显存充裕（24GB）：全部层上 GPU，KV 也在显存或按 2× 规则回内存', () => {
  const p = planDiscreteGpu({ model: MODEL, hw: winHw(24, 32) });
  assert.equal(p.ngl, 'all');
  assert.equal(p.nCpuMoe, 0);
  assert.ok(p.ctx >= 65536, `上下文应足够大，实际 ${p.ctx}`);
  assert.ok(['full-gpu', 'full-gpu-kv-host'].includes(p.strategy));
  assert.ok(p.notes.some((n) => n.includes('全部 65 层放入显存')));
});

test('显存放不下全部权重（12GB）：部分卸载，层数最大化且 KV 回内存', () => {
  const p = planDiscreteGpu({ model: MODEL, hw: winHw(12, 32) });
  assert.equal(p.strategy, 'partial');
  assert.ok(Number.isInteger(p.ngl) && p.ngl > 0 && p.ngl < MODEL.nLayer, `ngl=${p.ngl}`);
  assert.equal(p.kvOffload, false, '部分卸载时应把 KV 放内存以腾显存');
  assert.ok(p.notes.some((n) => n.includes('CPU 上运算')));
});

test('8GB 显存 + 64GB 内存：少放层但能吃下 256K 上下文', () => {
  const p = planDiscreteGpu({ model: MODEL, hw: winHw(8, 64) });
  assert.equal(p.strategy, 'partial');
  assert.ok(p.ngl > 0 && p.ngl < MODEL.nLayer);
  assert.equal(p.ctx, 262144);
  assert.equal(p.cacheTypeK, 'q8_0');
});

test('MoE：专家权重留内存，注意力层全部上显存', () => {
  const p = planDiscreteGpu({ model: MOE_MODEL, hw: winHw(12, 64) });
  assert.equal(p.strategy, 'moe-experts-host');
  assert.equal(p.ngl, 'all');
  assert.equal(p.nCpuMoe, MOE_MODEL.nLayer);
  assert.ok(p.notes.some((n) => n.includes('专家权重留在内存')));
});

test('显存与内存都放不下：明确报告 does-not-fit 而不是给个假配置', () => {
  const p = planDiscreteGpu({ model: MODEL, hw: winHw(4, 16) });
  assert.equal(p.strategy, 'does-not-fit');
  assert.equal(p.ngl, 0);
  assert.ok(p.notes.some((n) => n.includes('都放不下')), p.notes.join('|'));
});

test('显存未知：不猜，交给引擎（ngl=auto）并明确警告', () => {
  const hw = winHw(0, 32);
  hw.gpu = { name: 'Unknown GPU', cores: null, vramGB: null };
  hw.hasDiscreteGpu = false;
  const p = planDiscreteGpu({ model: MODEL, hw });
  assert.equal(p.strategy, 'unknown');
  assert.equal(p.ngl, 'auto');
  assert.ok(p.notes.some((n) => n.includes('未能检测到显卡显存')));
});

test('recommend 在 PC 硬件上返回可用的 params，并带上 kvOffload', () => {
  const { params, notes } = recommend({ hw: winHw(8, 64), model: MODEL });
  assert.equal(params.kvOffload, false);
  assert.ok(params.ngl > 0 && params.ngl < MODEL.nLayer);
  assert.equal(params.threads, 16, '生成线程 = 物理核');
  assert.equal(params.threadsBatch, 32, '批处理线程 = 逻辑核');
  assert.ok(notes.length > 0);
  // 参数落地：KV 回内存必须生成 --no-kv-offload
  const args = buildArgs(params, MODEL.path, 'server');
  assert.ok(args.includes('--no-kv-offload'), args.join(' '));
  assert.ok(args.includes('-ngl'));
});

test('recommend 在显存充裕的 PC 上：ngl=all 且不产生 --no-kv-offload', () => {
  const { params } = recommend({ hw: winHw(48, 64), model: MODEL });
  assert.equal(params.ngl, 'all');
  assert.equal(params.kvOffload, true);
  const args = buildArgs(params, MODEL.path, 'server');
  assert.ok(!args.includes('--no-kv-offload'));
});

test('统一内存（Apple）路径不受影响：不产生 --no-kv-offload，仍是 ngl=all', () => {
  const macHw = {
    platform: 'darwin',
    chip: 'Apple M5 Max',
    pCores: 6,
    eCores: 12,
    totalCores: 18,
    ramGB: 64,
    isAppleSilicon: true,
    unifiedMemory: true,
    gpu: { name: 'Apple M5 Max', cores: 40, vramGB: null, vendor: 'apple' },
  };
  const { params } = recommend({ hw: macHw, model: MODEL });
  assert.equal(params.ngl, 'all');
  assert.equal(params.kvOffload, true);
  const args = buildArgs(params, MODEL.path, 'server');
  assert.ok(!args.includes('--no-kv-offload'));
});

/* ---------- 内存面板分解（显存/内存两笔账） ---------- */

const { memoryBreakdown } = require('../main/recommend');

test('memoryBreakdown：PC 上返回 discrete 模式，显存与内存各自判定', () => {
  const params = {
    ngl: 53,
    nCpuMoe: 0,
    kvOffload: false,
    ctx: 131072,
    cacheTypeK: 'q8_0',
    cacheTypeV: 'q8_0',
    parallel: 1,
    batch: 2048,
    mmproj: '',
    specDraft: '',
  };
  const m = memoryBreakdown({ model: MODEL, params, hw: winHw(12, 32) });
  assert.equal(m.mode, 'discrete');
  assert.ok(m.vram && m.ram);
  assert.equal(m.vram.kv, 0, 'kvOffload=false → KV 不计入显存');
  assert.ok(m.ram.kv > 0, 'KV 应计入内存');
  assert.ok(m.vram.weights < MODEL.sizeBytes, '部分卸载时显存只放部分权重');
  assert.equal(m.ok, true, '两边都装得下');
});

test('回归：旧算法会误报超内存，双预算算法判定为可行', () => {
  const params = {
    ngl: 53, nCpuMoe: 0, kvOffload: false,
    ctx: 131072, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', parallel: 1, batch: 2048,
    mmproj: '', specDraft: '',
  };
  const hw = winHw(12, 32);
  const m = memoryBreakdown({ model: MODEL, params, hw });
  // 旧口径：全部权重 + KV + 计算 都算在内存里 → 27.4GB > 可用 25.6GB（误报）
  const unifiedTotal = MODEL.sizeBytes / 1e9 + m.kv / 1e9 + 2;
  assert.ok(unifiedTotal > m.ram.total / 1e9, '确认旧口径确实会超');
  assert.equal(m.ok, true, '双预算口径：权重在显存、KV 在内存，各自都不超');
});

test('memoryBreakdown：kvOffload=true 时 KV 计入显存', () => {
  const params = {
    ngl: 40, nCpuMoe: 0, kvOffload: true,
    ctx: 16384, cacheTypeK: 'f16', cacheTypeV: 'f16', parallel: 1, batch: 2048,
    mmproj: '', specDraft: '',
  };
  const m = memoryBreakdown({ model: MODEL, params, hw: winHw(24, 64) });
  assert.equal(m.vram.kv, m.kv);
  assert.equal(m.ram.kv, 0);
});

test('memoryBreakdown：显存未知时退回统一口径（不误判）', () => {
  const hw = winHw(0, 32);
  hw.gpu = { name: 'unknown', vramGB: null };
  const params = {
    ngl: 'all', nCpuMoe: 0, kvOffload: true,
    ctx: 8192, cacheTypeK: 'f16', cacheTypeV: 'f16', parallel: 1, batch: 2048,
    mmproj: '', specDraft: '',
  };
  const m = memoryBreakdown({ model: MODEL, params, hw });
  assert.equal(m.mode, 'unified');
});

/* ---------- 不变量：规划器与内存面板必须结论一致 ---------- */

test('一致性：规划器给出的配置，在内存面板口径下也必须是 ok', () => {
  const cases = [
    [6, 16], [8, 16], [8, 32], [12, 32], [16, 32], [16, 64], [24, 32], [24, 64], [48, 64],
  ];
  for (const [vram, ram] of cases) {
    const hw = winHw(vram, ram);
    const { params } = recommend({ hw, model: MODEL, params: { mmproj: '', specDraft: '' } });
    if (params.ngl === 0) continue; // 装不下的场景（does-not-fit / cpu-only）不在此断言
    const m = memoryBreakdown({ model: MODEL, params, hw });
    assert.equal(
      m.ok,
      true,
      `显存${vram}GB/内存${ram}GB → ctx=${params.ctx} ngl=${params.ngl} kvOffload=${params.kvOffload}；` +
        `显存 ${(m.vram.used / 1e9).toFixed(2)}/${(m.vram.total / 1e9).toFixed(2)}，` +
        `内存 ${(m.ram.used / 1e9).toFixed(2)}/${(m.ram.total / 1e9).toFixed(2)}`
    );
  }
});

test('一致性：MoE 规划（专家留内存）在面板口径下也成立', () => {
  const hw = winHw(12, 64);
  const { params } = recommend({ hw, model: MOE_MODEL, params: { mmproj: '', specDraft: '' } });
  assert.equal(params.nCpuMoe, MOE_MODEL.nLayer);
  const m = memoryBreakdown({ model: MOE_MODEL, params, hw });
  assert.equal(m.ok, true, `显存 ${(m.vram.used / 1e9).toFixed(2)}/${(m.vram.total / 1e9).toFixed(2)}，内存 ${(m.ram.used / 1e9).toFixed(2)}/${(m.ram.total / 1e9).toFixed(2)}`);
  assert.ok(m.vram.weights < MOE_MODEL.sizeBytes * 0.5, '专家留内存后显存权重应显著变小');
});

test('memoryBreakdown：maxCtx 由双预算算出，且与规划器选的 ctx 自洽', () => {
  const params = {
    ngl: 53, nCpuMoe: 0, kvOffload: false,
    ctx: 131072, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', parallel: 1, batch: 2048,
    mmproj: '', specDraft: '',
  };
  const hw = winHw(12, 32);
  const m = memoryBreakdown({ model: MODEL, params, hw });
  // KV 在内存：24GB 预算 - 权重 2.24 - 计算 2.0 = 19.76GB → q8_0 每 token 101KB ≈ 195K
  assert.ok(m.maxCtx > 131072, `最大上下文应大于当前值，实际 ${m.maxCtx}`);
  assert.ok(m.maxCtx < 262144, `受内存限制不应到 256K，实际 ${m.maxCtx}`);
  assert.ok(Math.abs(m.maxCtx - 195000) < 8000, `应在 195K 附近，实际 ${m.maxCtx}`);

  // 取到 maxCtx 时两侧仍应装得下
  const perTok = 48 * 4 * 256 * (1.03 + 1.03);
  const kv = perTok * m.maxCtx;
  assert.ok(m.vram.weights + m.vram.compute <= m.vram.total);
  assert.ok(m.ram.weights + kv + m.ram.compute <= m.ram.total + 1, '边界内（留 1 字节容差）');
});

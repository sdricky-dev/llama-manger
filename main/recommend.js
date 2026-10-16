'use strict';
/**
 * 一键推荐引擎（纯函数，可单测）。
 *
 * 内存模型（Apple Silicon 统一内存）：
 *   总占用 = 权重 W + 附属文件(mmproj/草稿模型) + KV 缓存 + 计算缓冲
 *   KV(ctx) = nLayer * nKvHead * headDim * (kBytes + vBytes) * ctx * parallel
 *   可用内存 usable = ram - max(8GB, 20%·ram)（OS 与常驻应用保留）
 *
 * CUDA 机器（预留）：另需检查 GPU 常驻权重 ≤ 显存。
 */

const { supportFor, specTypeForArch } = require('../shared/spec');

const CTX_PRESETS = [4096, 8192, 16384, 32768, 65536, 98304, 131072, 196608, 262144];

// 自动降级只用 f16 → q8_0：q8_0 KV 质量损失极小，而 q4_0 损失可感，
// 因此 q4_0 只在「连最小上下文都装不下」时兜底，否则仅作为提示给出理论上限。
const KV_FALLBACK = ['f16', 'q8_0'];

/**
 * 该模型可选的上下文档位（不超过训练长度；训练长度非整档时补一档）。
 */
function ctxPresetsFor(model) {
  const cap = model && model.ctxTrain > 0 ? model.ctxTrain : 131072;
  const list = CTX_PRESETS.filter((c) => c <= cap);
  if (cap >= 4096 && !list.includes(cap)) list.push(cap);
  return list.length ? list : [4096];
}

/**
 * 附属文件（mmproj / 草稿模型）占用字节数。
 * params 省略时按「同目录全部附属文件」计算（保守）。
 */
function companionBytes(model, params) {
  const c = (model && model.companions) || { mmproj: [], draft: [] };
  let bytes = 0;
  if (params) {
    const mm = (c.mmproj || []).find((x) => x.path === params.mmproj);
    const dr = (c.draft || []).find((x) => x.path === params.specDraft);
    bytes += mm ? mm.sizeBytes : 0;
    bytes += dr ? dr.sizeBytes : 0;
  } else {
    for (const x of c.mmproj || []) bytes += x.sizeBytes;
    for (const x of c.draft || []) bytes += x.sizeBytes;
  }
  return bytes;
}

// KV 缓存每元素字节数（按 ggml 的块量化定义精确值：块字节数 / 块元素数）
const KV_ELEM_BYTES = {
  f32: 4.0,
  f16: 2.0,
  bf16: 2.0,
  q8_0: 34 / 32, // 1.0625（引擎实测每 token 每层 heads×dim 乘此值）
  q4_0: 18 / 32, // 0.5625
  q4_1: 20 / 32, // 0.625
  q5_0: 22 / 32, // 0.6875
  q5_1: 24 / 32, // 0.75
  iq4_nl: 18 / 32, // 0.5625
};

// MoE 模型中专家(expert)权重占文件大小的近似比例
const MOE_EXPERT_FRAC = 0.85;

function kvBytesPerToken(model, kType, vType) {
  const k = KV_ELEM_BYTES[kType] ?? 2.0;
  const v = KV_ELEM_BYTES[vType] ?? 2.0;
  // 优先用解析器算好的「每 token 元素数」：它已经考虑了
  // 混合 SSM（只有注意力层存 KV）、MTP 层、逐层 KV 头数、SWA 层头维差异
  if (model.kvUnitsK || model.kvUnitsV) {
    const ku = model.kvUnitsK || 0;
    const vu = model.kvUnitsV || model.kvUnitsK || 0;
    return ku * k + vu * v;
  }
  const layers = model.nAttnLayer || model.nLayer;
  return layers * model.nKvHead * model.headDim * (k + v);
}

function kvCacheBytes(model, params) {
  const perTok = kvBytesPerToken(model, params.cacheTypeK || 'f16', params.cacheTypeV || 'f16');
  return perTok * (params.ctx || 4096) * (params.parallel || 1);
}

/**
 * 内存分解（字节）。
 */
function memoryBreakdown({ model, params, hw }) {
  const W = model.sizeBytes;
  const L = model.nLayer || 1;

  // 附属文件：视觉投影(mmproj) 与草稿模型都额外常驻内存
  const companions = model.companions || { mmproj: [], draft: [] };
  const findByPath = (list, p) => (p ? (list || []).find((x) => x.path === p) : null);
  const mm = findByPath(companions.mmproj, params.mmproj);
  const dr = findByPath(companions.draft, params.specDraft);
  const wMmproj = mm ? mm.sizeBytes : 0;
  const wDraft = dr ? dr.sizeBytes : 0;
  const kv = kvCacheBytes(model, params);
  const compute = hostComputeGB(params.batch) * 1e9;
  const attach = wMmproj + wDraft;

  // ---------- 独立显卡（PC）：显存与内存分开算 ----------
  const vramTotal = Number(hw && hw.gpu && hw.gpu.vramGB) || 0;
  if (hw && !hw.unifiedMemory && vramTotal > 0) {
    const frac =
      params.ngl === 'all' || params.ngl === 'auto'
        ? 1
        : Math.max(0, Math.min(Number(params.ngl) || 0, L)) / L;
    let wVram = W * frac;
    // MoE：前 nCpuMoe 层的专家权重留在内存
    if (model.isMoe && params.nCpuMoe > 0) {
      const keep = Math.max(0, Math.min(Number(params.nCpuMoe) || 0, L)) / L;
      wVram -= W * MOE_EXPERT_FRAC * keep * frac;
    }
    wVram = Math.max(0, wVram);

    const kvOnGpu = params.kvOffload !== false;
    const gpuCompute = 1.0e9;
    const vramWeights = wVram + attachOnGpu(params, model);
    const vramKv = kvOnGpu ? kv : 0;
    const vramUsed = vramWeights + vramKv + gpuCompute;

    const ramWeights = W - wVram;
    const ramKv = kvOnGpu ? 0 : kv;
    const ramUsed = ramWeights + ramKv + attachOnRam(params, model) + compute;

    const vram = vramTotal * 1e9 * VRAM_HEADROOM;
    const ramBudget = usableRamGB(hw) * 1e9;
    const freeVram = vram - vramUsed;
    const freeRam = ramBudget - ramUsed;

    // 可容纳的最大上下文：显存与内存须同时满足（由主进程算好返回，渲染层不再重复 KV 数学）
    const perTok = kvBytesPerToken(model, params.cacheTypeK || 'f16', params.cacheTypeV || 'f16');
    const par = params.parallel || 1;
    let maxCtx = 0;
    if (perTok > 0) {
      let lo = 256;
      let hi = 1048576;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const kvMid = perTok * mid * par;
        const okMid =
          vramWeights + (kvOnGpu ? kvMid : 0) + gpuCompute <= vram &&
          ramWeights + (kvOnGpu ? 0 : kvMid) + attachOnRam(params, model) + compute <= ramBudget;
        if (okMid) {
          maxCtx = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
    }

    return {
      mode: 'discrete',
      kv,
      compute,
      maxCtx,
      wGpu: vramWeights,
      wCpu: ramWeights,
      wMmproj,
      wDraft,
      vram: {
        total: vram,
        weights: vramWeights,
        kv: vramKv,
        compute: gpuCompute,
        used: vramUsed,
        free: freeVram,
        ok: freeVram >= 0,
      },
      ram: {
        total: ramBudget,
        weights: ramWeights,
        kv: ramKv,
        compute,
        used: ramUsed,
        free: freeRam,
        ok: freeRam >= 0,
      },
      total: W + attach + kv + compute + gpuCompute,
      usable: ramBudget,
      free: Math.min(freeVram, freeRam),
      ok: freeVram >= 0 && freeRam >= 0,
      freeGB: Math.min(freeVram, freeRam) / 1e9,
    };
  }

  // ---------- 统一内存（Apple Silicon） ----------
  let wGpu;
  if (model.isMoe) {
    const ncm = Math.max(0, Math.min(Number(params.nCpuMoe) || 0, L));
    wGpu = W * (1 - MOE_EXPERT_FRAC * (ncm / L));
  } else {
    const frac =
      params.ngl === 'all' ? 1 : Math.max(0, Math.min(Number(params.ngl) || 0, L)) / L;
    wGpu = W * frac;
  }
  const wCpu = W - wGpu;
  const usable = usableRamGB(hw) * 1e9;
  const total = W + attach + kv + compute;
  const free = usable - total;
  return {
    mode: 'unified',
    wGpu,
    wCpu,
    kv,
    compute,
    wMmproj,
    wDraft,
    total,
    usable,
    free,
    ok: free >= 0,
    freeGB: free / 1e9,
  };
}

/** 附属文件在显存侧的大小（mmproj 默认上 GPU；草稿模型按其 ngl 设置） */
function attachOnGpu(params, model) {
  const c = model.companions || { mmproj: [], draft: [] };
  let gpu = 0;
  const mm = (c.mmproj || []).find((x) => x.path === params.mmproj);
  if (mm && params.mmprojOffload !== false) gpu += mm.sizeBytes;
  const dr = (c.draft || []).find((x) => x.path === params.specDraft);
  if (dr) {
    gpu +=
      params.specDraftNgl === 'all' || params.specDraftNgl === undefined || params.specDraftNgl === ''
        ? dr.sizeBytes
        : 0;
  }
  return gpu;
}

/** 附属文件在内存侧的大小 */
function attachOnRam(params, model) {
  const c = model.companions || { mmproj: [], draft: [] };
  let ram = 0;
  const mm = (c.mmproj || []).find((x) => x.path === params.mmproj);
  if (mm && params.mmprojOffload === false) ram += mm.sizeBytes;
  const dr = (c.draft || []).find((x) => x.path === params.specDraft);
  if (dr) {
    const onGpu =
      params.specDraftNgl === 'all' || params.specDraftNgl === undefined || params.specDraftNgl === '';
    if (!onGpu) ram += dr.sizeBytes;
  }
  return ram;
}

function usableRamGB(hw) {
  return hw.ramGB - Math.max(8, 0.2 * hw.ramGB);
}

/**
 * 判断给定 ctx 与 KV 类型是否装得下。
 * @param {number} [extraGB] 附属文件（mmproj/草稿）额外占用
 */
function fits({ model, ctx, kType, vType, parallel, usableGB, extraGB = 0 }) {
  const perTok = kvBytesPerToken(model, kType, vType);
  const totalGB =
    model.sizeBytes / 1e9 + extraGB + (perTok * ctx * parallel) / 1e9 + 2;
  return totalGB <= usableGB;
}

function fmtCtx(n) {
  if (!n) return '—';
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024}K`;
  return String(n);
}

/**
 * 指定 KV 精度与内存预算下能容纳的最大上下文（用于「f16 只能到 X」这类提示）。
 */
function maxCtxFor(model, kvType, usableGB, extraGB = 0) {
  const perTok = kvBytesPerToken(model, kvType, kvType);
  if (!perTok) return 0;
  const avail = usableGB - model.sizeBytes / 1e9 - extraGB - 2;
  if (avail <= 0) return 0;
  return Math.max(0, Math.floor((avail * 1e9) / perTok));
}

/**
 * 一键推荐：根据硬件与模型生成完整参数。
 * @returns {{params: object, notes: string[]}}
 */

// ---------- 独立显卡（PC）：显存 + 内存 两笔账 ----------
const VRAM_HEADROOM = 0.92; // 显存留 8% 给驱动/系统
const COMPUTE_GPU_GB = 1.0; // GPU 侧计算缓冲（batch 2048 量级）
const HOST_COMPUTE_BASE_GB = 1.5; // CPU 侧计算缓冲基准

/**
 * 主机侧计算缓冲（单一口径：规划器与内存面板必须一致，否则会出现
 * 「计划可行、面板报超出」的自相矛盾）。
 */
function hostComputeGB(batch = 2048) {
  return HOST_COMPUTE_BASE_GB + 0.5 * ((Number(batch) || 2048) / 2048);
}

/**
 * 在给定的「显存放多少权重、KV 放哪边」前提下，找能容纳的最大上下文。
 * @returns {{ctx:number, kt:string, kvGB:number}|null}
 */
function bestCtxInBudget({ model, weightsGpuGB, kvOnGpu, vramGB, ramGB, extraGB = 0 }) {
  const W = model.sizeBytes / 1e9;
  const desc = [...ctxPresetsFor(model)].reverse();
  for (const c of desc) {
    for (const kt of KV_FALLBACK) {
      const kvGB =
        kvCacheBytes(model, { ctx: c, parallel: 1, cacheTypeK: kt, cacheTypeV: kt }) / 1e9;
      const vramNeed = weightsGpuGB + (kvOnGpu ? kvGB : 0) + COMPUTE_GPU_GB;
      const ramNeed = W - weightsGpuGB + (kvOnGpu ? 0 : kvGB) + extraGB + hostComputeGB();
      if (vramNeed <= vramGB && ramNeed <= ramGB) return { ctx: c, kt, kvGB, kvOnGpu };
    }
  }
  return null;
}

/**
 * 独立显卡（PC）规划：显存放权重/KV/计算，内存放放不下的层。
 * 策略优先级：全量卸载(KV在显存) → 全量卸载(KV回内存) →
 *            MoE 专家留内存 → 部分卸载（层数最大化）。
 * @returns {{strategy, ngl, nCpuMoe, kvOffload, ctx, cacheTypeK, cacheTypeV, notes}}
 */
function planDiscreteGpu({ model, hw, extraGB = 0 }) {
  const notes = [];
  const L = model.nLayer || 1;
  const W = model.sizeBytes / 1e9;
  const ramBudget = usableRamGB(hw);
  const vramTotal = Number(hw && hw.gpu && hw.gpu.vramGB) || 0;
  const perLayerGB = W / L;

  // 显存未知：不做猜测，交给引擎（auto），上下文按内存预算给
  if (!vramTotal) {
    let ctx = 4096;
    let kt = 'f16';
    for (const c of [...ctxPresetsFor(model)].reverse()) {
      const hit = KV_FALLBACK.find(
        (t) =>
          (W + kvCacheBytes(model, { ctx: c, parallel: 1, cacheTypeK: t, cacheTypeV: t }) / 1e9 +
            extraGB +
            hostComputeGB()) <= ramBudget
      );
      if (hit) {
        ctx = c;
        kt = hit;
        break;
      }
    }
    notes.push(
      '⚠ 未能检测到显卡显存：GPU 层数交给引擎自动决定（ngl=auto），上下文按内存预算估算。若加载失败，请手动下调 ngl。'
    );
    return {
      strategy: 'unknown',
      ngl: 'auto',
      nCpuMoe: 0,
      kvOffload: true,
      ctx,
      cacheTypeK: kt,
      cacheTypeV: kt,
      notes,
    };
  }

  const vram = vramTotal * VRAM_HEADROOM;

  // 同一份权重下比较 KV 放显存 / 放内存：上下文能明显变长（≥2×）才接受 KV 回内存的性能代价
  const tryOrder = (weightsGpuGB) => {
    const onGpu = bestCtxInBudget({
      model, weightsGpuGB, kvOnGpu: true, vramGB: vram, ramGB: ramBudget, extraGB,
    });
    const onHost = bestCtxInBudget({
      model, weightsGpuGB, kvOnGpu: false, vramGB: vram, ramGB: ramBudget, extraGB,
    });
    if (onHost && (!onGpu || onHost.ctx >= onGpu.ctx * 2)) return onHost;
    return onGpu || onHost;
  };

  // 1) 全部层上 GPU
  if (W + COMPUTE_GPU_GB <= vram) {
    const hit = tryOrder(W);
    if (hit) {
      notes.push(
        `全部 ${L} 层放入显存（${vramTotal.toFixed(0)} GB）` +
          (hit.kvOnGpu ? '，KV 缓存也在显存' : '，KV 缓存放内存（--no-kv-offload）以换取更长上下文')
      );
      return {
        strategy: hit.kvOnGpu ? 'full-gpu' : 'full-gpu-kv-host',
        ngl: 'all',
        nCpuMoe: 0,
        kvOffload: hit.kvOnGpu,
        ctx: hit.ctx,
        cacheTypeK: hit.kt,
        cacheTypeV: hit.kt,
        notes,
      };
    }
  }

  // 2) MoE：专家权重留内存，注意力层全上 GPU（比部分卸载快得多）
  if (model.isMoe) {
    const weightsGpuGB = W * (1 - MOE_EXPERT_FRAC);
    if (weightsGpuGB + COMPUTE_GPU_GB <= vram) {
      const hit = tryOrder(weightsGpuGB);
      if (hit) {
        notes.push(
          `MoE 模型：全部 ${L} 层的专家权重留在内存（-ncmoe ${L}），注意力与共享层放显存，约省 ${(W * MOE_EXPERT_FRAC).toFixed(1)} GB 显存`
        );
        return {
          strategy: 'moe-experts-host',
          ngl: 'all',
          nCpuMoe: L,
          kvOffload: hit.kvOnGpu,
          ctx: hit.ctx,
          cacheTypeK: hit.kt,
          cacheTypeV: hit.kt,
          notes,
        };
      }
    }
  }

  // 3) 部分卸载：显存能放多少层就放多少层（KV 优先放内存腾显存）
  const nglMax = Math.max(0, Math.min(L, Math.floor((vram - COMPUTE_GPU_GB) / perLayerGB)));
  const weightsGpuGB = perLayerGB * nglMax;
  let hit = null;
  for (const kvOnGpu of [false, true]) {
    hit = bestCtxInBudget({
      model,
      weightsGpuGB,
      kvOnGpu,
      vramGB: vram,
      ramGB: ramBudget,
      extraGB,
    });
    if (hit) break;
  }
  if (hit) {
    notes.push(
      `显存 ${vramTotal.toFixed(0)} GB 放不下全部权重：${nglMax}/${L} 层放显存，其余 ${L - nglMax} 层在 CPU 上运算（速度会明显下降）`
    );
    if (!hit.kvOnGpu) notes.push('KV 缓存放在内存（--no-kv-offload）以腾出显存给更多层');
    return {
      strategy: 'partial',
      ngl: nglMax,
      nCpuMoe: 0,
      kvOffload: hit.kvOnGpu,
      ctx: hit.ctx,
      cacheTypeK: hit.kt,
      cacheTypeV: hit.kt,
      notes,
    };
  }

  // 4) 显存连一层都放不下 → 纯 CPU 运行（若内存也放不下则明确告警）
  let ctx = 4096;
  let kt = 'f16';
  let fitsSomewhere = false;
  for (const c of [...ctxPresetsFor(model)].reverse()) {
    const found = KV_FALLBACK.find(
      (t) =>
        (W +
          kvCacheBytes(model, { ctx: c, parallel: 1, cacheTypeK: t, cacheTypeV: t }) / 1e9 +
          extraGB +
          hostComputeGB()) <= ramBudget
    );
    if (found) {
      ctx = c;
      kt = found;
      fitsSomewhere = true;
      break;
    }
  }
  if (!fitsSomewhere) {
    notes.push(
      `✗ 显存（${vramTotal.toFixed(0)} GB）与可用内存（${ramBudget.toFixed(1)} GB）都放不下这个模型（${W.toFixed(1)} GB）：请换更小的量化版本，或改用 MoE 模型。`
    );
  } else {
    notes.push(
      `⚠ 显存不足以放下任何一层：将全部在 CPU 上运行（ngl=0），生成速度会很慢。建议换更小的量化版本，或降低上下文。`
    );
  }
  return {
    strategy: fitsSomewhere ? 'cpu-only' : 'does-not-fit',
    ngl: 0,
    nCpuMoe: 0,
    kvOffload: false,
    ctx,
    cacheTypeK: kt,
    cacheTypeV: kt,
    notes,
  };
}

function recommend({ hw, model, params: curParams }) {
  const notes = [];
  const usable = usableRamGB(hw);
  const L = model.nLayer || 1;
  const extraGB = companionBytes(model, curParams) / 1e9;
  const unified = !!hw.isAppleSilicon;
  const plan = unified ? null : planDiscreteGpu({ model, hw, extraGB });

  // 1) MoE 专家层卸载：统一内存下文件较大时把专家留在内存池
  let nCpuMoe = plan ? plan.nCpuMoe : model.isMoe && model.sizeGB > 0.6 * usable ? L : 0;
  if (unified && model.isMoe && nCpuMoe > 0) {
    notes.push(`MoE 模型（${model.expertCount} 专家）：前 ${L} 层专家权重保留在内存池，降低 GPU 常驻占用`);
  }
  if (plan) notes.push(...plan.notes);

  // 2) 上下文：优先「拉满到模型训练长度」，装不下再逐级降 KV 精度（f16 → q8_0）
  //    独立显卡（PC）直接用规划器给出的结论；统一内存（Apple）走单一内存池的算法。
  const presets = ctxPresetsFor(model);
  const ctxTrain = model.ctxTrain > 0 ? model.ctxTrain : 0;
  let cacheTypeK;
  let cacheTypeV;
  let ctx;
  if (plan) {
    ctx = plan.ctx;
    cacheTypeK = plan.cacheTypeK;
    cacheTypeV = plan.cacheTypeV;
  } else {
    cacheTypeK = 'f16';
    cacheTypeV = 'f16';
    ctx = 0;
  }
  let kvDropped = null;
  for (let i = presets.length - 1; i >= 0 && !ctx; i--) {
    const c = presets[i];
    for (const kt of KV_FALLBACK) {
      if (fits({ model, ctx: c, kType: kt, vType: kt, parallel: 1, usableGB: usable, extraGB })) {
        ctx = c;
        cacheTypeK = kt;
        cacheTypeV = kt;
        if (kt !== 'f16') kvDropped = kt;
        break;
      }
    }
  }
  if (!plan && !ctx) {
    // 连最小档都装不下：给最小上下文并明确警告
    ctx = 4096;
    cacheTypeK = 'q4_0';
    cacheTypeV = 'q4_0';
    notes.push('⚠ 模型文件接近可用内存上限（已用最小上下文 + q4_0 KV），建议更换更低的量化版本');
  } else if (!plan && kvDropped) {
    notes.push(
      `为容纳 ${fmtCtx(ctx)} 上下文，KV 缓存使用 ${kvDropped}（f16 只能到 ${fmtCtx(maxCtxFor(model, 'f16', usable, extraGB))}）；${kvDropped === 'q8_0' ? '约省一半内存，质量损失极小' : '更省内存，质量损失略增'}`
    );
  } else if (plan && cacheTypeK !== 'f16') {
    notes.push(`为在显存/内存预算内取到更长的上下文，KV 缓存使用 ${cacheTypeK}（质量损失极小）`);
  }
  if (ctxTrain > 0) {
    if (ctx === ctxTrain) {
      notes.push(`上下文已用满模型训练长度 ${fmtCtx(ctxTrain)}（未超出，无需 YaRN 外推）`);
    } else if (ctx < ctxTrain) {
      const q4Max = maxCtxFor(model, 'q4_0', usable, extraGB);
      const q4Hint =
        q4Max > ctx
          ? `；若愿意接受 q4_0 KV（质量损失可感），理论上可到 ${fmtCtx(Math.min(q4Max, ctxTrain))}`
          : '';
      notes.push(
        plan
          ? `模型训练长度 ${fmtCtx(ctxTrain)}，但按当前显存/内存预算最多容纳 ${fmtCtx(ctx)}；想更长需要降 KV 精度或换更小的量化${q4Hint}`
          : `模型训练长度 ${fmtCtx(ctxTrain)}，但把附属文件算进去后内存最多容纳 ${fmtCtx(ctx)}${q4Hint}`
      );
    }
  }

  // 3) 上下文超过训练长度 → 提示 YaRN（自动推荐不会超，用户手动调大时才触发）
  let ropeScaling = 'none';
  let yarnOrigCtx = 0;
  let ropeSuggested = false;
  if (ctxTrain > 0 && ctx > ctxTrain) {
    ropeSuggested = true;
    yarnOrigCtx = ctxTrain;
    notes.push(
      `上下文 ${ctx} 超过模型训练长度 ${ctxTrain}，建议开启 YaRN 外推（高级选项中已预填 ${yarnOrigCtx}）`
    );
  }

  // 4) GPU 卸载：统一内存（Apple Silicon）→ 全量 Metal 卸载；独立显卡 → 用规划器结论
  let ngl = 'all';
  if (plan) {
    ngl = plan.ngl;
  } else if (!hw.isAppleSilicon && hw.gpu && hw.vramGB) {
    // 统一内存之外的兜底（理论上不会走到，plan 已覆盖）
    const perLayer = model.sizeBytes / L;
    const gpuBudget = hw.vramGB * 1e9 * 0.85;
    ngl = Math.max(0, Math.min(L, Math.floor(gpuBudget / perLayer)));
  }

  // 5) 投机解码：按模型能力（内置 MTP / 草稿架构）挑默认值，不支持时保持 none
  const spec = supportFor(model, curParams);
  const specType = spec.recommended;
  if (spec.draft) {
    notes.push(
      `检测到草稿模型（${specTypeForArch(spec.draft.arch)}，${spec.draft.sizeGB.toFixed(2)} GB）：已配对并开启投机解码，可加速生成；不需要时把「草稿模型」清空即可`
    );
  } else if (specType === 'draft-mtp') {
    notes.push('模型自带 MTP 预测层：已开启内置投机解码（--spec-type draft-mtp），无需草稿文件');
  }
  const unsupported = spec.options.filter((o) => !o.available).map((o) => o.value);

  const params = {
    // 引擎与内存
    ngl,
    cpuMoe: false,
    nCpuMoe,
    kvOffload: plan ? plan.kvOffload : true, // false → --no-kv-offload（KV 放内存）
    flashAttn: 'on',
    ctx,
    cacheTypeK,
    cacheTypeV,
    parallel: 1,
    swaFull: false,
    // 附属文件：视觉投影 / 投机解码
    mmproj: curParams ? curParams.mmproj || '' : (model.companions?.mmproj?.[0]?.path || ''),
    mmprojOffload: true,
    specDraft: curParams ? curParams.specDraft || '' : (model.companions?.draft?.[0]?.path || ''),
    specDraftNgl: 'all',
    specType,
    // 性能
    threads: hw.pCores > 0 ? hw.pCores : 1,
    threadsBatch: hw.totalCores > 0 ? hw.totalCores : hw.pCores || 4,
    batch: 2048,
    ubatch: 512,
    // 采样
    temp: 0.7,
    topK: 40,
    topP: 0.95,
    minP: 0.05,
    repeatPenalty: 1.1,
    seed: -1,
    // 高级（mlock/mmap/dio 已合并为 loadMode，上游只认 -lm/--load-mode）
    ropeScaling,
    yarnOrigCtx,
    loadMode: 'auto',
    splitMode: 'layer',
    tensorSplit: '',
    mainGpu: 0,
    lora: '',
    samplers: 'default',
    mirostat: 0,
    mirostatLr: 0.1,
    ignoreEos: false,
    // server
    host: '127.0.0.1',
    port: 9931,
    apiKey: '',
    metrics: false,
  };

  return { params, notes, ropeSuggested };
}

module.exports = {
  CTX_PRESETS,
  KV_ELEM_BYTES,
  MOE_EXPERT_FRAC,
  KV_FALLBACK,
  kvBytesPerToken,
  kvCacheBytes,
  memoryBreakdown,
  usableRamGB,
  fits,
  recommend,
  planDiscreteGpu,
  bestCtxInBudget,
  ctxPresetsFor,
  companionBytes,
  maxCtxFor,
  fmtCtx,
};

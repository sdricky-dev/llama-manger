'use strict';
/**
 * GGUF v3 最小解析器：读取文件头与 KV 元数据（不解析 tensor 表）。
 * 用于获取模型架构信息（层数、KV 头数、嵌入维度、训练上下文、量化类型、MoE 等）。
 *
 * 格式（little-endian，以 llama.cpp ggml/include/gguf.h 为准）：
 *   magic 'GGUF' | u32 version | i64 tensor_count | i64 kv_count
 *   随后 kv_count 个 { key: string, i32 type, value }
 *   string = u64 长度 + 字节序列
 *   type: 0 u8,1 i8,2 u16,3 i16,4 u32,5 i32,6 f32,7 bool,8 string,
 *         9 array(i32 elem_type,u64 count,values), 10 u64, 11 i64, 12 f64
 */
const fs = require('fs');

const FILE_TYPES = {
  0: 'f32', 1: 'f16', 2: 'Q4_0', 3: 'Q8_0', 4: 'Q5_1', 5: 'Q5_0',
  6: 'Q2_K', 7: 'Q3_K_S', 8: 'Q3_K_M', 9: 'Q3_K_L',
  10: 'Q4_0', 11: 'Q4_1', 12: 'Q5_0', 13: 'Q5_1',
  14: 'Q2_K', 15: 'Q3_K_S', 16: 'Q3_K_M', 17: 'Q3_K_L',
  18: 'Q4_0', 19: 'Q4_1', 20: 'Q5_0', 21: 'Q5_1',
  22: 'Q4_K_S', 23: 'Q4_K_M', 24: 'Q5_K_S', 25: 'Q5_K_M', 26: 'Q6_K',
  27: 'IQ2_XXS', 28: 'IQ2_XS', 29: 'IQ3_XXS', 30: 'IQ1_S', 31: 'IQ4_NL',
  32: 'IQ3_S', 33: 'IQ2_S', 34: 'IQ4_XS', 35: 'IQ1_M',
};

// ggml_type（ggml/include/ggml.h，已移除的 4/5/31/32/33/36/37/38 占位跳过）
const GGML_TYPES = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 6: 'Q5_0', 7: 'Q5_1', 8: 'Q8_0', 9: 'Q8_1',
  10: 'Q2_K', 11: 'Q3_K', 12: 'Q4_K', 13: 'Q5_K', 14: 'Q6_K', 15: 'Q8_K',
  16: 'IQ2_XXS', 17: 'IQ2_XS', 18: 'IQ3_XXS', 19: 'IQ1_S', 20: 'IQ4_NL',
  21: 'IQ3_S', 22: 'IQ2_S', 23: 'IQ4_XS', 24: 'I8', 25: 'I16', 26: 'I32', 27: 'I64',
  28: 'F64', 29: 'IQ1_M', 30: 'BF16', 34: 'TQ1_0', 35: 'TQ2_0', 39: 'MXFP4',
  40: 'NVFP4', 41: 'Q1_0', 42: 'Q2_0',
};

// 量化档位排序（用于 K 系混合量化取主档，如 Q4_K_S + Q6_K → Q4_K_M 风格展示）
const FTYPE_ORDER = [
  'Q2_K', 'IQ2_XXS', 'IQ2_XS', 'IQ2_S', 'Q3_K_S', 'IQ3_XXS', 'Q3_K_M', 'IQ3_S', 'Q3_K_L',
  'IQ4_XS', 'Q4_K_S', 'Q4_K_M', 'Q4_1', 'Q5_K_S', 'Q5_K_M', 'Q5_1', 'Q6_K', 'Q8_0',
];

// 草稿/投机解码模型的架构（不能当作独立对话模型加载）
const DRAFT_ARCHES = new Set(['dflash', 'eagle3', 'eagle', 'dspark', 'medusa']);

// llama-server 支持的 decision（判决/打分）模型类型，见 common/common.cpp:
// COMMON_DECISION_TYPE_NAMES。元数据 <arch>.decision.type 不在表内 → 服务启动即失败。
const DECISION_TYPES = [
  'openjev', 'lev', 'kev', 'nimble', 'laya', 'clef', 'pplx-decider',
  'vllm-decision2', 'vllm-d3', 'lfm2-d1', 'lfm2-d1-omni', 'granite-switch',
];

// 别名：需引擎侧打补丁（scripts/patches/decision-type-jev-alias.patch）才被接受。
// 未打补丁的引擎遇到别名值同样会加载失败，因此界面上单独标注。
const DECISION_ALIASES = {
  jev: 'openjev',
};

class GgufBuffer {
  constructor(fd) {
    this.fd = fd;
    this.buf = Buffer.alloc(0);
    this.offset = 0;
    this.filePos = 0; // 已从文件读出的总字节数
    this.fileSize = fs.fstatSync(fd).size;
  }
  ensure(n) {
    while (this.buf.length - this.offset < n) {
      const remaining = this.fileSize - this.filePos;
      if (remaining <= 0) throw new Error('GGUF 文件截断（元数据不完整）');
      const chunk = Buffer.alloc(Math.min(8 * 1024 * 1024, remaining));
      const got = fs.readSync(this.fd, chunk, 0, chunk.length, this.filePos);
      if (got <= 0) throw new Error('GGUF 文件截断（读取失败）');
      this.filePos += got;
      // 保留未消费尾部 + 追加新数据，offset 归零
      this.buf = Buffer.concat([this.buf.subarray(this.offset), chunk.subarray(0, got)]);
      this.offset = 0;
    }
  }
  read(n) {
    this.ensure(n);
    const v = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return v;
  }
  u8() { return this.read(1)[0]; }
  i8() { return this.read(1).readInt8(0); }
  u16() { return this.read(2).readUInt16LE(0); }
  i16() { return this.read(2).readInt16LE(0); }
  u32() { return this.read(4).readUInt32LE(0); }
  i32() { return this.read(4).readInt32LE(0); }
  f32() { return this.read(4).readFloatLE(0); }
  u64() { return this.read(8).readBigUInt64LE(0); }
  i64() { return this.read(8).readBigInt64LE(0); }
  f64() { return this.read(8).readDoubleLE(0); }
  str() {
    const len = Number(this.u64());
    if (len > 1024 * 1024) throw new Error(`GGUF 字符串长度异常: ${len}`);
    const b = this.read(len);
    return b.toString('utf8');
  }
  value(type) {
    switch (type) {
      case 0: return this.u8();
      case 1: return this.i8();
      case 2: return this.u16();
      case 3: return this.i16();
      case 4: return this.u32();
      case 5: return this.i32();
      case 6: return this.f32();
      case 7: return this.u8() === 1;
      case 8: return this.str();
      case 9: {
        // array: elem_type i32 + count u64 + 元素序列
        const et = this.i32();
        const count = Number(this.u64());
        if (count < 0 || count > 2000000) throw new Error(`GGUF 数组长度异常: ${count}`);
        const out = [];
        for (let i = 0; i < count; i++) out.push(this.value(et));
        return out;
      }
      case 10: return Number(this.u64());
      case 11: return Number(this.i64());
      case 12: return this.f64();
      default:
        throw new Error(`未知 GGUF 值类型: ${type}`);
    }
  }
}

/**
 * 解析 GGUF 元数据。
 * @param {string} filePath
 * @param {{tensors?:boolean}} [opts] tensors=true 时继续读 tensor 表（名称/维度/类型）
 * @returns {{version:number, kv:Object, tensors:Array|null, fileSize:number}}
 */
function parseGguf(filePath, opts = {}) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const g = new GgufBuffer(fd);
    const magic = g.read(4).toString('ascii');
    if (magic !== 'GGUF') throw new Error(`不是 GGUF 文件（magic=${magic}）`);
    const version = g.u32();
    const tensorCount = Number(g.i64());
    const kvCount = Number(g.i64());
    const kv = {};
    for (let i = 0; i < kvCount; i++) {
      const key = g.str();
      const type = g.u32();
      const val = g.value(type);
      kv[key] = val;
    }
    let tensors = null;
    if (opts.tensors) {
      if (tensorCount < 0 || tensorCount > 200000) throw new Error(`GGUF tensor 数量异常: ${tensorCount}`);
      tensors = [];
      for (let i = 0; i < tensorCount; i++) {
        const name = g.str();
        const nDims = g.u32();
        if (nDims > 8) throw new Error(`GGUF tensor 维度数异常: ${nDims}`);
        const dims = [];
        let elems = 1;
        for (let d = 0; d < nDims; d++) {
          const n = Number(g.u64());
          dims.push(n);
          elems *= n;
        }
        const type = g.u32();
        g.u64(); // offset，跳过
        tensors.push({ name, dims, type, elems });
      }
    }
    return { version, tensorCount, kv, tensors, fileSize: g.fileSize };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 由 tensor 表推导真实量化（general.file_type 常与实际不符，tensor 类型才权威）。
 * 只统计 2 维及以上的权重张量，按元素总数取占比最高的类型；
 * 若存在 K 系混档（如 Q4_K + Q6_K），给出 -M/-S 风格档位提示。
 * @param {Array<{dims:number[], type:number, elems:number}>} tensors
 */
function deriveQuant(tensors) {
  if (!Array.isArray(tensors) || tensors.length === 0) return null;
  const byType = new Map();
  let total = 0;
  for (const t of tensors) {
    if (!t.dims || t.dims.length < 2) continue; // 跳过 norm/bias 等 1 维张量
    byType.set(t.type, (byType.get(t.type) || 0) + t.elems);
    total += t.elems;
  }
  if (total === 0) return null;
  const ranked = [...byType.entries()]
    .map(([type, elems]) => ({ type, elems, label: GGML_TYPES[type] || `type${type}`, share: elems / total }))
    .sort((a, b) => b.elems - a.elems);
  const main = ranked[0];
  const rest = ranked.slice(1, 4).filter((r) => r.share >= 0.02);
  const isK = (l) => /_K$/.test(l);
  // K 系基础类型（tensor 里只记为 Q4_K 等）默认对应 _S 档，混入高档才升为 _M
  const K_BASE_S = { Q2_K: 'Q2_K', Q3_K: 'Q3_K_S', Q4_K: 'Q4_K_S', Q5_K: 'Q5_K_S', Q6_K: 'Q6_K', Q8_K: 'Q8_K' };
  let label = main.label;
  let suffix = null; // 'S' | 'M'
  if (isK(main.label) && rest.length) {
    const hi = rest.find((r) => isK(r.label) && FTYPE_ORDER.indexOf(r.label) > FTYPE_ORDER.indexOf(main.label));
    if (hi) suffix = hi.share >= 0.08 ? 'M' : 'S';
  }
  if (main.label === 'F16') label = 'f16';
  else if (main.label === 'BF16') label = 'bf16';
  else if (main.label === 'F32') label = 'f32';
  else if (suffix === 'M') { const b = K_BASE_S[main.label]; label = b ? b.replace(/_S$/, '_M') : main.label; }
  else if (K_BASE_S[main.label]) label = K_BASE_S[main.label];
  return {
    quant: label,
    source: 'tensors',
    share: main.share,
    breakdown: ranked.slice(0, 4).map((r) => ({ label: r.label, share: r.share })),
  };
}

/**
 * 判定 GGUF 文件角色：主模型 / 视觉投影(mmproj) / 草稿模型(spec draft)。
 * 依据 general.type（权威）、架构名，文件名仅作兜底。
 */
function classifyRole(arch, kv, filePath) {
  const gtype = String(kv['general.type'] || '').toLowerCase();
  const base = String(filePath || '').split('/').pop() || '';
  const projType = kv['clip.projector_type'] || kv['clip.has_vision_encoder'];
  if (gtype === 'mmproj' || arch === 'clip' || /(^|[-_.])mmproj([-_.]|$)/i.test(base) || (arch === 'unknown' && projType !== undefined)) {
    return 'mmproj';
  }
  if (gtype === 'draft' || DRAFT_ARCHES.has(arch)) return 'draft';
  if (/\bdraft\b/i.test(base)) return 'draft';
  return 'model';
}


/**
 * 从 GGUF 元数据提取启动器所需架构信息。
 * @param {{kv:Object, fileSize:number}} meta parseGguf 的返回值
 * @param {string} filePath 模型路径
 * @param {string} [nameOverride]
 */
function extractModelInfo(meta, filePath, nameOverride) {
  const { kv, fileSize, tensors } = meta;
  const arch = kv['general.architecture'] || 'unknown';
  const A = (k) => kv[`${arch}.${k}`];

  const nLayer = Number(A('block_count')) || 0;
  const ctxTrain = Number(A('context_length')) || 0;
  const nEmb = Number(A('embedding_length')) || 0;
  const nHead = Number(A('attention.head_count')) || 0;
  const kvHeadRaw = A('attention.head_count_kv');
  // gemma4 等 sliding-window 混合模型逐层给 KV 头数（数组），普通模型是标量
  const kvHeadPerLayer = Array.isArray(kvHeadRaw) ? kvHeadRaw.map(Number) : null;
  const nKvHead = kvHeadPerLayer ? Math.max(...kvHeadPerLayer, 0) : Number(kvHeadRaw) || nHead;
  // 头维：优先 attention.key_length（混合 SSM 架构中 nEmb/nHead 会失真）
  const headDim =
    Number(A('attention.key_length')) ||
    (nEmb && nHead ? Math.round(nEmb / nHead) : 0);

  // ---------- KV 缓存到底有几层、每层多大 ----------
  // 1) MTP / nextn 层由引擎单独建上下文，不占主模型的 KV
  const nextn = Number(A('nextn_predict_layers')) || 0;
  const kvLayers = Math.max(nLayer - nextn, 0) || nLayer;
  // 2) 混合 SSM/线性注意力：只有「非 recurrent」层存 KV
  //    recurrent_layers[i] = true 表示该层是 SSM 层（不存 KV），
  //    所以注意力层是标记为 false 的那些；不能数 true（那得到的是 SSM 层数）。
  const recurrent = A('attention.recurrent_layers');
  // 3) 没有 recurrent_layers 时看 full_attention_interval（Qwen3-Next/3.5 系列：
  //    每 N 层一个全注意力层），引擎同样按这个算 KV 层数
  const interval = Number(A('full_attention_interval')) || 0;
  let attnFlags;
  if (Array.isArray(recurrent)) {
    attnFlags = recurrent.slice(0, kvLayers).map((x) => !x);
  } else if (interval > 0) {
    attnFlags = Array.from({ length: kvLayers }, (_, i) => (i + 1) % interval === 0);
  } else {
    attnFlags = Array.from({ length: kvLayers }, () => true);
  }
  const nAttnLayer = attnFlags.filter(Boolean).length || nLayer;
  // 4) 每层的 K/V 元素数（heads × head_dim）；SWA 层的头维可能更小
  const swaPattern = A('attention.sliding_window_pattern');
  const keyLen = Number(A('attention.key_length')) || headDim;
  const valLen = Number(A('attention.value_length')) || keyLen;
  const keyLenSwa = Number(A('attention.key_length_swa')) || keyLen;
  const valLenSwa = Number(A('attention.value_length_swa')) || valLen;
  let kvUnitsK = 0;
  let kvUnitsV = 0;
  const attnLayerIdx = [];
  for (let i = 0; i < attnFlags.length; i++) {
    if (!attnFlags[i]) continue;
    attnLayerIdx.push(i);
    const heads = kvHeadPerLayer ? Number(kvHeadPerLayer[i]) || 0 : nKvHead;
    const swa = Array.isArray(swaPattern) ? !!swaPattern[i] : false;
    kvUnitsK += heads * (swa ? keyLenSwa : keyLen);
    kvUnitsV += heads * (swa ? valLenSwa : valLen);
  }
  if (!kvUnitsK) {
    kvUnitsK = nAttnLayer * nKvHead * headDim;
    kvUnitsV = kvUnitsK;
  }

  const expertCount = Number(A('expert_count')) || 0;
  const expertShared = Number(A('expert_shared_count')) || 0;
  const ftype = Number(A('file_type') ?? kv['general.file_type']) || null;
  const role = classifyRole(arch, kv, filePath);

  // 量化：优先 tensor 实测（发布者的 general.file_type 常与实际张量不符）
  const derived = deriveQuant(tensors);
  const fileTypeLabel = ftype === null ? null : FILE_TYPES[ftype] || `type${ftype}`;
  const quant = derived ? derived.quant : fileTypeLabel || 'unknown';

  return {
    path: filePath,
    name: nameOverride || kv['general.name'] || filePath.split('/').pop(),
    role, // 'model' | 'mmproj' | 'draft'
    generalType: kv['general.type'] || null,
    arch,
    nLayer,
    ctxTrain,
    nEmb,
    nHead,
    nKvHead,
    headDim,
    nAttnLayer,
    nextnLayers: nextn, // MTP/nextn 层数（不占主模型 KV）
    kvUnitsK, // 每 token 的 K 元素数（= Σ 层 heads×head_dim，含 SWA 差异）
    kvUnitsV, // 每 token 的 V 元素数
    kvGeometry: {
      layers: attnFlags.length,
      attnLayers: attnLayerIdx.length,
      interval: interval || null,
      perLayerHeads: !!kvHeadPerLayer,
      swa: Array.isArray(swaPattern) ? attnLayerIdx.filter((i) => swaPattern[i]).length : 0,
    },
    isMoe: expertCount > 0,
    expertCount,
    expertShared,
    hasMtp: Number(A('nextn_predict_layers')) > 0,
    // decision（判决/打分）模型标记：值不在 DECISION_TYPES 内时 llama-server 会启动失败
    decisionType: kv[`${arch}.decision.type`] || null,
    decisionSupported: kv[`${arch}.decision.type`]
      ? DECISION_TYPES.includes(String(kv[`${arch}.decision.type`])) ||
        Object.prototype.hasOwnProperty.call(DECISION_ALIASES, String(kv[`${arch}.decision.type`]))
      : null,
    // 命中的是别名而非规范名（需要已打补丁的引擎）
    decisionAlias: DECISION_ALIASES[String(kv[`${arch}.decision.type`])] || null,
    // decision 模型必须带 systemone 聊天模板，否则即便类型受支持也会加载失败
    decisionTemplate: !!kv['tokenizer.chat_template.systemone'],
    quant,
    quantSource: derived ? derived.source : fileTypeLabel ? 'kv' : null,
    quantBreakdown: derived ? derived.breakdown : null,
    fileTypeLabel, // 仅供参考，可能与 quant 不一致
    nTensor: meta.tensorCount || 0,
    // 视觉投影文件（mmproj）附加信息
    vision: role === 'mmproj'
      ? {
          hasVision: !!kv['clip.has_vision_encoder'],
          projectorType: kv['clip.projector_type'] || null,
          imageSize: Number(kv['clip.vision.image_size']) || 0,
          projectionDim: Number(kv['clip.vision.projection_dim']) || 0,
          visionLayers: Number(kv['clip.vision.block_count']) || 0,
        }
      : null,
    sizeBytes: fileSize,
    sizeGB: fileSize / 1e9,
  };
}

function parseModelFile(filePath, nameOverride) {
  const meta = parseGguf(filePath, { tensors: true });
  return extractModelInfo(meta, filePath, nameOverride);
}

module.exports = {
  parseGguf,
  extractModelInfo,
  parseModelFile,
  deriveQuant,
  classifyRole,
  FILE_TYPES,
  GGML_TYPES,
  DECISION_TYPES,
  DECISION_ALIASES,
};

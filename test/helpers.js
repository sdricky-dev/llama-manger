'use strict';
/**
 * 测试工具：构造最小合法的 GGUF v3 文件（无张量数据），用于 gguf.js 解析测试。
 */
const fs = require('fs');
const path = require('path');

// GGUF v3: string = u64 长度 + 字节序列（见 ggml/include/gguf.h）
function encStr(s) {
  const b = Buffer.from(s, 'utf8');
  const out = Buffer.alloc(8 + b.length);
  out.writeBigUInt64LE(BigInt(b.length), 0);
  b.copy(out, 8);
  return out;
}

function encU8(n) { return Buffer.from([n & 0xff]); }
function encU64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
function encI64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n) & 0xffffffffffffffffn);
  return b;
}
function encF64(n) {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(n);
  return b;
}

/**
 * @param {object} opts { arch, nLayer, ctxTrain, nEmb, nHead, nKvHead, headDim,
 *                        fileType, expertCount?, expertShared?, extraKv?,
 *                        tensors?: [{name, dims:number[], type:number}] }
 */
function buildGguf(opts, destPath) {
  const {
    arch = 'llama',
    nLayer = 32,
    ctxTrain = 32768,
    nEmb = 2048,
    nHead = 16,
    nKvHead = 16,
    headDim = 128,
    fileType = 23, // Q4_K_M
    expertCount,
    expertShared,
    extraKv = {},
    tensors = [],
  } = opts;

  const kv = [];
  const push = (key, type, value) => kv.push([key, type, value]);

  // 当前 GGUF 枚举：8=string, 10=u64, 11=i64, 12=f64, 9=array
  push('general.architecture', 8, arch);
  push(`${arch}.block_count`, 10, nLayer);
  push(`${arch}.context_length`, 10, ctxTrain);
  push(`${arch}.embedding_length`, 10, nEmb);
  push(`${arch}.attention.head_count`, 10, nHead);
  push(`${arch}.attention.head_count_kv`, 10, nKvHead);
  push(`${arch}.file_type`, 10, fileType);
  if (expertCount !== undefined) push(`${arch}.expert_count`, 10, expertCount);
  if (expertShared !== undefined) push(`${arch}.expert_shared_count`, 10, expertShared);
  for (const [k, v] of Object.entries(extraKv)) push(k, v.type ?? 8, v.value ?? k);

  // 序列化 KV
  const kvBufs = [];
  for (const [key, type, value] of kv) {
    kvBufs.push(encStr(key));
    // GGUF v3: value_type 是 u32
    const tb = Buffer.alloc(4);
    tb.writeUInt32LE(type, 0);
    kvBufs.push(tb);
    if (type === 8) kvBufs.push(encStr(value));
    else if (type === 10) kvBufs.push(encU64(value));
    else if (type === 11) kvBufs.push(encI64(value));
    else if (type === 12) kvBufs.push(encF64(value));
    else if (type === 9) {
      // array of u64: [elem_type i32=10][count u64][values]
      const et = Buffer.alloc(4);
      et.writeUInt32LE(10, 0);
      kvBufs.push(et);
      kvBufs.push(encU64(1));
      kvBufs.push(encU64(value));
    } else {
      throw new Error(`unsupported type ${type}`);
    }
  }

  const v = Buffer.from([3, 0, 0, 0]); // version u32
  // tensor 表：name(str) | n_dims(u32) | dims(u64×n) | type(u32) | offset(u64)
  const tensorBufs = [];
  let offset = 0;
  for (const t of tensors) {
    tensorBufs.push(encStr(t.name));
    const nd = Buffer.alloc(4);
    nd.writeUInt32LE(t.dims.length, 0);
    tensorBufs.push(nd);
    const elems = t.dims.reduce((a, b) => a * b, 1);
    for (const d of t.dims) tensorBufs.push(encU64(d));
    const tb = Buffer.alloc(4);
    tb.writeUInt32LE(t.type, 0);
    tensorBufs.push(tb);
    tensorBufs.push(encU64(offset));
    offset += elems * 4;
  }

  const header = Buffer.concat([
    Buffer.from('GGUF', 'ascii'),
    v,
    encI64(tensors.length), // tensor_count i64
    encI64(kv.length), // kv_count i64
    ...kvBufs,
    ...tensorBufs,
  ]);

  // 追加填充数据，使文件具有一定体积（模拟真实模型大小）
  const pad = Buffer.alloc((opts.padBytes ?? 0) | 0);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, Buffer.concat([header, pad]));
  return destPath;
}

module.exports = { buildGguf, encStr, encU64, encI64, encF64 };

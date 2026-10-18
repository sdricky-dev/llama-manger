/**
 * KV 缓存口径（渲染层用，纯函数、不依赖 node）。
 *
 * 与 main/recommend.js 的 kvCells / kvCacheBytes 是同一套公式（引擎实测口径）：
 *   - 非 SWA 层：ctx 个 cell（`-c` 即 KV 池总量，并行只切分不放大）
 *   - SWA 层（swaFull=false）：窗口缓存 pad256(min(每槽 ctx, 窗口 × (unified 时槽数，否则 1) + ubatch))
 *     （llama-kv-cache-iswa.cpp；槽数：应用未下发 -np 时引擎 auto = 4 槽 + kv_unified）
 * 修改任一处务必同步另一处 —— test/kv-geometry.test.js 有两侧一致性测试。
 */

// KV 缓存每元素字节数（与 main/recommend.js 相同的 ggml 块量化精确值：块字节数 / 块元素数）
export const KV_ELEM_BYTES = {
  f32: 4.0,
  f16: 2.0,
  bf16: 2.0,
  q8_0: 34 / 32,
  q4_0: 18 / 32,
  q4_1: 20 / 32,
  q5_0: 22 / 32,
  q5_1: 24 / 32,
  iq4_nl: 18 / 32,
};

export const AUTO_SLOTS = 4; // llama-server 未显式传 -np 时：n_parallel = 4 且 kv_unified = true
const PAD_CELLS = 256; // 引擎 GGML_PAD(x, 256)

export function padCells(n) {
  return Math.ceil(n / PAD_CELLS) * PAD_CELLS;
}

/** 引擎口径的 KV cells 数，base（非 SWA 层）与 swa（SWA 层）分开 */
export function kvCells(model, { ctx, parallel = 1, ubatch = 512, swaFull = false } = {}) {
  const nCtx = Math.max(1, Number(ctx) || 4096);
  const par = Math.max(1, Number(parallel) || 1);
  const unified = par <= 1;
  const slots = unified ? AUTO_SLOTS : par;
  const cellsPerSeq = unified ? padCells(nCtx) : padCells(Math.floor(nCtx / par));
  const base = cellsPerSeq * (unified ? 1 : par);
  const hasSwa = Number(model.swaWindow) > 0 && (model.kvUnitsKSwa || model.kvUnitsVSwa);
  let swa = 0;
  if (hasSwa) {
    if (swaFull) {
      swa = base;
    } else {
      const ub = Math.max(1, Number(ubatch) || 512);
      // 引擎：n_swa ×（unified 时才是槽数） + ubatch，再 pad256
      const win = unified
        ? Number(model.swaWindow) * slots + ub
        : Number(model.swaWindow) + ub;
      swa = padCells(Math.min(cellsPerSeq, win)) * (unified ? 1 : par);
    }
  }
  return { base, swa };
}

/** KV 缓存总字节数（与 main/recommend.js kvCacheBytes 同口径） */
export function kvCacheBytes(
  model,
  { ctx, parallel = 1, cacheTypeK = 'f16', cacheTypeV = 'f16', ubatch = 512, swaFull = false } = {}
) {
  const k = KV_ELEM_BYTES[cacheTypeK] ?? 2.0;
  const v = KV_ELEM_BYTES[cacheTypeV] ?? 2.0;
  const ku = model.kvUnitsK || 0;
  const vu = model.kvUnitsV || model.kvUnitsK || 0;
  const params = { ctx, parallel, ubatch, swaFull };
  if (!ku && !vu) {
    // 老对象：只有层数×头数×头维时按同一 cells 口径回退（与主进程一致）
    const layers = model.nAttnLayer || model.nLayer || 0;
    const perTok = layers * model.nKvHead * model.headDim * (k + v);
    return perTok * kvCells(model, params).base;
  }
  const { base, swa } = kvCells(model, params);
  const kuSwa = model.kvUnitsKSwa || 0;
  const vuSwa = model.kvUnitsVSwa || 0;
  const kuFull = Math.max(0, ku - kuSwa);
  const vuFull = Math.max(0, vu - vuSwa);
  return (kuFull * k + vuFull * v) * base + (kuSwa * k + vuSwa * v) * swa;
}

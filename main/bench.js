'use strict';
/**
 * 本机基准测试（仿 Mozilla llamafile LocalScore）
 *
 * 工作流：
 *   1. spawn llama-bench（用户本地 llama.cpp 构建产物），参数与启动引擎一致
 *   2. llama-bench 默认输出 markdown 表格，加 -o json 让它输出 JSON 数组
 *   3. 解析 prompt eval 与 generation 两条记录 → 计算 LocalScore
 *
 * LocalScore 公式（与 llamafile/localscore/localscore.cpp 一致）：
 *   score = 10 · ∛(avg_prompt_tps · avg_gen_tps · 1000/avg_ttft_ms)
 *
 * 设计要点：
 *   - 所有计算函数都是纯函数（无 IO / 无 spawn），便于单测
 *   - runBench() 只负责 spawn + 把 stdout 喂给纯解析器
 *   - 既支持 JSON 也支持 markdown 表格（引擎不同版本输出格式可能不同）
 */

const { spawn } = require('child_process');

/* ========================= 纯函数 ========================= */

/**
 * LocalScore 公式：综合 prompt TPS、gen TPS、TTFT 三项指标。
 * TTFT 没有时按"无穷快"算（即该因子视作 1）。
 *
 * @param {{promptTps?:number, genTps?:number, ttftMs?:number}} m
 * @returns {number} LocalScore
 */
function localScore({ promptTps, genTps, ttftMs } = {}) {
  const p = Number(promptTps);
  const g = Number(genTps);
  const t = Number(ttftMs);
  if (!Number.isFinite(p) || !Number.isFinite(g) || p <= 0 || g <= 0) return 0;
  // TTFT 没测出时按 1ms 计入（无损偏置）
  const tFactor = Number.isFinite(t) && t > 0 ? 1000 / t : 1000;
  return 10 * Math.cbrt(p * g * tFactor);
}

/**
 * 质量档位（与 llamafile README 对齐）
 *   ≥ 1000 优秀
 *   ≥ 250  可用
 *   ≥ 100  一般
 *   < 100  较弱
 */
function scoreTier(score) {
  if (score >= 1000) return { tier: 'excellent', label: '优秀', min: 1000 };
  if (score >= 250) return { tier: 'good', label: '可用', min: 250 };
  if (score >= 100) return { tier: 'fair', label: '一般', min: 100 };
  return { tier: 'poor', label: '较弱', min: 0 };
}

/**
 * 解析 llama-bench 的 JSON 输出。
 * 输入：stdout 字符串（可能含 BOM / 末尾换行 / 多余空格）
 * 输出：测试记录数组，每条形如
 *   { model_type, model_size, model_n_params, n_prompt, n_gen,
 *     n_gpu_layers, type_k, type_v, n_threads, avg_ns, avg_ts, stddev_ts, ... }
 *
 * 容错：
 *   - 顶层是数组；不是数组则抛错
 *   - JSON.parse 失败抛错（带原文前 200 字便于定位）
 *   - 元素不是对象跳过
 */
function parseBenchJson(stdout) {
  if (typeof stdout !== 'string') throw new Error('parseBenchJson: 输入不是字符串');
  const trimmed = stdout.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return [];
  let arr;
  try {
    arr = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`llama-bench JSON 解析失败: ${err.message}（原文前 200 字：${trimmed.slice(0, 200)}）`);
  }
  if (!Array.isArray(arr)) throw new Error('llama-bench JSON 顶层不是数组');
  return arr.filter((r) => r && typeof r === 'object');
}

/**
 * 把多条原始记录合成一个汇总结果：
 *   - 找第一条 n_prompt>0 且 n_gen===0 的（prompt eval）
 *   - 找第一条 n_prompt===0 且 n_gen>0 的（generation）
 *   - 若 n_prompt>0 且 n_gen>0 都给（混合），则拆成两个测试分别取
 *   - ttftMs：纯 prompt eval 记录（-p N -n 0）的 avg_ns 就是首 token 耗时
 *
 * @param {object[]} records
 * @returns {{
 *   promptTps: number|null,
 *   genTps: number|null,
 *   ttftMs: number|null,
 *   modelType: string|null,
 *   modelSize: number|null,
 *   modelParams: number|null,
 *   ngl: number|null,
 *   typeK: string|null,
 *   typeV: string|null,
 *   nThreads: number|null,
 *   nPrompt: number|null,
 *   nGen: number|null,
 *   localScore: number,
 *   raw: object[]
 * }}
 */
function summarizeBench(records) {
  const list = Array.isArray(records) ? records : [];

  // 选 prompt eval 记录：优先 n_prompt>0 && n_gen===0
  let promptRec = list.find((r) => Number(r.n_prompt) > 0 && (!r.n_gen || Number(r.n_gen) === 0));
  // 退化：n_prompt>0 但 n_gen>0 也算（混合模式取首条）
  if (!promptRec) promptRec = list.find((r) => Number(r.n_prompt) > 0);

  let genRec = list.find((r) => Number(r.n_gen) > 0 && (!r.n_prompt || Number(r.n_prompt) === 0));
  if (!genRec) genRec = list.find((r) => Number(r.n_gen) > 0);

  const first = list[0] || {};
  const ttftMs = pickTtftMs(promptRec);

  const promptTps = pickTps(promptRec);
  const genTps = pickTps(genRec);

  const summary = {
    promptTps,
    genTps,
    ttftMs,
    modelType: typeof first.model_type === 'string' ? first.model_type : null,
    modelSize: typeof first.model_size === 'number' ? first.model_size : null,
    // llama-bench 的 JSON 字段是 model_n_params（不是 model_params）
    modelParams: typeof first.model_n_params === 'number' ? first.model_n_params : null,
    ngl: typeof first.n_gpu_layers === 'number' ? first.n_gpu_layers : null,
    typeK: typeof first.type_k === 'string' ? first.type_k : null,
    typeV: typeof first.type_v === 'string' ? first.type_v : null,
    nThreads: typeof first.n_threads === 'number' ? first.n_threads : null,
    nPrompt: promptRec ? Number(promptRec.n_prompt) || null : null,
    nGen: genRec ? Number(genRec.n_gen) || null : null,
    localScore: 0,
    raw: list,
  };
  summary.localScore = localScore({ promptTps, genTps, ttftMs });
  return summary;
}

function pickTps(rec) {
  if (!rec) return null;
  const v = Number(rec.avg_ts);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * TTFT（首 token 时间，毫秒）
 *
 * llama-bench 的 JSON 里，每条记录由 get_fields() 输出
 * avg_ns / stddev_ns / avg_ts / stddev_ts，**之外**还额外追加两个数组
 * （llama-bench.cpp:1823）：samples_ns（每次重复的耗时，纳秒）与 samples_ts（对应 tok/s）。
 * 本项目早期误读成 `samples_ms`（字段名与单位都不对），导致 TTFT 恒为 null。
 *
 *   - 纯 prompt eval 记录（-p N -n 0）：一次重复的耗时就是"跑完整个 prompt"的时间，
 *     即首 token 到达前的时间 → 取 avg_ns / 1e6（多次重复取平均，比首个样本更稳）
 *   - 只有混合记录（n_prompt>0 且 n_gen>0）时：按 avg_ts 反推 prompt 段耗时
 *     （假设 prefill/decode 均速，偏乐观，仅作参考）
 */
function pickTtftMs(rec) {
  if (!rec) return null;
  const np = Number(rec.n_prompt);
  const ng = Number(rec.n_gen) || 0;

  if (np > 0 && ng === 0) {
    const ns = Number(rec.avg_ns);
    if (Number.isFinite(ns) && ns > 0) return ns / 1e6;
    // 没有 avg_ns 时退回首个样本（samples_ns 单位是纳秒）
    if (Array.isArray(rec.samples_ns) && rec.samples_ns.length > 0) {
      const first = Number(rec.samples_ns[0]);
      if (Number.isFinite(first) && first > 0) return first / 1e6;
    }
  }

  const ts = Number(rec.avg_ts);
  if (np > 0 && Number.isFinite(ts) && ts > 0) return (np / ts) * 1000;
  return null;
}

/**
 * 解析上下文深度输入。
 *
 * llama-bench 的 `-d/--n-depth` 是**向量参数**：`-d 0,4096,16384` 会在一次运行里
 * 依次测完多个深度（模型只加载一次）。深度含义：先往 KV 缓存里灌 N 个 token，
 * 再测 prompt 处理 / 生成 —— 也就是"上下文已经被占用到 N"时的性能。
 * 它的 n_ctx 由 n_prompt + n_gen + n_depth 内部推导，不需要（也没有）`-c`。
 *
 * 接受：数组、`"0,4096,16384"`、`"4k,16k"`（大小写 k/m 都行）。
 * 输出：去重、升序、只保留非负整数；全非法时返回 []（调用方按默认 0 处理）。
 *
 * @param {string|number[]} [input]
 * @returns {number[]}
 */
function parseDepths(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[,，\s]+/);
  const out = new Set();
  for (const v of raw) {
    if (v === '' || v === null || v === undefined) continue;
    const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)$/);
    if (!m) continue;
    const unit = m[2].toLowerCase();
    const mult = unit === 'k' ? 1024 : unit === 'm' ? 1024 * 1024 : 1;
    const n = Math.round(Number(m[1]) * mult);
    if (Number.isFinite(n) && n >= 0) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 按 n_depth 分组，逐深度汇总（多上下文基准的核心）。
 *
 * llama-bench 对每个深度会产出两条记录：prompt-only 与 gen-only，
 * 两条都带 n_depth 字段。老版本引擎没有 n_depth 时全部归到 0。
 *
 * @param {object[]} records parseBenchJson 的结果
 * @returns {{summary: object, byDepth: Array<{depth:number, promptTps:number|null, genTps:number|null, ttftMs:number|null, localScore:number, nPrompt:number|null, nGen:number|null}>}}
 *   summary 为第一个深度的汇总（保持与原单深度调用方的兼容）
 */
function summarizeByDepth(records) {
  const list = Array.isArray(records) ? records : [];
  const groups = new Map();
  for (const r of list) {
    const d = Number(r.n_depth);
    const depth = Number.isFinite(d) && d >= 0 ? d : 0;
    if (!groups.has(depth)) groups.set(depth, []);
    groups.get(depth).push(r);
  }

  const byDepth = [...groups.keys()].sort((a, b) => a - b).map((depth) => {
    const s = summarizeBench(groups.get(depth));
    return {
      depth,
      promptTps: s.promptTps,
      genTps: s.genTps,
      ttftMs: s.ttftMs,
      localScore: s.localScore,
      nPrompt: s.nPrompt,
      nGen: s.nGen,
    };
  });

  const summary = byDepth.length ? summarizeBench(groups.get(byDepth[0].depth)) : summarizeBench([]);
  return { summary, byDepth };
}

/**
 * 把上下文深度裁剪到模型能承受的范围。
 *
 * llama-bench 的 n_ctx = n_prompt + n_gen + n_depth，超过模型训练上下文时它**不会报错**，
 * 而是真的去分配并填满超长 KV —— 实测 -d 300000 在 256K 模型上会卡数分钟（还占满内存）。
 * 所以按 ctxTrain - nPrompt - nGen 封顶，超出的深度直接跳过并回报，让界面提示用户。
 *
 * @param {string|number[]} depths
 * @param {number} ctxTrain 模型训练上下文（0/未知则不限制）
 * @param {number} [nPrompt]
 * @param {number} [nGen]
 * @returns {{kept:number[], skipped:number[], limit:number|null}}
 */
function fitDepths(depths, ctxTrain, nPrompt = 512, nGen = 128) {
  const list = parseDepths(depths);
  const ctx = Number(ctxTrain);
  if (!Number.isFinite(ctx) || ctx <= 0) return { kept: list, skipped: [], limit: null };
  const limit = Math.max(0, Math.floor(ctx) - Number(nPrompt) - Number(nGen));
  const kept = [];
  const skipped = [];
  for (const d of list) (d <= limit ? kept : skipped).push(d);
  return { kept, skipped, limit };
}

/**
 * 把启动参数对象翻译为 llama-bench 命令行参数。
 * 与 shared/args.js 的 buildArgs 对齐，但只取 bench 关心的字段。
 *
 * 注意：llama-bench **没有** `-c/--ctx-size`（它的 n_ctx 由 n_prompt + n_gen + n_depth
 * 内部推导，只有 `-fitc` 是给 --fit-target 用的）。早先这里会下发 `-c <ctx>`，
 * 结果是 llama-bench 直接打印用法、不跑测试 → 界面上的「跑基准」永远拿不到 JSON。
 * 这类"上游不认的参数"由 scripts/check-engine-flags.js 兜底检查。
 *
 * @param {object} opts { modelPath, params:{ngl, flashAttn, cacheTypeK, cacheTypeV, threads, ...},
 *                        bench:{depths, reps, nPrompt, nGen} }
 * @returns {string[]}
 */
function buildBenchArgs({ modelPath, params = {}, bench = {} }) {
  const a = ['-m', String(modelPath)];
  // 强制 JSON 输出
  a.push('-o', 'json');
  if (params.ngl !== undefined && params.ngl !== '' && params.ngl !== 'auto') {
    a.push('-ngl', String(params.ngl === 'all' ? 99 : params.ngl));
  }
  if (params.threads && Number(params.threads) > 0) {
    a.push('-t', String(params.threads));
  }
  if (params.cacheTypeK && params.cacheTypeK !== 'f16') a.push('-ctk', String(params.cacheTypeK));
  if (params.cacheTypeV && params.cacheTypeV !== 'f16') a.push('-ctv', String(params.cacheTypeV));
  if (params.flashAttn && params.flashAttn !== 'auto') a.push('-fa', String(params.flashAttn));

  const nPrompt = Number(bench.nPrompt) > 0 ? Math.floor(Number(bench.nPrompt)) : 512;
  const nGen = Number(bench.nGen) > 0 ? Math.floor(Number(bench.nGen)) : 128;
  // prompt 512 + gen 128：与 upstream 默认一致；足够反映稳态性能
  a.push('-p', String(nPrompt), '-n', String(nGen));

  // 上下文深度（多选一次跑完）：0 是引擎默认值，不必显式下发
  const depths = parseDepths(bench.depths);
  if (depths.length > 0 && !(depths.length === 1 && depths[0] === 0)) {
    a.push('-d', depths.join(','));
  }

  // 重复次数（llama-bench 默认 5；上限挡一下，避免误填 1e9 跑一整天）
  const reps = Number(bench.reps);
  if (Number.isFinite(reps) && reps >= 1) a.push('-r', String(Math.min(Math.floor(reps), 99)));

  return a;
}

/* ========================= spawn 入口 ========================= */

/**
 * 跑一次基准测试。
 *
 * @param {{bin:string, modelPath:string, params:object, bench?:object, timeoutMs?:number}} o
 *   bench: { depths, reps, nPrompt, nGen } —— 深度可多个，一次 spawn 跑完
 * @param {{onLog?:Function}} [cb]
 * @returns {Promise<{ok:boolean, summary:object, byDepth:object[], rawStdout:string, error?:string}>}
 */
/**
 * 跑一遍 llama-bench（单次 spawn），只负责「把进程跑完 + 收集 stdout」。
 * @returns {Promise<{ok:boolean, stdout:string, error?:string}>}
 */
function spawnBench({ bin, args, env, timeoutMs, onLog }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    let p;
    try {
      p = spawn(bin, args, { env: env || { ...process.env }, cwd: process.cwd() });
    } catch (err) {
      done({ ok: false, stdout: '', error: `启动失败: ${err.message}` });
      return;
    }

    if (onLog) onLog(`$ llama-bench ${args.join(' ')}\n`);

    const timer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch {}
      done({ ok: false, stdout, error: `超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);

    p.stdout.on('data', (d) => {
      const t = d.toString();
      stdout += t;
      if (onLog) onLog(t);
    });
    p.stderr.on('data', (d) => {
      const t = d.toString();
      stderr += t;
      if (onLog) onLog(t);
    });
    p.on('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, stdout, error: `启动失败: ${err.message}` });
    });
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout) {
        done({ ok: false, stdout, error: `exit=${code} stderr=${stderr.slice(-500)}` });
        return;
      }
      done({ ok: true, stdout });
    });
  });
}

/**
 * 把「关闭 tensor API」那一轮的 prompt/生成吞吐并到主结果里，算出加速比。
 * 生成阶段基本不受 tensor API 影响（访存受限），所以 genSpeedup 通常 ≈1，
 * 留着是为了让异常一眼可见（比如某些量化会走不同内核）。
 *
 * @param {object[]} rows 主结果（tensor 开启）
 * @param {object[]} compareRows 对照结果（tensor 关闭）
 */
function mergeCompare(rows, compareRows) {
  const byDepth = new Map((compareRows || []).map((r) => [r.depth, r]));
  return (rows || []).map((r) => {
    const base = byDepth.get(r.depth);
    const ratio = (a, b) => (a > 0 && b > 0 ? a / b : null);
    return {
      ...r,
      promptSpeedup: ratio(Number(r.promptTps), Number(base && base.promptTps)),
      genSpeedup: ratio(Number(r.genTps), Number(base && base.genTps)),
    };
  });
}

/**
 * 跑一次基准测试。
 *
 * @param {{bin:string, modelPath:string, params:object, bench?:object, timeoutMs?:number}} o
 *   bench: { depths, reps, nPrompt, nGen, ctxTrain, compareTensor }
 *   compareTensor=true 时会再跑一遍（GGML_METAL_TENSOR_DISABLE=1），用于量化 M5 神经加速器收益
 * @param {{onLog?:Function}} [cb]
 * @returns {Promise<{ok:boolean, summary:object, byDepth:object[], compare:object[]|null, skippedDepths:number[], rawStdout:string, error?:string}>}
 */
async function runBench({ bin, modelPath, params, bench = {}, timeoutMs }, cb = {}) {
  // 深度上限的兜底：渲染层已经按模型上下文裁过，这里再挡一次（界面逻辑改动不会让引擎跑飞）
  const fit = fitDepths(bench.depths, bench.ctxTrain, bench.nPrompt || 512, bench.nGen || 128);
  const args = buildBenchArgs({ modelPath, params, bench: { ...bench, depths: fit.kept } });
  const nDepths = Math.max(1, fit.kept.length);
  const reps = Math.max(1, Math.min(99, Math.floor(Number(bench.reps)) || 5));
  // 超时按「深度数 × 重复次数」放大：深上下文每次都要重新预填 KV，比 depth 0 慢得多
  const limitMs = Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : Math.min(30 * 60 * 1000, 120000 + 12000 * nDepths * reps);

  const fail = (error, stdout = '') => ({
    ok: false, summary: null, byDepth: [], compare: null, skippedDepths: fit.skipped, rawStdout: stdout, error,
  });

  const first = await spawnBench({ bin, args, timeoutMs: limitMs, onLog: cb.onLog });
  if (!first.ok) return fail(first.error, first.stdout);

  let parsed;
  try {
    parsed = summarizeByDepth(parseBenchJson(first.stdout));
  } catch (err) {
    return fail(err.message, first.stdout);
  }

  // 可选对照：关掉 Metal tensor API 再跑一遍，量化 M5 神经加速器的收益
  let compareRows = null;
  if (bench.compareTensor) {
    if (cb.onLog) cb.onLog('\n[对照] 关闭 Metal tensor API 再跑一遍（GGML_METAL_TENSOR_DISABLE=1）…\n');
    const second = await spawnBench({
      bin,
      args,
      env: { ...process.env, GGML_METAL_TENSOR_DISABLE: '1' },
      timeoutMs: limitMs,
      onLog: cb.onLog,
    });
    if (second.ok) {
      try {
        compareRows = summarizeByDepth(parseBenchJson(second.stdout)).byDepth;
      } catch {
        compareRows = null;
      }
    } else if (cb.onLog) {
      cb.onLog(`[对照] 跳过：${second.error}\n`);
    }
  }

  const byDepth = compareRows ? mergeCompare(parsed.byDepth, compareRows) : parsed.byDepth;
  return {
    ok: true,
    summary: parsed.summary,
    byDepth,
    compare: compareRows,
    skippedDepths: fit.skipped,
    rawStdout: first.stdout,
  };
}

module.exports = {
  localScore,
  scoreTier,
  parseBenchJson,
  parseDepths,
  fitDepths,
  summarizeBench,
  summarizeByDepth,
  buildBenchArgs,
  mergeCompare,
  runBench,
};
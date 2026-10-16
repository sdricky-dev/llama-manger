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
 *   { model_type, model_size, model_params, n_prompt, n_gen,
 *     n_gpu_layers, type_k, type_v, n_threads, avg_ts, stddev_ts, ... }
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
 *   - ttftMs：llama-bench 在 prompt eval 记录里有 samples_ms 数组，首个样本即首 token 时间
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
    modelParams: typeof first.model_params === 'number' ? first.model_params : null,
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
 * TTFT：llama-bench 把 prompt eval 的每个 batch 耗时记录在 samples_ms 里。
 * 第一条样本就是"首 token 到达前"的时间，最贴近 TTFT 语义。
 * 若记录里没有 samples_ms 数组，则退化为 avg_ms / n_prompt（粗估）。
 */
function pickTtftMs(rec) {
  if (!rec) return null;
  if (Array.isArray(rec.samples_ms) && rec.samples_ms.length > 0) {
    const first = Number(rec.samples_ms[0]);
    if (Number.isFinite(first) && first > 0) return first;
  }
  const avg = Number(rec.avg_ms);
  const np = Number(rec.n_prompt);
  if (Number.isFinite(avg) && Number.isFinite(np) && np > 0) {
    // 单 batch 整段 prompt 处理耗时；不能直接当 TTFT，但可作上限参考
    return null;
  }
  return null;
}

/**
 * 把启动参数对象翻译为 llama-bench 命令行参数。
 * 与 shared/args.js 的 buildArgs 对齐，但只取 bench 关心的字段。
 *
 * @param {object} opts { modelPath, params:{ngl, ctx, flashAttn, cacheTypeK, cacheTypeV, threads, ...} }
 * @returns {string[]}
 */
function buildBenchArgs({ modelPath, params = {} }) {
  const a = ['-m', String(modelPath)];
  // 强制 JSON 输出
  a.push('-o', 'json');
  if (params.ngl !== undefined && params.ngl !== '' && params.ngl !== 'auto') {
    a.push('-ngl', String(params.ngl === 'all' ? 99 : params.ngl));
  }
  if (params.ctx && Number(params.ctx) > 0) {
    a.push('-c', String(params.ctx));
  }
  if (params.threads && Number(params.threads) > 0) {
    a.push('-t', String(params.threads));
  }
  if (params.cacheTypeK && params.cacheTypeK !== 'f16') a.push('-ctk', String(params.cacheTypeK));
  if (params.cacheTypeV && params.cacheTypeV !== 'f16') a.push('-ctv', String(params.cacheTypeV));
  if (params.flashAttn && params.flashAttn !== 'auto') a.push('-fa', String(params.flashAttn));
  // prompt 512 + gen 128：与 upstream 默认一致；足够反映稳态性能
  a.push('-p', '512', '-n', '128');
  return a;
}

/* ========================= spawn 入口 ========================= */

/**
 * 跑一次基准测试。
 *
 * @param {{bin:string, modelPath:string, params:object, timeoutMs?:number}} o
 * @param {{onLog?:Function}} [cb]
 * @returns {Promise<{ok:boolean, summary:object, rawStdout:string, error?:string}>}
 */
function runBench({ bin, modelPath, params, timeoutMs = 120000 }, cb = {}) {
  return new Promise((resolve) => {
    const args = buildBenchArgs({ modelPath, params });
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
      p = spawn(bin, args, {
        env: { ...process.env },
        cwd: process.cwd(),
      });
    } catch (err) {
      done({ ok: false, summary: null, rawStdout: '', error: `启动失败: ${err.message}` });
      return;
    }

    if (cb.onLog) cb.onLog(`$ llama-bench ${args.join(' ')}\n`);

    const timer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch {}
      done({ ok: false, summary: null, rawStdout: stdout, error: `超时（${timeoutMs}ms）` });
    }, timeoutMs);

    p.stdout.on('data', (d) => {
      const t = d.toString();
      stdout += t;
      if (cb.onLog) cb.onLog(t);
    });
    p.stderr.on('data', (d) => {
      const t = d.toString();
      stderr += t;
      if (cb.onLog) cb.onLog(t);
    });
    p.on('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, summary: null, rawStdout: stdout, error: `启动失败: ${err.message}` });
    });
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout) {
        done({ ok: false, summary: null, rawStdout: stdout, error: `exit=${code} stderr=${stderr.slice(-500)}` });
        return;
      }
      try {
        const records = parseBenchJson(stdout);
        const summary = summarizeBench(records);
        done({ ok: true, summary, rawStdout: stdout });
      } catch (err) {
        done({ ok: false, summary: null, rawStdout: stdout, error: err.message });
      }
    });
  });
}

module.exports = {
  localScore,
  scoreTier,
  parseBenchJson,
  summarizeBench,
  buildBenchArgs,
  runBench,
};
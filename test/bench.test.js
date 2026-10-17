'use strict';
/**
 * LocalScore 基准模块单元测试
 *
 * 覆盖：
 *   - localScore 公式正确性
 *   - scoreTier 档位
 *   - parseBenchJson 解析 / 容错
 *   - summarizeBench 多记录汇总 + TTFT 选取
 *   - buildBenchArgs 参数翻译
 *   - parseDepths 上下文深度解析（多深度 / 4k 写法 / 去重排序）
 *   - summarizeByDepth 按深度分组汇总
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  localScore,
  scoreTier,
  parseBenchJson,
  summarizeBench,
  summarizeByDepth,
  parseDepths,
  fitDepths,
  buildBenchArgs,
} = require('../main/bench');

/* ---------- localScore ---------- */

test('localScore：典型数值与 llamafile 公式一致', () => {
  // llama.cpp 文档示例：Q4_K_M 7B 在 M2 上 ≈ prompt 200 TPS / gen 25 TPS / TTFT 100ms
  // score = 10·∛(200·25·10) = 10·∛50000 ≈ 10·36.84 ≈ 368
  const score = localScore({ promptTps: 200, genTps: 25, ttftMs: 100 });
  assert.ok(score > 360 && score < 380, `应接近 368，实际 ${score}`);
});

test('localScore：TTFT 缺失时不报错，按 1ms 算', () => {
  const a = localScore({ promptTps: 100, genTps: 10 });
  const b = localScore({ promptTps: 100, genTps: 10, ttftMs: 1 });
  assert.equal(a, b);
});

test('localScore：0 或负数 → 0', () => {
  assert.equal(localScore({ promptTps: 0, genTps: 10 }), 0);
  assert.equal(localScore({ promptTps: 10, genTps: 0 }), 0);
  assert.equal(localScore({}), 0);
});

test('localScore：TTFT 越快分越高（gen 与 prompt 不变时）', () => {
  const slow = localScore({ promptTps: 100, genTps: 10, ttftMs: 1000 });
  const fast = localScore({ promptTps: 100, genTps: 10, ttftMs: 50 });
  assert.ok(fast > slow * 2);
});

/* ---------- scoreTier ---------- */

test('scoreTier：四档划分', () => {
  assert.equal(scoreTier(1500).tier, 'excellent');
  assert.equal(scoreTier(1000).tier, 'excellent');
  assert.equal(scoreTier(800).tier, 'good');
  assert.equal(scoreTier(250).tier, 'good');
  assert.equal(scoreTier(200).tier, 'fair');
  assert.equal(scoreTier(100).tier, 'fair');
  assert.equal(scoreTier(50).tier, 'poor');
  assert.equal(scoreTier(0).tier, 'poor');
});

/* ---------- parseBenchJson ---------- */

test('parseBenchJson：正常 JSON 数组', () => {
  const stdout = JSON.stringify([
    { model_type: 'qwen2', n_prompt: 512, n_gen: 0, avg_ts: 200.0 },
    { model_type: 'qwen2', n_prompt: 0, n_gen: 128, avg_ts: 25.0 },
  ]);
  const r = parseBenchJson(stdout);
  assert.equal(r.length, 2);
  assert.equal(r[0].avg_ts, 200.0);
});

test('parseBenchJson：去掉 BOM 与尾部空白', () => {
  const stdout = '\uFEFF' + JSON.stringify([{ n_prompt: 1, avg_ts: 1 }]) + '\n  \n';
  assert.equal(parseBenchJson(stdout).length, 1);
});

test('parseBenchJson：空字符串返回 []', () => {
  assert.deepEqual(parseBenchJson(''), []);
  assert.deepEqual(parseBenchJson('   '), []);
});

test('parseBenchJson：非 JSON 抛错（带原文前 200 字）', () => {
  assert.throws(() => parseBenchJson('not json'), /JSON 解析失败/);
});

test('parseBenchJson：顶层不是数组抛错', () => {
  assert.throws(() => parseBenchJson('{}'), /顶层不是数组/);
});

test('parseBenchJson：过滤掉非对象元素', () => {
  const stdout = JSON.stringify([{ x: 1 }, null, 's', 42, { y: 2 }]);
  const r = parseBenchJson(stdout);
  assert.equal(r.length, 2);
});

/* ---------- summarizeBench ---------- */

test('summarizeBench：prompt + gen 两条记录合成', () => {
  const records = [
    {
      model_type: 'qwen2',
      model_size: 4_500_000_000,
      model_n_params: 1_500_000_000,
      n_gpu_layers: 99,
      type_k: 'f16',
      type_v: 'f16',
      n_threads: 8,
      n_prompt: 512,
      n_gen: 0,
      avg_ns: 110_000_000,
      avg_ts: 200.0,
    },
    {
      model_type: 'qwen2',
      model_size: 4_500_000_000,
      model_n_params: 1_500_000_000,
      n_gpu_layers: 99,
      type_k: 'f16',
      type_v: 'f16',
      n_threads: 8,
      n_prompt: 0,
      n_gen: 128,
      avg_ts: 25.0,
    },
  ];
  const s = summarizeBench(records);
  assert.equal(s.promptTps, 200.0);
  assert.equal(s.genTps, 25.0);
  assert.equal(s.ttftMs, 110, 'avg_ns 110ms → TTFT 110ms（纯 prompt eval）');
  assert.equal(s.modelType, 'qwen2');
  assert.equal(s.modelParams, 1_500_000_000, '上游字段是 model_n_params');
  assert.equal(s.ngl, 99);
  assert.equal(s.nPrompt, 512);
  assert.equal(s.nGen, 128);
  assert.equal(s.localScore > 0, true);
});

test('summarizeBench：只有 model_params（旧字段名）时参数量为 null', () => {
  const s = summarizeBench([{ model_type: 'qwen2', model_params: 1_500_000_000, n_prompt: 512, n_gen: 0, avg_ts: 100 }]);
  assert.equal(s.modelParams, null);
});

test('summarizeBench：缺少 prompt 记录时 TTFT 为 null', () => {
  const records = [
    { model_type: 'qwen2', n_prompt: 0, n_gen: 128, avg_ts: 25.0 },
  ];
  const s = summarizeBench(records);
  assert.equal(s.promptTps, null);
  assert.equal(s.genTps, 25.0);
  assert.equal(s.ttftMs, null);
});

test('summarizeBench：只有 prompt 记录时 gen 为 null', () => {
  const records = [
    { model_type: 'qwen2', n_prompt: 512, n_gen: 0, avg_ts: 100.0, avg_ns: 120_000_000 },
  ];
  const s = summarizeBench(records);
  assert.equal(s.promptTps, 100.0);
  assert.equal(s.genTps, null);
  assert.equal(s.ttftMs, 120);
});

test('summarizeBench：只有混合记录时 TTFT 用 n_prompt/avg_ts 估算', () => {
  const records = [
    { model_type: 'qwen2', n_prompt: 512, n_gen: 128, avg_ts: 80.0 },
  ];
  const s = summarizeBench(records);
  // 优先 n_prompt>0 && n_gen===0；没有就退而求其次取首条
  assert.equal(s.promptTps, 80.0);
  // 混合记录没有单独的 prefill 耗时，按 512 / 80 tok/s ≈ 6400ms 估算
  assert.equal(s.ttftMs, 6400);
});

test('summarizeBench：空数组返回全 null + score=0', () => {
  const s = summarizeBench([]);
  assert.equal(s.promptTps, null);
  assert.equal(s.genTps, null);
  assert.equal(s.ttftMs, null);
  assert.equal(s.localScore, 0);
});

test('summarizeBench：prompt 记录缺 avg_ns 时退回 samples_ns[0]（真实 JSON 有这两个字段）', () => {
  const s = summarizeBench([{ n_prompt: 512, n_gen: 0, avg_ts: 100.0, samples_ns: [210_745_417, 212_097_083] }]);
  assert.equal(s.ttftMs, 210.745417);
});

test('summarizeBench：prompt 记录既无 avg_ns 也无 samples_ns 时退回 avg_ts 估算（不留 NaN）', () => {
  const records = [
    { n_prompt: 512, n_gen: 0, avg_ts: 100.0 },
  ];
  const s = summarizeBench(records);
  assert.equal(s.ttftMs, 5120);
  assert.equal(Number.isFinite(s.localScore), true);
});

test('summarizeBench：prompt 记录既无 avg_ns 也无 avg_ts → TTFT null', () => {
  const s = summarizeBench([{ n_prompt: 512, n_gen: 0 }]);
  assert.equal(s.ttftMs, null);
});

test('summarizeBench：0/负值 TPS 视作无效', () => {
  const records = [
    { n_prompt: 512, n_gen: 0, avg_ts: 0 },
    { n_prompt: 0, n_gen: 128, avg_ts: -1 },
  ];
  const s = summarizeBench(records);
  assert.equal(s.promptTps, null);
  assert.equal(s.genTps, null);
  assert.equal(s.localScore, 0);
});

/* ---------- buildBenchArgs ---------- */

test('buildBenchArgs：基础参数 + 强制 -o json + 默认 -p 512 -n 128', () => {
  const a = buildBenchArgs({
    modelPath: '/m.gguf',
    params: { ngl: 'auto' },
  });
  assert.ok(a[0] === '-m' && a[1] === '/m.gguf');
  // -o json 必须出现
  const oIdx = a.indexOf('-o');
  assert.ok(oIdx >= 0 && a[oIdx + 1] === 'json');
  // -p 512 -n 128 必须出现
  const pIdx = a.indexOf('-p');
  assert.ok(pIdx >= 0 && a[pIdx + 1] === '512');
  const nIdx = a.indexOf('-n');
  assert.ok(nIdx >= 0 && a[nIdx + 1] === '128');
});

test('buildBenchArgs：ngl 数字 → 直接下发', () => {
  const a = buildBenchArgs({ modelPath: '/m', params: { ngl: 28 } });
  assert.ok(a.includes('-ngl') && a[a.indexOf('-ngl') + 1] === '28');
});

test('buildBenchArgs：ngl "all" → 当作 99 层', () => {
  const a = buildBenchArgs({ modelPath: '/m', params: { ngl: 'all' } });
  assert.equal(a[a.indexOf('-ngl') + 1], '99');
});

test('buildBenchArgs：ngl "auto" 不下发', () => {
  const a = buildBenchArgs({ modelPath: '/m', params: { ngl: 'auto' } });
  assert.ok(!a.includes('-ngl'));
});

test('buildBenchArgs：绝不下发 -c（llama-bench 没有 ctx-size 参数）', () => {
  // 带上 -c 会让 llama-bench 打印用法、不跑测试 → 界面「跑基准」永远拿不到 JSON。
  // 回归守门在 scripts/check-engine-flags.js（对照引擎 --help 检查所有下发的 flag）。
  assert.ok(!buildBenchArgs({ modelPath: '/m', params: { ctx: 0 } }).includes('-c'));
  assert.ok(!buildBenchArgs({ modelPath: '/m', params: { ctx: 262144 } }).includes('-c'));
});

test('buildBenchArgs：cacheTypeK 非 f16 才下发 -ctk', () => {
  const a1 = buildBenchArgs({ modelPath: '/m', params: { cacheTypeK: 'f16' } });
  assert.ok(!a1.includes('-ctk'));
  const a2 = buildBenchArgs({ modelPath: '/m', params: { cacheTypeK: 'q8_0' } });
  assert.ok(a2.includes('-ctk') && a2[a2.indexOf('-ctk') + 1] === 'q8_0');
});

test('buildBenchArgs：flashAttn 非 auto 才下发', () => {
  const a1 = buildBenchArgs({ modelPath: '/m', params: { flashAttn: 'auto' } });
  assert.ok(!a1.includes('-fa'));
  const a2 = buildBenchArgs({ modelPath: '/m', params: { flashAttn: 'on' } });
  assert.ok(a2.includes('-fa'));
});

test('buildBenchArgs：threads 0 不下发', () => {
  const a = buildBenchArgs({ modelPath: '/m', params: { threads: 0 } });
  assert.ok(!a.includes('-t'));
});
/* ---------- parseDepths ---------- */

test('parseDepths：逗号/空格/中文逗号混用，去重升序', () => {
  assert.deepEqual(parseDepths('0, 4096，8192 4096'), [0, 4096, 8192]);
});

test('parseDepths：支持 4k / 16K / 1m 写法（1024 进制）', () => {
  assert.deepEqual(parseDepths('4k,16K'), [4096, 16384]);
  assert.deepEqual(parseDepths('1m'), [1024 * 1024]);
});

test('parseDepths：非法项丢弃，空输入返回空数组', () => {
  assert.deepEqual(parseDepths('abc, -1, ,4x'), []);
  assert.deepEqual(parseDepths(''), []);
  assert.deepEqual(parseDepths(undefined), []);
});

test('parseDepths：数组输入也接受', () => {
  assert.deepEqual(parseDepths([8192, '4k', 0]), [0, 4096, 8192]);
});

/* ---------- summarizeByDepth ---------- */

const depthRecords = [
  { n_depth: 0, n_prompt: 512, n_gen: 0, avg_ns: 210e6, avg_ts: 2400 },
  { n_depth: 0, n_prompt: 0, n_gen: 128, avg_ts: 75 },
  { n_depth: 8192, n_prompt: 512, n_gen: 0, avg_ns: 260e6, avg_ts: 1900 },
  { n_depth: 8192, n_prompt: 0, n_gen: 128, avg_ts: 68 },
];

test('summarizeByDepth：每个深度各一行，按深度升序', () => {
  const { byDepth } = summarizeByDepth(depthRecords);
  assert.deepEqual(byDepth.map((r) => r.depth), [0, 8192]);
  assert.equal(byDepth[0].promptTps, 2400);
  assert.equal(byDepth[0].genTps, 75);
  assert.equal(Math.round(byDepth[0].ttftMs), 210);
  assert.equal(byDepth[1].promptTps, 1900);
  assert.equal(byDepth[1].genTps, 68);
  // 深度越大分数应该越低（这里是构造数据）
  assert.ok(byDepth[1].localScore < byDepth[0].localScore);
});

test('summarizeByDepth：summary 取第一个深度，兼容单深度老调用方', () => {
  const { summary } = summarizeByDepth(depthRecords);
  assert.equal(summary.promptTps, 2400);
  assert.equal(summary.nPrompt, 512);
  assert.equal(summary.nGen, 128);
});

test('summarizeByDepth：没有 n_depth 字段的老 engine 全归深度 0', () => {
  const { byDepth } = summarizeByDepth([
    { n_prompt: 512, n_gen: 0, avg_ts: 100 },
    { n_prompt: 0, n_gen: 128, avg_ts: 20 },
  ]);
  assert.deepEqual(byDepth.map((r) => r.depth), [0]);
  assert.equal(byDepth[0].promptTps, 100);
});

test('summarizeByDepth：空输入不炸，返回空 byDepth', () => {
  const { byDepth, summary } = summarizeByDepth([]);
  assert.deepEqual(byDepth, []);
  assert.equal(summary.localScore, 0);
});

/* ---------- buildBenchArgs：深度 / 重复次数 ---------- */

test('buildBenchArgs：多深度合并成一个 -d 向量参数', () => {
  const a = buildBenchArgs({ modelPath: '/m', params: {}, bench: { depths: '0,4096,16384' } });
  const i = a.indexOf('-d');
  assert.ok(i >= 0);
  assert.equal(a[i + 1], '0,4096,16384');
});

test('buildBenchArgs：只有深度 0 时不发 -d（引擎默认就是 0）', () => {
  assert.ok(!buildBenchArgs({ modelPath: '/m', params: {}, bench: { depths: '0' } }).includes('-d'));
  assert.ok(!buildBenchArgs({ modelPath: '/m', params: {}, bench: { depths: '' } }).includes('-d'));
  assert.ok(!buildBenchArgs({ modelPath: '/m', params: {} }).includes('-d'));
});

test('buildBenchArgs：重复次数 → -r，并夹在 1..99', () => {
  const a = buildBenchArgs({ modelPath: '/m', params: {}, bench: { reps: 3 } });
  assert.equal(a[a.indexOf('-r') + 1], '3');
  assert.equal(buildBenchArgs({ modelPath: '/m', params: {}, bench: { reps: 0 } }).indexOf('-r'), -1);
  assert.equal(
    buildBenchArgs({ modelPath: '/m', params: {}, bench: { reps: 1000 } })[
      buildBenchArgs({ modelPath: '/m', params: {}, bench: { reps: 1000 } }).indexOf('-r') + 1
    ],
    '99'
  );
});

test('buildBenchArgs：prompt / 生成长度可覆盖默认 512/128', () => {
  const a = buildBenchArgs({ modelPath: '/m', params: {}, bench: { nPrompt: 1024, nGen: 256 } });
  assert.equal(a[a.indexOf('-p') + 1], '1024');
  assert.equal(a[a.indexOf('-n') + 1], '256');
});

/* ---------- fitDepths ---------- */

test('fitDepths：按 ctxTrain - prompt - gen 封顶，超限的深度被跳过', () => {
  const r = fitDepths('0,4096,300000', 262144);
  assert.deepEqual(r.kept, [0, 4096]);
  assert.deepEqual(r.skipped, [300000]);
  assert.equal(r.limit, 262144 - 512 - 128);
});

test('fitDepths：不知道训练上下文时不限制', () => {
  assert.deepEqual(fitDepths('0,131072', 0), { kept: [0, 131072], skipped: [], limit: null });
  assert.deepEqual(fitDepths('0,131072', undefined).skipped, []);
});

test('fitDepths：上下文比 prompt+gen 还小时 limit 不为负（深度 0 仍保留）', () => {
  const r = fitDepths('0,512', 600);
  assert.deepEqual(r.kept, [0]);
  assert.deepEqual(r.skipped, [512]);
  assert.equal(r.limit, 0);
});

'use strict';
/**
 * 唯一的 CLI 参数映射来源（single source of truth）。
 * main 进程用它 spawn 引擎 / 生成终端脚本，渲染层通过 IPC 取预览字符串。
 */

function fmt(n) {
  return String(n);
}

/**
 * 根据参数对象生成 llama.cpp 命令行参数数组。
 * @param {object} p  参数对象（见 i18n.js PARAMS 定义）
 * @param {string} modelPath  GGUF 模型路径
 * @param {'cli'|'server'} mode
 */
function buildArgs(p, modelPath, mode) {
  const a = ['-m', modelPath];

  // --- 附属文件：视觉投影 / 草稿模型 ---
  if (p.mmproj) a.push('-mm', String(p.mmproj));
  if (p.mmprojOffload === false) a.push('--no-mmproj-offload');
  if (p.specDraft) {
    a.push('-md', String(p.specDraft));
    if (p.specDraftNgl !== undefined && p.specDraftNgl !== '' && p.specDraftNgl !== 'auto') {
      a.push('-ngld', p.specDraftNgl === 'all' ? 'all' : fmt(p.specDraftNgl));
    }
  }
  // 内置 MTP 等无需草稿文件的投机解码：单独给 --spec-type 即可
  if (p.specType && p.specType !== 'none') a.push('--spec-type', String(p.specType));

  // --- 引擎与内存 ---
  if (p.ngl !== undefined && p.ngl !== '' && p.ngl !== 'auto') {
    a.push('-ngl', p.ngl === 'all' ? 'all' : fmt(p.ngl));
  }
  if (p.cpuMoe) a.push('-cmoe');
  if (p.nCpuMoe > 0) a.push('-ncmoe', fmt(p.nCpuMoe));
  if (p.flashAttn && p.flashAttn !== 'auto') a.push('-fa', p.flashAttn);
  if (p.ctx > 0) a.push('-c', fmt(p.ctx));
  if (p.cacheTypeK && p.cacheTypeK !== 'f16') a.push('-ctk', p.cacheTypeK);
  if (p.cacheTypeV && p.cacheTypeV !== 'f16') a.push('-ctv', p.cacheTypeV);
  if (p.parallel > 1) a.push('-np', fmt(p.parallel));
  if (p.kvOffload === false) a.push('--no-kv-offload');
  if (p.swaFull) a.push('--swa-full');

  // --- 性能 ---
  if (p.threads > 0) a.push('-t', fmt(p.threads));
  if (p.threadsBatch > 0) a.push('-tb', fmt(p.threadsBatch));
  if (p.batch > 0 && p.batch !== 2048) a.push('-b', fmt(p.batch));
  if (p.ubatch > 0 && p.ubatch !== 512) a.push('-ub', fmt(p.ubatch));

  // --- 采样 ---
  a.push('--temp', fmt(p.temp));
  a.push('--top-k', fmt(p.topK));
  a.push('--top-p', fmt(p.topP));
  a.push('--min-p', fmt(p.minP));
  a.push('--repeat-penalty', fmt(p.repeatPenalty));
  a.push('-s', fmt(p.seed));

  // --- 高级 ---
  if (p.ropeScaling && p.ropeScaling !== 'none') {
    a.push('--rope-scaling', p.ropeScaling);
    if (p.yarnOrigCtx > 0) a.push('--yarn-orig-ctx', fmt(p.yarnOrigCtx));
  }
  if (p.mlock) a.push('--mlock');
  if (p.loadMode && p.loadMode !== 'auto') a.push('--load-mode', p.loadMode);
  if (p.splitMode && p.splitMode !== 'layer') a.push('--split-mode', p.splitMode);
  if (p.tensorSplit) a.push('--tensor-split', String(p.tensorSplit));
  if (p.mainGpu > 0) a.push('--main-gpu', fmt(p.mainGpu));
  if (p.lora) a.push('--lora', String(p.lora));
  if (p.samplers && p.samplers !== 'default') a.push('--samplers', String(p.samplers));
  if (p.mirostat > 0) {
    a.push('--mirostat', fmt(p.mirostat));
    a.push('--mirostat-lr', fmt(p.mirostatLr));
  }
  if (p.ignoreEos) a.push('--ignore-eos');

  // --- server 专属 ---
  if (mode === 'server') {
    a.push('--host', p.host || '127.0.0.1');
    a.push('--port', fmt(p.port || 9931));
    if (p.apiKey) a.push('--api-key', String(p.apiKey));
    if (p.metrics) a.push('--metrics');
    // 会话存盘：把 slot 的提示词缓存 + KV 状态写入磁盘，可秒级恢复
    if (p.slotSavePath) a.push('--slot-save-path', String(p.slotSavePath));
  }

  return a;
}

function shellQuote(s) {
  s = String(s);
  // 纯安全字符集直接输出；其余一律单引号包裹（空格/引号/$/; 等）
  if (/^[A-Za-z0-9._/:,@+=%-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function argsToString(args) {
  return args.map(shellQuote).join(' ');
}

module.exports = { buildArgs, argsToString };

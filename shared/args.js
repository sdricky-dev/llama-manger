'use strict';
/**
 * 唯一的 CLI 参数映射来源（single source of truth）。
 * main 进程用它 spawn 引擎 / 生成终端脚本，渲染层通过 IPC 取预览字符串。
 */
const { migrateParams } = require('./migrate');
const { expandToolsArg } = require('./agent');

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
  // 先做迁移（settings.json 可能是旧版格式；自动翻译并丢 warning）。
  // 注意：后续一律读迁移后的 `o`，不能读原始 `p` —— 否则旧字段（mmap/mlock/dio）
  // 会被原样下发成已删除的 flag，引擎直接 "error: invalid argument" 退出。
  const migrated = migrateParams(p || {});
  if (p) p._migrations = migrated.migrations;
  const o = migrated.params;
  const a = ['-m', modelPath];

  // --- 附属文件：视觉投影 / 草稿模型 ---
  if (o.mmproj) a.push('-mm', String(o.mmproj));
  if (o.mmprojOffload === false) a.push('--no-mmproj-offload');
  if (o.specDraft) {
    a.push('-md', String(o.specDraft));
    if (o.specDraftNgl !== undefined && o.specDraftNgl !== '' && o.specDraftNgl !== 'auto') {
      a.push('-ngld', o.specDraftNgl === 'all' ? 'all' : fmt(o.specDraftNgl));
    }
  }
  // 内置 MTP 等无需草稿文件的投机解码：单独给 --spec-type 即可
  if (o.specType && o.specType !== 'none') a.push('--spec-type', String(o.specType));
  // 草稿长度上限：仅在显式改过默认值(3)时下发，避免掩盖引擎默认行为
  if (o.specDraftNMax !== undefined && o.specDraftNMax !== '' && Number(o.specDraftNMax) !== 3) {
    a.push('--spec-draft-n-max', fmt(o.specDraftNMax));
  }

  // --- 引擎与内存 ---
  if (o.ngl !== undefined && o.ngl !== '' && o.ngl !== 'auto') {
    a.push('-ngl', o.ngl === 'all' ? 'all' : fmt(o.ngl));
  }
  if (o.cpuMoe) a.push('-cmoe');
  if (o.nCpuMoe > 0) a.push('-ncmoe', fmt(o.nCpuMoe));
  if (o.flashAttn && o.flashAttn !== 'auto') a.push('-fa', o.flashAttn);
  if (o.ctx > 0) a.push('-c', fmt(o.ctx));
  if (o.cacheTypeK && o.cacheTypeK !== 'f16') a.push('-ctk', o.cacheTypeK);
  if (o.cacheTypeV && o.cacheTypeV !== 'f16') a.push('-ctv', o.cacheTypeV);
  if (o.parallel > 1) a.push('-np', fmt(o.parallel));
  if (o.kvOffload === false) a.push('--no-kv-offload');
  if (o.swaFull) a.push('--swa-full');

  // --- 性能 ---
  if (o.threads > 0) a.push('-t', fmt(o.threads));
  if (o.threadsBatch > 0) a.push('-tb', fmt(o.threadsBatch));
  if (o.batch > 0 && o.batch !== 2048) a.push('-b', fmt(o.batch));
  if (o.ubatch > 0 && o.ubatch !== 512) a.push('-ub', fmt(o.ubatch));

  // --- 采样 ---
  a.push('--temp', fmt(o.temp));
  a.push('--top-k', fmt(o.topK));
  a.push('--top-p', fmt(o.topP));
  a.push('--min-p', fmt(o.minP));
  a.push('--repeat-penalty', fmt(o.repeatPenalty));
  a.push('-s', fmt(o.seed));

  // --- 高级 ---
  if (o.ropeScaling && o.ropeScaling !== 'none') {
    a.push('--rope-scaling', o.ropeScaling);
    if (o.yarnOrigCtx > 0) a.push('--yarn-orig-ctx', fmt(o.yarnOrigCtx));
  }
  // 加载模式：mmap / mlock / dio 的**唯一**下发通道。
  // 上游 14a9d09f7（2026-09-09）已删除 --mlock / --mmap / --no-mmap / -dio / -ndio，
  // 只保留 -lm/--load-mode；旧字段由 migrateParams 在这里翻译完成。
  if (o.loadMode && o.loadMode !== 'auto') a.push('--load-mode', o.loadMode);
  if (o.splitMode && o.splitMode !== 'layer') a.push('--split-mode', o.splitMode);
  if (o.tensorSplit) a.push('--tensor-split', String(o.tensorSplit));
  if (o.mainGpu > 0) a.push('--main-gpu', fmt(o.mainGpu));
  if (o.lora) a.push('--lora', String(o.lora));
  if (o.samplers && o.samplers !== 'default') a.push('--samplers', String(o.samplers));
  if (o.mirostat > 0) {
    a.push('--mirostat', fmt(o.mirostat));
    a.push('--mirostat-lr', fmt(o.mirostatLr));
  }
  if (o.ignoreEos) a.push('--ignore-eos');

  // --- server 专属 ---
  if (mode === 'server') {
    a.push('--host', o.host || '127.0.0.1');
    a.push('--port', fmt(o.port || 9931));
    if (o.apiKey) a.push('--api-key', String(o.apiKey));
    if (o.metrics) a.push('--metrics');
    // 会话存盘：把 slot 的提示词缓存 + KV 状态写入磁盘，可秒级恢复
    if (o.slotSavePath) a.push('--slot-save-path', String(o.slotSavePath));
    // 内置工具（agent 模式）：展开成引擎认识的名字。
    // 'read_only' 不是合法取值，直接下发会让 server 启动即失败，必须在这里展开。
    const toolNames = expandToolsArg(o.tools);
    if (toolNames.length) a.push('--tools', toolNames.join(','));
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

module.exports = { buildArgs, argsToString, migrateParams };

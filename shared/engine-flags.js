'use strict';
/**
 * 引擎参数漂移检查（纯函数，供 scripts/check-engine-flags.js 与单测共用）
 *
 * 为什么需要它：
 *   单测只能验证「项目下发了什么」，验证不了「引擎还认不认」。
 *   上游删参数（如 14a9d09f7 删掉 --mlock/--mmap/-dio）或项目写了引擎从来
 *   不认的取值（如 --tools read_only），都会让 llama-server 启动即失败：
 *     error: invalid argument: --mlock
 *     unknown tool "read_only". available tools: ...
 *   这两次事故都是靠人工审计才发现的，所以在这里做成可重复执行的检查。
 *
 * 三个纯函数：
 *   - extractEmittedFlags(source)  从 args.js / bench.js 源码抽出会下发的 flag
 *   - extractSupportedFlags(help)  从引擎 --help 输出抽出它认识的 flag
 *   - diffFlags(emitted, supported) 求差集
 */

/**
 * 从源码里抽出所有会下发的 flag。
 *
 * 覆盖两种写法（args.js / bench.js 里就这两种）：
 *   const a = ['-m', String(modelPath)];   ← 初始化数组里的第一个元素
 *   a.push('-ngl', ...); a.push('--temp', ...);
 *
 * 直接扫源码（而不是靠一份手写清单）是为了**自动跟随代码**：
 * 以后新增参数，检查范围自动覆盖，不会漏。
 * 只认引号包裹的字面量，`a.push(fmt(x))` 这类动态拼接不会被误收，
 * 参数值（如 `-s -1` 里的 `-1`）也不会被当成 flag。
 *
 * @param {string} source
 * @returns {Set<string>}
 */
function extractEmittedFlags(source) {
  const out = new Set();
  const text = String(source || '');
  const patterns = [
    /\.push\(\s*'((?:--?)[a-z][a-z0-9-]*)'/g, // a.push('-ngl', ...)
    /=\s*\[\s*'((?:--?)[a-z][a-z0-9-]*)'/g,   // const a = ['-m', ...]
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) out.add(m[1]);
  }
  return out;
}

/**
 * 从引擎 --help 输出里抽出它声明的 flag。
 *
 * llama.cpp 的帮助格式形如：
 *   -m, --model FNAME                    model path to load
 *   -ngl, --n-gpu-layers N               number of layers to store in VRAM
 *   --spec-draft-n-max N                 ...
 *
 * 取巧但安全的做法：抓「前面是行首/空白/逗号/括号」的 -x / --xxx token。
 * 这样不会把 "well-known" 这类词内连字符误判成 flag；就算混进个别噪声，
 * 方向也是安全的——只有「引擎没声明」的 flag 才会被报出来。
 *
 * @param {string} helpText
 * @returns {Set<string>}
 */
function extractSupportedFlags(helpText) {
  const out = new Set();
  const re = /(?:^|[\s,([|])(--[a-z][a-z0-9-]*|-[a-z][a-z0-9-]*)/gm;
  const text = String(helpText || '');
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return out;
}

/**
 * 去掉 C++ 的 // 与 /* *\/ 注释（尊重字符串字面量，避免把描述里的 URL 截断）。
 *
 * 为什么需要：注释掉的 common_arg 不算"已声明"，否则上游把某个参数暂时注释掉时，
 * 我们这边会误以为它还可用（漏报，正好是最危险的方向）。
 *
 * @param {string} src
 * @returns {string}
 */
function stripCppComments(src) {
  const text = String(src || '');
  let out = '';
  let i = 0;
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      i++;
      continue;
    }
    if (inBlock) {
      if (c === '*' && d === '/') { inBlock = false; i += 2; } else i++;
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') { out += d === undefined ? '' : d; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '/' && d === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && d === '*') { inBlock = true; i += 2; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

/**
 * 从上游 `common/arg.cpp` 源码里抽出它声明了哪些 flag。
 *
 * 这一路不需要编译好的引擎，给 CI 用（CI 里只做浅克隆 + sparse checkout，不构建）。
 *
 * llama.cpp 的声明形如：
 *   add_opt(common_arg(
 *       {"-m", "--model"}, "FNAME",
 *       "model path to load", ...));
 *
 * 也有一个参数挂**多个**花括号列表（正/负两种形式）的：
 *   add_opt(common_arg(
 *       {"-kvo", "--kv-offload"},
 *       {"-nkvo", "--no-kv-offload"},
 *       ...));
 *
 * 所以匹配的是「common_arg( 后面连续若干 {…} 列表（允许逗号分隔）」。
 *
 * 注意：只覆盖 common/arg.cpp。llama-bench 等工具自己的参数在各自 .cpp 里
 * （形如 `arg == "-p"`），不在本函数范围内。
 *
 * @param {string} source
 * @returns {Set<string>}
 */
function extractDeclaredFlagsFromSource(source) {
  const out = new Set();
  const text = stripCppComments(source);
  const blockRe = /common_arg\(((?:\s*\{[^}]*\}\s*,?)+)/g;
  let block;
  while ((block = blockRe.exec(text)) !== null) {
    for (const m of block[1].matchAll(/"((?:--?)[a-z][a-z0-9-]*)"/g)) out.add(m[1]);
  }
  return out;
}

/**
 * 从上游 `common/common.cpp` 抽出 decision（判决/打分）模型类型名。
 *
 * 上游定义在 COMMON_DECISION_TYPE_NAMES 映射里：
 *   static const std::map<common_decision_type, std::string> COMMON_DECISION_TYPE_NAMES = {
 *       { COMMON_DECISION_TYPE_OPENJEV, "openjev" },
 *       ...
 *   };
 *
 * 为什么也要查：main/gguf.js 用这份名单判断「引擎认不认这个 decision 模型」，
 * 名单落后时界面会把引擎明明支持的模型标成「引擎不支持」（vllm-decision2 /
 * vllm-d3 就漏了 4 天没人发现），漏得越多误报越多。
 *
 * @param {string} source common/common.cpp 源码
 * @returns {Set<string>}
 */
function extractDecisionTypes(source) {
  const lines = String(source || '').split('\n');
  const start = lines.findIndex((l) => /COMMON_DECISION_TYPE_NAMES\s*=\s*\{/.test(l));
  if (start < 0) return new Set();

  const out = new Set();
  // 逐行读到映射结束的 `};`，每行只取 // 之前的内容
  // （用逐行而不是整块正则：映射末尾带一句注释，整块解析会把它当成类型名）
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\};/.test(line)) break;
    const code = line.split('//')[0];
    for (const m of code.matchAll(/"([a-z0-9][a-z0-9-]*)"/g)) out.add(m[1]);
  }
  return out;
}

/**
 * 求差集：项目会下发、但引擎没声明的 flag。
 *
 * @param {Set<string>|string[]} emitted
 * @param {Set<string>|string[]} supported
 * @returns {{ok:boolean, missing:string[], checked:number}}
 */
function diffFlags(emitted, supported) {
  const sup = supported instanceof Set ? supported : new Set(supported || []);
  const list = emitted instanceof Set ? [...emitted] : [...(emitted || [])];
  const missing = list.filter((f) => !sup.has(f)).sort();
  return { ok: missing.length === 0, missing, checked: list.length };
}

module.exports = {
  extractEmittedFlags,
  extractSupportedFlags,
  extractDeclaredFlagsFromSource,
  extractDecisionTypes,
  stripCppComments,
  diffFlags,
};

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

module.exports = { extractEmittedFlags, extractSupportedFlags, diffFlags };

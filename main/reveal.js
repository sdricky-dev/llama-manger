'use strict';
/**
 * 「在文件夹中显示 / 打开所在文件夹」的目标解析。
 *
 * 只做纯逻辑（不 require fs / electron），方便单测：
 * 由调用方提供 stat 探测结果，这里只决定该做什么动作。
 *  - action 'select'：文件 → 让文件管理器打开父目录并高亮该文件
 *  - action 'open'  ：目录 → 直接打开该目录
 *  - action 'error' ：路径无效或已不存在（附上父目录便于排查）
 */
const path = require('path');

/** 目标所在目录（绝对路径）。目标本身为空时返回 ''。 */
function containingDir(target) {
  if (!target || typeof target !== 'string' || !target.trim()) return '';
  return path.dirname(path.resolve(target.trim()));
}

/**
 * @param {string} target 目标文件/目录路径
 * @param {{exists:boolean,isDirectory?:boolean}} stat 目标探测结果
 * @returns {{action:'select'|'open'|'error', path?:string, dir?:string, error?:string}}
 */
function revealPlan(target, stat) {
  if (!target || typeof target !== 'string' || !target.trim()) {
    return { action: 'error', error: '没有可打开的路径' };
  }
  const abs = path.resolve(target.trim());
  const dir = path.dirname(abs);
  if (!stat || !stat.exists) {
    return { action: 'error', error: `文件已不存在（可能已被移动或删除）：${abs}`, dir };
  }
  if (stat.isDirectory) return { action: 'open', path: abs, dir: abs };
  return { action: 'select', path: abs, dir };
}

module.exports = { containingDir, revealPlan };

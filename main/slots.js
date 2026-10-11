'use strict';
/**
 * 会话存盘（--slot-save-path）的磁盘侧操作：
 * 列出/删除存盘文件。写入由 llama-server 自己完成（POST /slots/{id}?action=save）。
 *
 * 校验规则与服务端 fs_validate_filename 对齐（禁止路径分隔符与控制/非法字符），
 * 并额外拒绝 . 与 ..，再做一次"解析后必须仍在目录内"的兜底检查。
 */
const fs = require('fs');
const path = require('path');

const ILLEGAL = /[\\/:*?"<>|\uFF0E\u2215\u2216\uFFFD\uFEFF]/;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * 校验文件名（不含路径）。
 * @returns {{ok:boolean, reason?:string}}
 */
function validateName(name) {
  const s = String(name || '');
  if (!s.length) return { ok: false, reason: '文件名不能为空' };
  if (s.length > 255) return { ok: false, reason: '文件名过长（>255）' };
  if (s === '.' || s === '..') return { ok: false, reason: '非法文件名' };
  if (CONTROL.test(s)) return { ok: false, reason: '文件名含控制字符' };
  if (ILLEGAL.test(s)) return { ok: false, reason: '文件名含非法字符（/ \\ : * ? " < > |）' };
  return { ok: true };
}

/**
 * 解析出目录内的绝对路径（越界则抛错）。
 */
function resolveInDir(dir, name) {
  const v = validateName(name);
  if (!v.ok) throw new Error(v.reason);
  const base = path.resolve(String(dir || ''));
  const full = path.resolve(base, name);
  const rel = path.relative(base, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('文件名越出存盘目录');
  }
  return full;
}

/**
 * 列出存盘目录中的文件。
 * @returns {{dir:string, exists:boolean, files:{name,sizeBytes,sizeGB,mtimeMs}[]}}
 */
function list(dir) {
  const base = String(dir || '').trim();
  if (!base) return { dir: '', exists: false, files: [] };
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return { dir: base, exists: false, files: [] };
  }
  const files = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    let st;
    try {
      st = fs.statSync(path.join(base, e.name));
    } catch {
      continue;
    }
    files.push({
      name: e.name,
      sizeBytes: st.size,
      sizeGB: st.size / 1e9,
      mtimeMs: st.mtimeMs,
    });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { dir: base, exists: true, files };
}

/** 删除存盘文件（仅限目录内、合法文件名） */
function remove(dir, name) {
  const full = resolveInDir(dir, name);
  fs.unlinkSync(full);
  return { removed: full };
}

module.exports = { validateName, resolveInDir, list, remove };

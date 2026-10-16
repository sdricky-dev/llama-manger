'use strict';
/**
 * Hugging Face 模型下载（仿 llamafile 的 -hf REPO[:TAG]）
 *
 * llama.cpp 的 -hf REPO[:TAG] 会调 hf CLI 拉模型 + 落到 HF cache (~/.cache/huggingface/)。
 * 我们这里不依赖 hf CLI / Python，纯 HTTP：
 *   1. GET https://huggingface.co/api/models/{repo_id} → 列出文件
 *   2. 过滤 .gguf（可选 mmproj / draft）
 *   3. 流式下载 https://huggingface.co/{repo_id}/resolve/{ref}/{filename}
 *
 * 这个文件只放**纯函数**：
 *   - parseHfSpec('Qwen/Qwen3-1.7B-GGUF:Q4_K_M') → { repo, ref, filter }
 *   - filterGgufFiles(files, opts) → 只剩 GGUF（按 tag / 关键词过滤）
 *   - pickPrimaryAndCompanions(files) → 找主模型 + mmproj + draft
 *   - buildHfDownloadUrl(repo, ref, filename) → 完整 URL
 */

const HF_BASE = 'https://huggingface.co';

/**
 * 解析 HF 规格字符串
 *
 * 支持的写法（与 llama.cpp -hf 一致）：
 *   "Qwen/Qwen3-1.7B-GGUF"           → ref=main
 *   "Qwen/Qwen3-1.7B-GGUF:Q4_K_M"    → ref=main, filter='Q4_K_M'
 *   "Qwen/Qwen3-1.7B-GGUF@q4_k_m"    → 同上
 *   "Qwen/Qwen3-1.7B-GGUF:main"      → ref=main
 *   "Qwen/Qwen3-1.7B-GGUF:v0.1"      → ref=v0.1
 *
 * @param {string} spec
 * @returns {{repo:string, ref:string, filter:string|null}}
 */
function parseHfSpec(spec) {
  if (typeof spec !== 'string') throw new Error('parseHfSpec: 输入必须是字符串');
  const s = spec.trim();
  if (!s) throw new Error('parseHfSpec: 输入为空');
  // 拆分 [repo][:|@][ref|filter]
  let sep = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ':' || s[i] === '@') { sep = i; break; }
  }
  if (sep < 0) return { repo: s, ref: 'main', filter: null };
  const repo = s.slice(0, sep);
  const tail = s.slice(sep + 1);
  if (!repo) throw new Error(`parseHfSpec: 缺少 repo：${spec}`);
  if (!tail) return { repo, ref: 'main', filter: null };
  // 形如 vX.Y.Z / v0.1 / main → ref；其他看作 quant filter
  if (/^v?\d/.test(tail) || tail === 'main' || tail === 'master') {
    return { repo, ref: tail, filter: null };
  }
  return { repo, ref: 'main', filter: tail };
}

/**
 * 把 HF repo 拆成 owner/name
 */
function parseHfRepo(repo) {
  const parts = String(repo || '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`非法 HF repo：${repo}（应为 owner/name）`);
  }
  return { owner: parts[0], name: parts[1] };
}

/**
 * 构造下载 URL
 *
 * llama.cpp 用 main 作为默认 ref；我们也用 main
 *
 * @param {string} repo
 * @param {string} ref  通常 'main' / 'v0.1' 等
 * @param {string} filename
 * @returns {string}
 */
function buildHfDownloadUrl(repo, ref, filename) {
  const r = parseHfRepo(repo);
  return `${HF_BASE}/${r.owner}/${r.name}/resolve/${ref}/${filename}`;
}

/** HF API 列出文件时的元数据 */
function normalizeHfFile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = String(raw.rfilename || raw.path || '').replace(/^\/+/, '');
  if (!r) return null;
  return {
    path: r,
    size: Number.isFinite(raw.size) ? raw.size : 0,
    oid: raw.oid || null,
  };
}

/**
 * 过滤出 GGUF 文件
 *
 * @param {Array<{path:string,size:number}>} files
 * @param {object} opts { filter?: string, includeMmproj?: bool, includeDraft?: bool }
 * @returns {Array}
 */
function filterGgufFiles(files, opts = {}) {
  const list = Array.isArray(files) ? files : [];
  const filter = opts.filter ? String(opts.filter).toLowerCase() : null;
  const includeMmproj = opts.includeMmproj !== false; // 默认 true
  const includeDraft = opts.includeDraft !== false;

  const out = [];
  for (const f of list) {
    const path = String(f.path || '').toLowerCase();
    if (!path.endsWith('.gguf')) continue;
    if (!includeMmproj && /mmproj/.test(path)) continue;
    if (!includeDraft && /(draft|mtp|dflash|eagle3)/.test(path)) continue;
    if (filter) {
      // quant filter（Q4_K_M / q5 / bf16 ...）：按文件名片段匹配（大小写不敏感）
      if (!path.includes(filter.toLowerCase())) continue;
    }
    out.push(f);
  }
  return out;
}

/**
 * 在文件列表里挑"主模型" + "附属"（mmproj / draft）
 *
 * 启发式（与 llama.cpp / 用户直觉一致）：
 *   - 主模型：不含 mmproj / draft / mtp / dflash / eagle3 关键词的最大文件
 *   - mmproj：文件名含 mmproj
 *   - draft / mtp：文件名含 draft / mtp / dflash / eagle3
 *
 * @param {Array} files
 * @returns {{primary:object|null, mmproj:object|null, draft:object|null, others:object[]}}
 */
function pickPrimaryAndCompanions(files) {
  const list = Array.isArray(files) ? files : [];
  let primary = null;
  let mmproj = null;
  let draft = null;
  const others = [];
  for (const f of list) {
    const p = String(f.path || '').toLowerCase();
    if (p.includes('mmproj')) {
      if (!mmproj) mmproj = f;
      continue;
    }
    if (/(^|[^a-z])(draft|mtp|dflash|eagle3|eagle)([^a-z]|$)/.test(p)) {
      if (!draft) draft = f;
      continue;
    }
    // 主模型：取最大的（GGUF 模型里最大的就是主模型）
    if (!primary || (f.size || 0) > (primary.size || 0)) {
      if (primary) others.push(primary);
      primary = f;
    } else {
      others.push(f);
    }
  }
  return { primary, mmproj, draft, others };
}

/** 校验 filename 没有路径穿越 */
function validateFilename(filename) {
  const s = String(filename || '');
  if (!s) return { ok: false, reason: '文件名为空' };
  if (s.length > 255) return { ok: false, reason: '文件名过长' };
  if (s === '.' || s === '..') return { ok: false, reason: '非法文件名' };
  if (/[\\/]/.test(s)) return { ok: false, reason: '文件名含路径分隔符' };
  if (/[\u0000-\u001F\u007F-\u009F]/.test(s)) return { ok: false, reason: '含控制字符' };
  return { ok: true };
}

/** 校验 spec 大致合法（粗略） */
function validateSpec(spec) {
  try {
    const r = parseHfSpec(spec);
    parseHfRepo(r.repo);
    return { ok: true, parsed: r };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** 把字节数格式化为 "12.3 MB" / "1.5 GB" */
function fmtSize(b) {
  const n = Number(b);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

module.exports = {
  HF_BASE,
  parseHfSpec,
  parseHfRepo,
  buildHfDownloadUrl,
  normalizeHfFile,
  filterGgufFiles,
  pickPrimaryAndCompanions,
  validateFilename,
  validateSpec,
  fmtSize,
};
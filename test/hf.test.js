'use strict';
/**
 * HF 模型下载（main/hf.js）单元测试
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('../main/hf');

/* ---------- parseHfSpec ---------- */

test('parseHfSpec：纯 repo', () => {
  const r = parseHfSpec('Qwen/Qwen3-1.7B-GGUF');
  assert.equal(r.repo, 'Qwen/Qwen3-1.7B-GGUF');
  assert.equal(r.ref, 'main');
  assert.equal(r.filter, null);
});

test('parseHfSpec：冒号 quant filter', () => {
  const r = parseHfSpec('Qwen/Qwen3-1.7B-GGUF:Q4_K_M');
  assert.equal(r.repo, 'Qwen/Qwen3-1.7B-GGUF');
  assert.equal(r.ref, 'main');
  assert.equal(r.filter, 'Q4_K_M');
});

test('parseHfSpec：@ quant filter 等价', () => {
  const r = parseHfSpec('Qwen/Qwen3-1.7B-GGUF@q4_k_m');
  assert.equal(r.filter, 'q4_k_m');
});

test('parseHfSpec：冒号 ref (v0.1)', () => {
  const r = parseHfSpec('Qwen/Qwen3-1.7B-GGUF:v0.1');
  assert.equal(r.ref, 'v0.1');
  assert.equal(r.filter, null);
});

test('parseHfSpec：ref=main / master 显式', () => {
  assert.equal(parseHfSpec('foo/bar:main').ref, 'main');
  assert.equal(parseHfSpec('foo/bar:master').ref, 'master');
});

test('parseHfSpec：前后空白', () => {
  assert.equal(parseHfSpec('  foo/bar  ').repo, 'foo/bar');
});

test('parseHfSpec：空 / 非字符串', () => {
  assert.throws(() => parseHfSpec(''), /为空/);
  assert.throws(() => parseHfSpec(null), /字符串/);
});

test('parseHfSpec：缺 repo', () => {
  assert.throws(() => parseHfSpec(':Q4_K_M'), /缺少 repo/);
});

/* ---------- parseHfRepo ---------- */

test('parseHfRepo：合法', () => {
  assert.deepEqual(parseHfRepo('Qwen/Qwen3-1.7B-GGUF'), { owner: 'Qwen', name: 'Qwen3-1.7B-GGUF' });
});

test('parseHfRepo：缺斜杠', () => {
  assert.throws(() => parseHfRepo('Qwen'), /非法/);
  assert.throws(() => parseHfRepo('a/b/c'), /非法/);
  assert.throws(() => parseHfRepo(''), /非法/);
});

/* ---------- buildHfDownloadUrl ---------- */

test('buildHfDownloadUrl：标准 URL', () => {
  const u = buildHfDownloadUrl('Qwen/Qwen3-1.7B-GGUF', 'main', 'qwen3-1.7b-q4_k_m.gguf');
  assert.equal(u, `${HF_BASE}/Qwen/Qwen3-1.7B-GGUF/resolve/main/qwen3-1.7b-q4_k_m.gguf`);
});

test('buildHfDownloadUrl：tag 形式', () => {
  const u = buildHfDownloadUrl('a/b', 'v0.1', 'x.gguf');
  assert.match(u, /\/resolve\/v0\.1\/x\.gguf$/);
});

test('buildHfDownloadUrl：非法 repo 抛错', () => {
  assert.throws(() => buildHfDownloadUrl('bad', 'main', 'x.gguf'), /非法/);
});

/* ---------- normalizeHfFile ---------- */

test('normalizeHfFile：从 HF API siblings 结构提取', () => {
  const f = normalizeHfFile({ rfilename: 'a/b/Q4_K_M.gguf', size: 12345, oid: 'abc' });
  assert.equal(f.path, 'a/b/Q4_K_M.gguf');
  assert.equal(f.size, 12345);
  assert.equal(f.oid, 'abc');
});

test('normalizeHfFile：从 path 字段提取', () => {
  const f = normalizeHfFile({ path: '/foo.gguf' });
  assert.equal(f.path, 'foo.gguf');
});

test('normalizeHfFile：非法输入', () => {
  assert.equal(normalizeHfFile(null), null);
  assert.equal(normalizeHfFile({}), null);
  assert.equal(normalizeHfFile({ size: 100 }), null);
});

test('normalizeHfFile：缺 size 当 0', () => {
  const f = normalizeHfFile({ rfilename: 'a.gguf' });
  assert.equal(f.size, 0);
});

/* ---------- filterGgufFiles ---------- */

test('filterGgufFiles：只留 .gguf', () => {
  const out = filterGgufFiles([
    { path: 'a.gguf', size: 1 },
    { path: 'b.txt', size: 1 },
    { path: 'c.gguf', size: 2 },
    { path: 'd.safetensors', size: 3 },
  ]);
  assert.equal(out.length, 2);
});

test('filterGgufFiles：quant filter 大小写不敏感', () => {
  const out = filterGgufFiles([
    { path: 'a-Q4_K_M.gguf', size: 1 },
    { path: 'b-q5_k_m.gguf', size: 1 },
  ], { filter: 'Q4_K_M' });
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'a-Q4_K_M.gguf');
});

test('filterGgufFiles：默认含 mmproj', () => {
  const out = filterGgufFiles([
    { path: 'm.gguf', size: 1 },
    { path: 'm.mmproj.gguf', size: 1 },
  ]);
  assert.equal(out.length, 2);
});

test('filterGgufFiles：includeMmproj=false 排除 mmproj', () => {
  const out = filterGgufFiles([
    { path: 'm.gguf', size: 1 },
    { path: 'm.mmproj.gguf', size: 1 },
  ], { includeMmproj: false });
  assert.equal(out.length, 1);
});

test('filterGgufFiles：draft / mtp / dflash / eagle3 关键词', () => {
  const out = filterGgufFiles([
    { path: 'main.gguf', size: 1 },
    { path: 'dflash-blah.gguf', size: 1 },
    { path: 'mtp-x.gguf', size: 1 },
    { path: 'eagle3.gguf', size: 1 },
  ], { includeDraft: false });
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'main.gguf');
});

test('filterGgufFiles：空数组', () => {
  assert.deepEqual(filterGgufFiles([]), []);
  assert.deepEqual(filterGgufFiles(null), []);
});

/* ---------- pickPrimaryAndCompanions ---------- */

test('pickPrimaryAndCompanions：典型三件套', () => {
  const out = pickPrimaryAndCompanions([
    { path: 'model.Q4_K_M.gguf', size: 4_000_000_000 },
    { path: 'model.mmproj-v1.5.gguf', size: 600_000_000 },
    { path: 'model.draft.gguf', size: 1_000_000_000 },
  ]);
  assert.match(out.primary.path, /model\.Q4_K_M\.gguf/);
  assert.match(out.mmproj.path, /mmproj/);
  assert.match(out.draft.path, /draft/);
  assert.equal(out.others.length, 0);
});

test('pickPrimaryAndCompanions：主模型取最大', () => {
  const out = pickPrimaryAndCompanions([
    { path: 'small.gguf', size: 100 },
    { path: 'large.gguf', size: 4_000_000_000 },
    { path: 'medium.gguf', size: 1_000_000_000 },
  ]);
  assert.equal(out.primary.path, 'large.gguf');
  assert.equal(out.others.length, 2);
});

test('pickPrimaryAndCompanions：没有 mmproj / draft', () => {
  const out = pickPrimaryAndCompanions([
    { path: 'a.gguf', size: 1 },
  ]);
  assert.equal(out.mmproj, null);
  assert.equal(out.draft, null);
  assert.equal(out.others.length, 0);
});

test('pickPrimaryAndCompanions：空数组', () => {
  const out = pickPrimaryAndCompanions([]);
  assert.equal(out.primary, null);
  assert.equal(out.mmproj, null);
  assert.equal(out.draft, null);
});

test('pickPrimaryAndCompanions：draft 关键词大小写', () => {
  const out = pickPrimaryAndCompanions([
    { path: 'main.gguf', size: 4_000_000_000 },
    { path: 'main.DRAFT.gguf', size: 100 },
    { path: 'main.MTP.gguf', size: 100 },
  ]);
  assert.equal(out.primary.path, 'main.gguf');
  assert.match(out.draft.path, /DRAFT\.gguf|main\.DRAFT\.gguf/);
});

/* ---------- validateFilename ---------- */

test('validateFilename：合法', () => {
  assert.equal(validateFilename('a.gguf').ok, true);
  assert.equal(validateFilename('中文.gguf').ok, true);
  assert.equal(validateFilename('a.b.c.gguf').ok, true);
});

test('validateFilename：路径分隔符拒绝', () => {
  assert.equal(validateFilename('a/b').ok, false);
  assert.equal(validateFilename('a\\b').ok, false);
});

test('validateFilename：. 与 .. 拒绝', () => {
  assert.equal(validateFilename('.').ok, false);
  assert.equal(validateFilename('..').ok, false);
});

test('validateFilename：长度 / 控制字符', () => {
  assert.equal(validateFilename('').ok, false);
  assert.equal(validateFilename('a'.repeat(256)).ok, false);
  assert.equal(validateFilename('a\nb').ok, false);
});

/* ---------- validateSpec ---------- */

test('validateSpec：合法', () => {
  const r = validateSpec('Qwen/Qwen3-1.7B-GGUF:Q4_K_M');
  assert.equal(r.ok, true);
  assert.equal(r.parsed.repo, 'Qwen/Qwen3-1.7B-GGUF');
  assert.equal(r.parsed.filter, 'Q4_K_M');
});

test('validateSpec：非法 repo', () => {
  const r = validateSpec('bad');
  assert.equal(r.ok, false);
  assert.match(r.reason, /非法|缺少/);
});

test('validateSpec：空字符串', () => {
  const r = validateSpec('');
  assert.equal(r.ok, false);
});

/* ---------- fmtSize ---------- */

test('fmtSize：格式化', () => {
  assert.equal(fmtSize(500), '500 B');
  assert.equal(fmtSize(2048), '2.0 KB');
  assert.match(fmtSize(5 * 1024 * 1024), /5\.0 MB/);
  assert.match(fmtSize(1.5 * 1024 * 1024 * 1024), /1\.50 GB/);
});

test('fmtSize：非法值', () => {
  assert.equal(fmtSize(0), '—');
  assert.equal(fmtSize(-1), '—');
  assert.equal(fmtSize(NaN), '—');
});
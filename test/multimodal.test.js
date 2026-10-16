'use strict';
/**
 * 多模态图片（shared/multimodal.js）单元测试
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  SUPPORTED_IMAGE_MIMES,
  detectMimeByExt,
  isSupportedImageMime,
  toDataUri,
  fileToDataUri,
  toMultimodalContent,
  toMultimodalMessage,
  dataUriSize,
} = require('../shared/multimodal');

/* ---------- detectMimeByExt ---------- */

test('detectMimeByExt：常见图片格式', () => {
  assert.equal(detectMimeByExt('/a/foo.PNG'), 'image/png');
  assert.equal(detectMimeByExt('/a/foo.jpg'), 'image/jpeg');
  assert.equal(detectMimeByExt('/a/foo.JPEG'), 'image/jpeg');
  assert.equal(detectMimeByExt('/a/foo.gif'), 'image/gif');
  assert.equal(detectMimeByExt('/a/foo.webp'), 'image/webp');
  assert.equal(detectMimeByExt('/a/foo.bmp'), 'image/bmp');
});

test('detectMimeByExt：未知扩展返回 null', () => {
  assert.equal(detectMimeByExt('/a/foo.txt'), null);
  assert.equal(detectMimeByExt('/a/foo'), null);
});

/* ---------- isSupportedImageMime ---------- */

test('isSupportedImageMime：llama.cpp 支持的格式', () => {
  for (const m of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']) {
    assert.equal(isSupportedImageMime(m), true, `${m} 应该支持`);
  }
});

test('isSupportedImageMime：大小写不敏感', () => {
  assert.equal(isSupportedImageMime('IMAGE/PNG'), true);
});

test('isSupportedImageMime：不支持的格式', () => {
  assert.equal(isSupportedImageMime('image/tiff'), false);
  assert.equal(isSupportedImageMime('application/pdf'), false);
  assert.equal(isSupportedImageMime(null), false);
});

/* ---------- toDataUri ---------- */

test('toDataUri：基本 base64 拼接', () => {
  const buf = Buffer.from('abc');
  const u = toDataUri('image/png', buf);
  assert.match(u, /^data:image\/png;base64,YWJj$/);
});

test('toDataUri：非 Buffer 抛错', () => {
  assert.throws(() => toDataUri('image/png', 'not a buffer'), /Buffer/);
});

test('toDataUri：空 mime 抛错', () => {
  assert.throws(() => toDataUri('', Buffer.from('x')), /mime/);
});

/* ---------- fileToDataUri ---------- */

test('fileToDataUri：写一个临时 png，读回来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmanger-mm-'));
  const p = path.join(dir, 'a.png');
  // PNG magic bytes + 一字节
  fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
  const r = fileToDataUri(p);
  assert.equal(r.ok, true);
  assert.equal(r.mime, 'image/png');
  assert.match(r.dataUri, /^data:image\/png;base64,/);
  assert.equal(r.sizeBytes, 9);
  fs.rmSync(dir, { recursive: true });
});

test('fileToDataUri：未知扩展 → ok:false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmanger-mm-'));
  const p = path.join(dir, 'a.txt');
  fs.writeFileSync(p, 'hello');
  const r = fileToDataUri(p);
  assert.equal(r.ok, false);
  assert.match(r.error, /无法识别|不支持/);
  fs.rmSync(dir, { recursive: true });
});

test('fileToDataUri：不存在的文件', () => {
  const r = fileToDataUri('/nonexistent/foo.png');
  assert.equal(r.ok, false);
  assert.match(r.error, /读取失败/);
});

test('fileToDataUri：空路径', () => {
  assert.equal(fileToDataUri('').ok, false);
  assert.equal(fileToDataUri(null).ok, false);
});

/* ---------- toMultimodalContent ---------- */

test('toMultimodalContent：无图时返回纯字符串', () => {
  assert.equal(toMultimodalContent('hi', []), 'hi');
  assert.equal(toMultimodalContent('hi', null), 'hi');
  assert.equal(toMultimodalContent('hi', undefined), 'hi');
  assert.equal(toMultimodalContent('hi', ['', null]), 'hi');
});

test('toMultimodalContent：单图 → 数组（text + image_url）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmanger-mm-'));
  const p = path.join(dir, 'a.png');
  fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
  const out = toMultimodalContent('描述', [p]);
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'text');
  assert.equal(out[0].text, '描述');
  assert.equal(out[1].type, 'image_url');
  assert.match(out[1].image_url.url, /^data:image\/png;base64,/);
  fs.rmSync(dir, { recursive: true });
});

test('toMultimodalContent：多图按顺序拼接', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmanger-mm-'));
  const p1 = path.join(dir, 'a.png');
  const p2 = path.join(dir, 'b.jpg');
  fs.writeFileSync(p1, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
  fs.writeFileSync(p2, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  const out = toMultimodalContent('比较', [p1, p2]);
  assert.equal(out.length, 3);
  assert.equal(out[1].type, 'image_url');
  assert.match(out[1].image_url.url, /^data:image\/png/);
  assert.equal(out[2].type, 'image_url');
  assert.match(out[2].image_url.url, /^data:image\/jpeg/);
  fs.rmSync(dir, { recursive: true });
});

test('toMultimodalContent：失败的图替换为说明文字', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmanger-mm-'));
  const ok = path.join(dir, 'a.png');
  const bad = path.join(dir, 'b.xyz');
  fs.writeFileSync(ok, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
  const out = toMultimodalContent('看', [bad, ok]);
  assert.equal(out[1].type, 'text');
  assert.match(out[1].text, /图片加载失败/);
  assert.equal(out[2].type, 'image_url');
  fs.rmSync(dir, { recursive: true });
});

test('toMultimodalContent：空文本但有图 → 仍输出 array（不带 text 段）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmanger-mm-'));
  const p = path.join(dir, 'a.png');
  fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
  const out = toMultimodalContent('', [p]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'image_url');
  fs.rmSync(dir, { recursive: true });
});

/* ---------- toMultimodalMessage ---------- */

test('toMultimodalMessage：role + content 组合', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmanger-mm-'));
  const p = path.join(dir, 'a.png');
  fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
  const m = toMultimodalMessage('x', [p]);
  assert.equal(m.role, 'user');
  assert.ok(Array.isArray(m.content));
  fs.rmSync(dir, { recursive: true });
});

test('toMultimodalMessage：无图 → 纯字符串 content', () => {
  const m = toMultimodalMessage('hi', []);
  assert.equal(m.role, 'user');
  assert.equal(m.content, 'hi');
});

/* ---------- dataUriSize ---------- */

test('dataUriSize：估算 base64 体积', () => {
  // 'YWJj' = 'abc' = 3 bytes
  assert.equal(dataUriSize('data:text/plain;base64,YWJj'), 3);
});

test('dataUriSize：空 / 非字符串', () => {
  assert.equal(dataUriSize(''), 0);
  assert.equal(dataUriSize(null), 0);
});

test('dataUriSize：无 base64 后缀按原长算', () => {
  const s = 'data:text/plain,hello';
  assert.equal(dataUriSize(s), s.length);
});
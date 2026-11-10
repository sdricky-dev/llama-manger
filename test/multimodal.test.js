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

/* ================= Wave 3：音频 / 视频输入 ================= */
/* 上游契约（tools/server/server-common.cpp oaicompat_content_load_media）：
 *   { type:'input_audio', input_audio:{ data | url } }   // data 优先，format 被忽略
 *   { type:'input_video', input_video:{ data | url } }   // 同上，也接受 video_url 别名
 *   url/data 可为远程 URL、base64（裸或 data:URI）、或 file:// 相对路径（需 --media-path）
 */

const {
  SUPPORTED_AUDIO_MIMES,
  SUPPORTED_VIDEO_MIMES,
  detectMediaKindByExt,
  isSupportedAudioMime,
  isSupportedVideoMime,
  fileToMediaUri,
  fileToMediaRef,
  toImagePart,
  toAudioPart,
  toVideoPart,
} = require('../shared/multimodal');

test('detectMediaKindByExt：按扩展名分派 image/audio/video', () => {
  assert.equal(detectMediaKindByExt('/a/x.PNG'), 'image');
  assert.equal(detectMediaKindByExt('/a/x.mp3'), 'audio');
  assert.equal(detectMediaKindByExt('/a/x.WAV'), 'audio');
  assert.equal(detectMediaKindByExt('/a/x.flac'), 'audio');
  assert.equal(detectMediaKindByExt('/a/x.mp4'), 'video');
  assert.equal(detectMediaKindByExt('/a/x.mov'), 'video');
  assert.equal(detectMediaKindByExt('/a/x.mkv'), 'video');
  assert.equal(detectMediaKindByExt('/a/x.webm'), 'video');
  assert.equal(detectMediaKindByExt('/a/x.txt'), null);
});

test('isSupportedAudioMime / isSupportedVideoMime：miniaudio 与 ffmpeg 口径', () => {
  assert.equal(isSupportedAudioMime('audio/mpeg'), true);
  assert.equal(isSupportedAudioMime('audio/wav'), true);
  assert.equal(isSupportedAudioMime('audio/flac'), true);
  assert.equal(isSupportedAudioMime('AUDIO/MP3'), true);
  assert.equal(isSupportedAudioMime('audio/ogg'), false); // miniaudio 不收
  assert.equal(isSupportedAudioMime(null), false);
  assert.equal(isSupportedVideoMime('video/mp4'), true);
  assert.equal(isSupportedVideoMime('video/quicktime'), true);
  assert.equal(isSupportedVideoMime('video/x-matroska'), true);
  assert.equal(isSupportedVideoMime('application/octet-stream'), false);
  assert.ok(SUPPORTED_AUDIO_MIMES.has('audio/flac'));
  assert.ok(SUPPORTED_VIDEO_MIMES.has('video/mp4'));
});

test('fileToMediaUri：wav / mp4 读成对应 MIME 的 data URI', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmanger-mm-'));
  const wav = path.join(dir, 'a.wav');
  const mp4 = path.join(dir, 'b.mp4');
  fs.writeFileSync(wav, Buffer.from([0x52, 0x49, 0x46, 0x46]));
  fs.writeFileSync(mp4, Buffer.from([0x00, 0x00, 0x00, 0x20]));
  const r1 = fileToMediaUri(wav);
  assert.equal(r1.ok, true);
  assert.equal(r1.kind, 'audio');
  assert.equal(r1.mime, 'audio/wav');
  assert.match(r1.dataUri, /^data:audio\/wav;base64,/);
  const r2 = fileToMediaUri(mp4);
  assert.equal(r2.kind, 'video');
  assert.match(r2.dataUri, /^data:video\/mp4;base64,/);
  fs.rmSync(dir, { recursive: true });
});

test('fileToMediaUri：图片仍归为 image / 不支持的扩展报错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmanger-mm-'));
  const png = path.join(dir, 'a.png');
  const txt = path.join(dir, 'a.txt');
  fs.writeFileSync(png, Buffer.from([0x89, 0x50]));
  fs.writeFileSync(txt, 'hi');
  assert.equal(fileToMediaUri(png).kind, 'image');
  const bad = fileToMediaUri(txt);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /无法识别|不支持/);
  fs.rmSync(dir, { recursive: true });
});

test('toImagePart / toAudioPart / toVideoPart：data URI 走 data，其余走 url', () => {
  assert.deepEqual(toImagePart('data:image/png;base64,AA=='), {
    type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' },
  });
  assert.deepEqual(toAudioPart('data:audio/wav;base64,AA=='), {
    type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,AA==' },
  });
  assert.deepEqual(toAudioPart('file://a/b.wav'), {
    type: 'input_audio', input_audio: { url: 'file://a/b.wav' },
  });
  assert.deepEqual(toVideoPart('data:video/mp4;base64,AA=='), {
    type: 'input_video', input_video: { data: 'data:video/mp4;base64,AA==' },
  });
  assert.deepEqual(toVideoPart('https://x/y.mp4'), {
    type: 'input_video', input_video: { url: 'https://x/y.mp4' },
  });
});

test('fileToMediaRef：根目录内 → file:// 相对路径，目录末尾分隔符可省', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmanger-media-'));
  const file = path.join(root, 'sub', 'a.wav');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(file, Buffer.from([0x52, 0x49]));
  const expected = 'file://' + path.join('sub', 'a.wav');
  assert.equal(fileToMediaRef(file, root).ref, expected);
  assert.equal(fileToMediaRef(file, root + path.sep).ref, expected);
  assert.equal(fileToMediaRef(file, root).kind, 'audio');
  fs.rmSync(root, { recursive: true });
});

test('fileToMediaRef：越界 / 不存在的文件 → ok:false', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmanger-media-'));
  fs.writeFileSync(path.join(root, 'a.png'), Buffer.from([0x89]));
  assert.equal(fileToMediaRef('/etc/passwd', root).ok, false);
  assert.equal(fileToMediaRef(path.join(root, 'nope.png'), root).ok, false);
  assert.equal(fileToMediaRef(path.join(root, 'a.png'), '').ok, false);
  fs.rmSync(root, { recursive: true });
});

test('toMultimodalContent：对象形式按 text→图→音→视频 排列', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmanger-mm-'));
  const png = path.join(dir, 'a.png');
  const wav = path.join(dir, 'b.wav');
  const mp4 = path.join(dir, 'c.mp4');
  fs.writeFileSync(png, Buffer.from([0x89]));
  fs.writeFileSync(wav, Buffer.from([0x52, 0x49, 0x46, 0x46]));
  fs.writeFileSync(mp4, Buffer.from([0x00]));
  const out = toMultimodalContent('看', { images: [png], audios: [wav], videos: [mp4] });
  assert.equal(out[0].type, 'text');
  assert.equal(out[1].type, 'image_url');
  assert.equal(out[2].type, 'input_audio');
  assert.match(out[2].input_audio.data, /^data:audio\/wav;base64,/);
  assert.equal(out[3].type, 'input_video');
  assert.match(out[3].input_video.data, /^data:video\/mp4;base64,/);
  fs.rmSync(dir, { recursive: true });
});

test('toMultimodalContent：给了 mediaRoot 时改用 file:// 引用，不内联 base64', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmanger-media-'));
  const wav = path.join(root, 'a.wav');
  fs.writeFileSync(wav, Buffer.from([0x52, 0x49, 0x46, 0x46]));
  const out = toMultimodalContent('转写', { audios: [wav], mediaRoot: root });
  assert.equal(out.length, 2);
  assert.equal(out[1].type, 'input_audio');
  assert.equal(out[1].input_audio.url, 'file://a.wav');
  assert.equal(out[1].input_audio.data, undefined);
  fs.rmSync(root, { recursive: true });
});

test('toMultimodalContent：音视频加载失败不致命，替换为说明文字', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmanger-mm-'));
  const bad = path.join(dir, 'x.ogg');
  const ok = path.join(dir, 'y.wav');
  fs.writeFileSync(ok, Buffer.from([0x52, 0x49]));
  const out = toMultimodalContent('听', { audios: [bad, ok] });
  assert.equal(out[1].type, 'text');
  assert.match(out[1].text, /加载失败/);
  assert.equal(out[2].type, 'input_audio');
  fs.rmSync(dir, { recursive: true });
});

test('toMultimodalMessage：音频消息 role/content 形状', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmanger-mm-'));
  const mp3 = path.join(dir, 'a.mp3');
  fs.writeFileSync(mp3, Buffer.from([0x49, 0x44, 0x33]));
  const m = toMultimodalMessage('说了什么', { audios: [mp3] });
  assert.equal(m.role, 'user');
  assert.equal(m.content[1].type, 'input_audio');
  assert.equal(isSupportedAudioMime(m.content[1].input_audio.data.slice(5, m.content[1].input_audio.data.indexOf(';'))), true);
  fs.rmSync(dir, { recursive: true });
});
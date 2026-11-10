'use strict';
/**
 * 多模态输入（仿 llamafile chatbot_file.cpp + chatbot_api.cpp + 上游 server-common.cpp）
 *
 * llama-server 接受 OpenAI 风格的 multimodal content：
 *   { role: 'user', content: [
 *       { type: 'text', text: '描述这张图' },
 *       { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
 *       { type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,...' } },  // mp3/wav/flac
 *       { type: 'input_video', input_video: { url: 'file://clip.mp4' } },             // ffmpeg 支持的容器
 *   ]}
 * 上游读 data ?? url：内联 base64 用 data，远程 URL / file:// 本地引用用 url。
 * file:// 路径相对引擎的 --media-path 目录（见 shared/args.js 的 mediaPath）。
 *
 * 这个文件只放**纯函数**：
 *   - toDataUri(mime, buf)              → "data:image/png;base64,xxxx"
 *   - fileToDataUri / fileToMediaUri    → 单文件编码（图片 / 图音视）
 *   - fileToMediaRef(path, root)        → "file://相对路径"（不内联，适合大文件）
 *   - toImagePart / toAudioPart / toVideoPart → 单个 content part
 *   - toMultimodalContent(text, media)  → content 数组或纯字符串
 *   - toMultimodalMessage(text, media)  → OpenAI 风格 user message
 *   - detectMimeByExt / detectMediaKindByExt / isSupported*Mime
 *   - dataUriSize(dataUri)              → 估算传输体积
 */

const fs = require('fs');
const path = require('path');

/** llama.cpp 支持的图片 MIME（与 mtmd-helper.cpp 一致） */
const SUPPORTED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/bmp',
]);

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** llama.cpp 支持的音频 MIME（miniaudio 解码：mp3 / wav / flac） */
const SUPPORTED_AUDIO_MIMES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
]);

/** llama.cpp 支持的视频 MIME（交给 ffmpeg 解码，这里按扩展名收窄到常见容器） */
const SUPPORTED_VIDEO_MIMES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/webm',
  'video/x-msvideo',
]);

const AUDIO_MIME_BY_EXT = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
};

const VIDEO_MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
};

const MEDIA_TABLES = {
  image: MIME_BY_EXT,
  audio: AUDIO_MIME_BY_EXT,
  video: VIDEO_MIME_BY_EXT,
};

function extOf(filePath) {
  return path.extname(filePath || '').toLowerCase();
}

function detectMimeByExt(filePath) {
  return MIME_BY_EXT[extOf(filePath)] || null;
}

/** 按扩展名判定媒体类型；未知返回 null */
function detectMediaKindByExt(filePath) {
  const ext = extOf(filePath);
  if (MIME_BY_EXT[ext]) return 'image';
  if (AUDIO_MIME_BY_EXT[ext]) return 'audio';
  if (VIDEO_MIME_BY_EXT[ext]) return 'video';
  return null;
}

function isSupportedImageMime(mime) {
  if (!mime) return false;
  return SUPPORTED_IMAGE_MIMES.has(mime.toLowerCase());
}

function isSupportedAudioMime(mime) {
  if (!mime) return false;
  return SUPPORTED_AUDIO_MIMES.has(mime.toLowerCase());
}

function isSupportedVideoMime(mime) {
  if (!mime) return false;
  return SUPPORTED_VIDEO_MIMES.has(mime.toLowerCase());
}

/**
 * 把 Buffer 编码成 data URI
 *
 * @param {string} mime  e.g. 'image/png'
 * @param {Buffer} buf
 * @returns {string}  'data:image/png;base64,xxxxx'
 */
function toDataUri(mime, buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('toDataUri: 第二个参数必须是 Buffer');
  if (!mime || typeof mime !== 'string') throw new Error('toDataUri: 第一个参数必须是 mime 字符串');
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * 把文件读成 data URI
 *
 * @param {string} filePath 绝对路径
 * @returns {{ok:boolean, mime?:string, dataUri?:string, sizeBytes?:number, error?:string}}
 */
function fileToDataUri(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, error: '路径为空' };
  }
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    return { ok: false, error: `读取失败: ${err.message}` };
  }
  const mime = detectMimeByExt(filePath);
  if (!mime) return { ok: false, error: '无法识别图片格式（仅支持 png/jpg/jpeg/gif/webp/bmp）' };
  if (!isSupportedImageMime(mime)) return { ok: false, error: `不支持的图片格式: ${mime}` };
  return {
    ok: true,
    mime,
    sizeBytes: buf.length,
    dataUri: toDataUri(mime, buf),
  };
}

/**
 * 把任意受支持的媒体文件读成 data URI（图片 / 音频 / 视频）
 *
 * @param {string} filePath 绝对路径
 * @returns {{ok:boolean, kind?:string, mime?:string, dataUri?:string, sizeBytes?:number, error?:string}}
 */
function fileToMediaUri(filePath) {
  if (!filePath || typeof filePath !== 'string') return { ok: false, error: '路径为空' };
  const kind = detectMediaKindByExt(filePath);
  if (!kind) {
    return { ok: false, error: '无法识别媒体格式（图片 png/jpg/gif/webp/bmp，音频 mp3/wav/flac，视频 mp4/mov/mkv/webm/avi）' };
  }
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    return { ok: false, error: `读取失败: ${err.message}` };
  }
  const mime = MEDIA_TABLES[kind][extOf(filePath)];
  return { ok: true, kind, mime, sizeBytes: buf.length, dataUri: toDataUri(mime, buf) };
}

/**
 * 生成本地媒体引用（配合引擎 --media-path，避免把大文件 base64 内联进请求体）
 * 上游 handle_media：URL 必须以 file:// 开头，其后是相对 --media-path 的路径。
 *
 * @param {string} filePath 绝对路径
 * @param {string} mediaRoot 引擎的 --media-path 目录
 * @returns {{ok:boolean, kind?:string, mime?:string, ref?:string, error?:string}}
 */
function fileToMediaRef(filePath, mediaRoot) {
  if (!filePath || typeof filePath !== 'string') return { ok: false, error: '路径为空' };
  if (!mediaRoot) return { ok: false, error: '未配置 --media-path，无法引用本地媒体文件' };
  const kind = detectMediaKindByExt(filePath);
  if (!kind) return { ok: false, error: `无法识别媒体格式: ${extOf(filePath) || '(无扩展名)'}` };
  const root = path.resolve(mediaRoot);
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return { ok: false, error: `文件不存在: ${abs}` };
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: `文件不在 --media-path 目录内: ${abs}` };
  }
  return { ok: true, kind, mime: MEDIA_TABLES[kind][extOf(filePath)], ref: `file://${rel.split(path.sep).join('/')}` };
}

/* ---------- OpenAI 风格 content part ----------
 * 上游 oaicompat_content_load_media 读的是 data ?? url，两种键都接受；
 * 内联 base64 用 data，URL / file:// 用 url，语义最清楚。 */

function mediaPartSrc(src) {
  const s = String(src || '');
  return { isData: s.startsWith('data:') || !/^(file|https?):/.test(s), src: s };
}

function toImagePart(src) {
  return { type: 'image_url', image_url: { url: String(src || '') } };
}

function toAudioPart(src) {
  const { isData, src: s } = mediaPartSrc(src);
  return { type: 'input_audio', input_audio: isData ? { data: s } : { url: s } };
}

function toVideoPart(src) {
  const { isData, src: s } = mediaPartSrc(src);
  return { type: 'input_video', input_video: isData ? { data: s } : { url: s } };
}

const PART_BUILDER = { image: toImagePart, audio: toAudioPart, video: toVideoPart };
const LABEL = { image: '图片', audio: '音频', video: '视频' };

/**
 * 打包 multimodal content。文本在前，然后依次是图片、音频、视频。
 *
 * @param {string} text 提示词
 * @param {string[]|{images?:string[], audios?:string[], videos?:string[], mediaRoot?:string}} media
 *        数组 = 兼容旧调用（全部按图片处理）；对象 = 分类传路径，给了 mediaRoot 则用 file:// 引用
 * @returns {Array|string} OpenAI multimodal content（数组）或纯字符串
 */
function toMultimodalContent(text, media) {
  const groups = Array.isArray(media)
    ? { images: media }
    : (media || {});
  const entries = [];
  for (const kind of ['image', 'audio', 'video']) {
    const list = Array.isArray(groups[`${kind}s`]) ? groups[`${kind}s`].filter(Boolean) : [];
    for (const p of list) entries.push([kind, p]);
  }
  if (!entries.length) return String(text || '');

  const parts = [];
  if (text) parts.push({ type: 'text', text: String(text) });

  for (const [kind, p] of entries) {
    const src = groups.mediaRoot ? fileToMediaRef(p, groups.mediaRoot) : fileToMediaUri(p);
    if (!src.ok) {
      // 单个媒体失败不致命：插入一段说明，继续
      parts.push({ type: 'text', text: `[${LABEL[kind]}加载失败: ${src.error}]` });
      continue;
    }
    parts.push(PART_BUILDER[kind](src.ref || src.dataUri));
  }
  return parts;
}

/**
 * 构造 OpenAI Chat 用户消息（含图片/音频/视频）
 *
 * @param {string} text
 * @param {string[]|object} media 见 toMultimodalContent
 * @returns {{role:string, content: Array|string}}
 */
function toMultimodalMessage(text, media) {
  return { role: 'user', content: toMultimodalContent(text, media) };
}

/**
 * 计算 data URI 大小（估算传输体积）
 *
 * @param {string} dataUri
 * @returns {number} 字节数
 */
function dataUriSize(dataUri) {
  if (typeof dataUri !== 'string') return 0;
  const i = dataUri.indexOf(',');
  if (i < 0) return dataUri.length;
  if (dataUri.indexOf('base64') >= 0) {
    // base64：每 4 字符 = 3 字节
    const b64 = dataUri.slice(i + 1).replace(/[\r\n]/g, '');
    return Math.floor(b64.length * 3 / 4);
  }
  // 非 base64（URL 编码）：粗估为整段长度
  return dataUri.length;
}

module.exports = {
  SUPPORTED_IMAGE_MIMES,
  SUPPORTED_AUDIO_MIMES,
  SUPPORTED_VIDEO_MIMES,
  MIME_BY_EXT,
  AUDIO_MIME_BY_EXT,
  VIDEO_MIME_BY_EXT,
  detectMimeByExt,
  detectMediaKindByExt,
  isSupportedImageMime,
  isSupportedAudioMime,
  isSupportedVideoMime,
  toDataUri,
  fileToDataUri,
  fileToMediaUri,
  fileToMediaRef,
  toImagePart,
  toAudioPart,
  toVideoPart,
  toMultimodalContent,
  toMultimodalMessage,
  dataUriSize,
};
'use strict';
/**
 * 多模态图片输入（仿 llamafile chatbot_file.cpp + chatbot_api.cpp）
 *
 * llama-server 接受 OpenAI 风格的 multimodal content：
 *   { role: 'user', content: [
 *       { type: 'text', text: '描述这张图' },
 *       { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
 *   ]}
 *
 * 这个文件只放**纯函数**：
 *   - toDataUri(mime, buf)         → "data:image/png;base64,xxxx"
 *   - encodeFileAsContent(path)     → 多模态 content 数组（图片）或单字符串
 *   - toMultimodalMessage(text, imgs) → OpenAI 风格 user message
 *   - detectMimeByExt(path)         → 'image/png' / 'image/jpeg' / ...
 *   - isSupportedImageMime(mime)    → llama.cpp 接受的图片格式
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

function detectMimeByExt(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  return MIME_BY_EXT[ext] || null;
}

function isSupportedImageMime(mime) {
  if (!mime) return false;
  return SUPPORTED_IMAGE_MIMES.has(mime.toLowerCase());
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
 * 把多张图打包成 multimodal content。文本在前，图片在后（与 llama.cpp server 一致）。
 *
 * @param {string} text 提示词
 * @param {string[]} imagePaths 绝对路径列表
 * @returns {Array|string}  OpenAI multimodal content（数组）或纯字符串
 */
function toMultimodalContent(text, imagePaths) {
  const paths = Array.isArray(imagePaths) ? imagePaths.filter(Boolean) : [];
  if (!paths.length) return String(text || '');

  const parts = [];
  if (text) parts.push({ type: 'text', text: String(text) });

  for (const p of paths) {
    const r = fileToDataUri(p);
    if (!r.ok) {
      // 一张失败不致命：插入一段说明，继续
      parts.push({ type: 'text', text: `[图片加载失败: ${r.error}]` });
      continue;
    }
    parts.push({ type: 'image_url', image_url: { url: r.dataUri } });
  }
  return parts;
}

/**
 * 构造 OpenAI Chat 用户消息（含图片）
 *
 * @param {string} text
 * @param {string[]} imagePaths
 * @returns {{role:string, content: Array|string}}
 */
function toMultimodalMessage(text, imagePaths) {
  return { role: 'user', content: toMultimodalContent(text, imagePaths) };
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
  MIME_BY_EXT,
  detectMimeByExt,
  isSupportedImageMime,
  toDataUri,
  fileToDataUri,
  toMultimodalContent,
  toMultimodalMessage,
  dataUriSize,
};
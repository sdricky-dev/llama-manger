'use strict';
/**
 * 音频接口契约层（对齐上游 llama-server 的 /tts、/v1/audio/transcriptions、/v1/realtime）
 *
 * 这里只放**纯函数**：不碰 fetch、不碰 DOM、不读盘。
 * 渲染层拿这些形状去发请求，单元测试因此可以完全覆盖契约本身。
 *
 * 上游依据：
 *   - tools/server/README.md  §POST /tts / §WebSocket /v1/realtime / §Realtime conversation
 *   - tools/server/server-realtime.cpp（事件名与字段）
 *   - tools/server/server-common.cpp（媒体加载）
 * 关键约束：
 *   - 实时音频一律 PCM16 单声道，采样率由 session.created 的 audio.input.format.rate 给出
 *   - input_audio_buffer.append 的 audio = base64(PCM16)
 *   - /tts 返回裸音频字节（默认 wav），不是 JSON
 */

/* ---------- PCM16 <-> base64 ---------- */

/** Int16Array（或任何 int16 样本视图）→ base64，小端原样透传 */
function pcm16ToBase64(samples) {
  const view = samples instanceof Int16Array ? samples : Int16Array.from(samples);
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64');
}

/** base64 → Int16Array；末尾凑不满一个样本的字节被丢弃 */
function base64ToPcm16(b64) {
  const raw = Buffer.from(String(b64 || ''), 'base64');
  const n = Math.floor(raw.length / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = raw.readInt16LE(i * 2);
  return out;
}

/* ---------- WAV（/tts 默认响应格式） ---------- */

const WAV_HEADER_BYTES = 44;

/** 单声道 PCM16 → 完整 wav 文件字节 */
function encodeWav(pcm16, sampleRate) {
  const samples = pcm16 instanceof Int16Array ? pcm16 : Int16Array.from(pcm16 || []);
  const rate = Math.round(Number(sampleRate) || 0);
  if (!rate) throw new Error('encodeWav: sampleRate 必须为正整数');
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(WAV_HEADER_BYTES + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(WAV_HEADER_BYTES - 8 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byteRate
  buf.writeUInt16LE(2, 32); // blockAlign
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], WAV_HEADER_BYTES + i * 2);
  return buf;
}

/**
 * 解析 wav 头部（按 chunk 遍历，容忍 data 之前的 LIST/infolist 等附加块）。
 * 流式 WAV 的 data size 是占位的 0xFFFFFFFF，这里收敛成实际可读字节数。
 *
 * @returns {{ok:boolean, sampleRate?:number, channels?:number, bitsPerSample?:number,
 *            dataOffset?:number, dataSize?:number, error?:string}}
 */
function parseWavHeader(buf) {
  if (!buf || buf.length < WAV_HEADER_BYTES) return { ok: false, error: '数据不足以构成 wav 头' };
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return { ok: false, error: '不是 RIFF 容器' };
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return { ok: false, error: '不是 WAVE 文件' };
  let p = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'fmt ') {
      if (body + 16 > buf.length) return { ok: false, error: 'fmt 块不完整' };
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      const available = Math.max(0, buf.length - body);
      return {
        ok: true,
        sampleRate,
        channels,
        bitsPerSample: bits,
        dataOffset: body,
        dataSize: Math.min(size, available),
      };
    }
    p = body + size + (size % 2); // chunk 按偶数边界对齐
  }
  return { ok: false, error: '没找到 data 块' };
}

/* ---------- POST /tts ---------- */

/**
 * 构造 /tts 请求体（JSON 路线；参考音频用 speakerRefB64 内联）。
 * 只下发显式给过的字段——未给的都交给引擎默认。
 *
 * @param {{input?:string, prompt?:string, lang?:string, voice?:string,
 *           speakerRefB64?:string, responseFormat?:'wav'|'pcm', stream?:boolean,
 *           temperature?:number, topK?:number, topP?:number, repeatPenalty?:number,
 *           seed?:number, nPredict?:number}} o
 */
function ttsRequest(o) {
  const src = o || {};
  const text = String(src.input ?? src.prompt ?? '');
  if (!text.trim()) throw new Error('ttsRequest: input（要朗读的文本）不能为空');
  if (src.voice && src.speakerRefB64) {
    throw new Error('ttsRequest: voice 与 speakerRefB64 不能同时给（预置音色不可与参考音频混用）');
  }
  const b = { input: text };
  if (src.lang) b.lang = String(src.lang);
  if (src.voice) b.voice = String(src.voice);
  if (src.speakerRefB64) b.speaker_ref_b64 = String(src.speakerRefB64);
  if (src.responseFormat) b.response_format = String(src.responseFormat);
  if (src.stream === true) b.stream = true;
  // 采样类字段：0 是有效取值（贪心 / 关），所以按"是否为数字"判断
  if (Number.isFinite(src.temperature)) b.temperature = src.temperature;
  if (Number.isFinite(src.topK)) b.top_k = src.topK;
  if (Number.isFinite(src.topP)) b.top_p = src.topP;
  if (Number.isFinite(src.repeatPenalty)) b.repeat_penalty = src.repeatPenalty;
  if (Number.isFinite(src.seed)) b.seed = src.seed;
  if (Number.isFinite(src.nPredict)) b.n_predict = src.nPredict;
  return b;
}

/* ---------- POST /v1/audio/transcriptions ---------- */

/**
 * multipart 表单里除文件以外的字段（文件由调用方按 fileField 名字附上）。
 * FormData 只收字符串，所以数字统一转成字符串。
 */
function transcriptionFields(o) {
  const src = o || {};
  const fields = {};
  if (src.model) fields.model = String(src.model);
  if (src.language) fields.language = String(src.language);
  if (src.prompt) fields.prompt = String(src.prompt);
  if (src.responseFormat) fields.response_format = String(src.responseFormat);
  if (Number.isFinite(src.temperature)) fields.temperature = String(src.temperature);
  return { fileField: 'file', fields };
}

/* ---------- WebSocket /v1/realtime ---------- */

/** http(s) 基址 → realtime 的 ws(s) 地址；intent='transcription' 走纯转写会话 */
function realtimeUrl(base, intent) {
  let u = String(base || '').replace(/\/+$/, '');
  u = u.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  u += '/v1/realtime';
  return intent ? `${u}?intent=${encodeURIComponent(intent)}` : u;
}

/** camelCase → 上游 snake_case 的 session 字段表 */
const SESSION_FIELDS = {
  type: 'type',
  instructions: 'instructions',
  outputModalities: 'output_modalities',
  maxOutputTokens: 'max_output_tokens',
  tools: 'tools',
  toolChoice: 'tool_choice',
};

/**
 * session.update：字段名逐一对齐上游；未给的字段不出现，免得覆盖服务端默认。
 * transcriptionLanguage 落到 session.transcription.language（仅转写会话有意义）。
 */
function realtimeSessionUpdate(o) {
  const src = o || {};
  const session = {};
  for (const [k, out] of Object.entries(SESSION_FIELDS)) {
    if (src[k] !== undefined && src[k] !== null) session[out] = src[k];
  }
  if (src.transcriptionLanguage) session.transcription = { language: String(src.transcriptionLanguage) };
  return { type: 'session.update', session };
}

function realtimeAppendAudio(b64Pcm16) {
  return { type: 'input_audio_buffer.append', audio: String(b64Pcm16 || '') };
}

/** final=true 表示输入到此结束（后续不再有音频），服务端把最后一段收尾 */
function realtimeCommit(final) {
  return final ? { type: 'input_audio_buffer.commit', final: true } : { type: 'input_audio_buffer.commit' };
}

function realtimeClearAudio() {
  return { type: 'input_audio_buffer.clear' };
}

function realtimeCreateTextItem(text) {
  return {
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: String(text || '') }] },
  };
}

function realtimeFunctionCallOutput(callId, output) {
  return {
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: String(callId || ''), output: String(output ?? '') },
  };
}

const RESPONSE_FIELDS = {
  outputModalities: 'output_modalities',
  maxOutputTokens: 'max_output_tokens',
  toolChoice: 'tool_choice',
};

/** response.create：可选的逐次覆盖（不覆盖会话级默认） */
function realtimeCreateResponse(o) {
  if (!o || !Object.keys(o).length) return { type: 'response.create' };
  const response = {};
  for (const [k, out] of Object.entries(RESPONSE_FIELDS)) {
    if (o[k] !== undefined && o[k] !== null) response[out] = o[k];
  }
  return { type: 'response.create', response };
}

function realtimeCancel() {
  return { type: 'response.cancel' };
}

/**
 * 服务端事件 → 归一化形态，供 UI 分发。
 * 只保留 UI 真正要用的字段，未知事件归为 unknown（上游会持续加事件名）。
 */
function parseRealtimeEvent(evt) {
  const e = evt && typeof evt === 'object' ? evt : {};
  switch (e.type) {
    case 'session.created':
    case 'session.updated':
      return { kind: 'session', session: e.session || {} };
    case 'response.output_text.delta':
      return { kind: 'text', delta: e.delta || '' };
    case 'response.output_audio.delta':
      return { kind: 'audio', delta: e.delta || '' };
    case 'conversation.item.input_audio_transcription.delta':
      return { kind: 'transcript', delta: e.delta || '', itemId: e.item_id };
    case 'conversation.item.input_audio_transcription.completed':
      return { kind: 'transcript_done', transcript: e.transcript || '', itemId: e.item_id };
    case 'response.function_call_arguments.delta':
      return { kind: 'tool_call', delta: e.delta || '', itemId: e.item_id };
    case 'input_audio_buffer.committed':
      return { kind: 'committed', itemId: e.item_id, previousItemId: e.previous_item_id ?? null };
    case 'response.done':
      return { kind: 'response_done' };
    case 'error': {
      const err = e.error || {};
      return { kind: 'error', message: err.message || '未知错误', code: err.code };
    }
    default:
      return { kind: 'unknown' };
  }
}

module.exports = {
  WAV_HEADER_BYTES,
  pcm16ToBase64,
  base64ToPcm16,
  encodeWav,
  parseWavHeader,
  ttsRequest,
  transcriptionFields,
  realtimeUrl,
  realtimeSessionUpdate,
  realtimeAppendAudio,
  realtimeCommit,
  realtimeClearAudio,
  realtimeCreateTextItem,
  realtimeFunctionCallOutput,
  realtimeCreateResponse,
  realtimeCancel,
  parseRealtimeEvent,
};

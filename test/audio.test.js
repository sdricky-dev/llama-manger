'use strict';
/**
 * 音频接口契约层（shared/audio.js）单元测试
 *
 * 只测**纯函数**：请求体构造 / PCM 与 WAV 编解码 / WebSocket 事件构造与解析。
 * 上游契约来源：tools/server/README.md（POST /tts、WebSocket /v1/realtime）、
 * tools/server/server-common.cpp（oaicompat content）、tools/server/server-realtime.cpp。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  encodeWav,
  parseWavHeader,
  pcm16ToBase64,
  base64ToPcm16,
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
} = require('../shared/audio');

/* ---------- WAV ---------- */

test('encodeWav：44 字节 RIFF 头字段正确，样本按小端 int16 排列', () => {
  const pcm = new Int16Array([1, -1, 32767, -32768]);
  const buf = encodeWav(pcm, 24000);
  assert.equal(buf.length, 44 + 8);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buf.toString('ascii', 12, 16), 'fmt ');
  assert.equal(buf.readUInt32LE(4), 36 + 8, 'RIFF size = 36 + data');
  assert.equal(buf.readUInt32LE(16), 16, 'fmt chunk size');
  assert.equal(buf.readUInt16LE(20), 1, 'PCM 格式');
  assert.equal(buf.readUInt16LE(22), 1, '单声道');
  assert.equal(buf.readUInt32LE(24), 24000);
  assert.equal(buf.readUInt32LE(28), 48000, 'byteRate = rate*2');
  assert.equal(buf.readUInt16LE(32), 2, 'blockAlign');
  assert.equal(buf.readUInt16LE(34), 16, 'bits');
  assert.equal(buf.toString('ascii', 36, 40), 'data');
  assert.equal(buf.readUInt32LE(40), 8);
  assert.equal(buf.readInt16LE(44), 1);
  assert.equal(buf.readInt16LE(46), -1);
  assert.equal(buf.readInt16LE(48), 32767);
  assert.equal(buf.readInt16LE(50), -32768);
});

test('parseWavHeader：能读回 encodeWav 的结果', () => {
  const pcm = new Int16Array([10, 20, 30]);
  const r = parseWavHeader(encodeWav(pcm, 16000));
  assert.equal(r.ok, true);
  assert.equal(r.sampleRate, 16000);
  assert.equal(r.channels, 1);
  assert.equal(r.bitsPerSample, 16);
  assert.equal(r.dataSize, 6);
  assert.equal(r.dataOffset, 44);
});

test('parseWavHeader：跳过 data 之前的额外 chunk（流式 WAV 常有 LIST/infolist）', () => {
  // 手工拼：RIFF/WAVE + fmt (16B) + LIST(10B 载荷) + data(4B 载荷)
  const fourcc = (s) => Buffer.from(s, 'ascii');
  const fmt = Buffer.alloc(16 + 8);
  fourcc('fmt ').copy(fmt, 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(1, 10); // mono
  fmt.writeUInt32LE(22050, 12);
  fmt.writeUInt32LE(44100, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const list = Buffer.alloc(8 + 10);
  fourcc('LIST').copy(list, 0);
  list.writeUInt32LE(10, 4);
  const data = Buffer.alloc(8 + 4);
  fourcc('data').copy(data, 0);
  data.writeUInt32LE(4, 4);
  const body = Buffer.concat([fourcc('WAVE'), fmt, list, data]);
  const buf = Buffer.concat([fourcc('RIFF'), (() => { const l = Buffer.alloc(4); l.writeUInt32LE(body.length, 0); return l; })(), body]);
  const r = parseWavHeader(buf);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.sampleRate, 22050);
  assert.equal(r.bitsPerSample, 16);
  assert.equal(r.dataSize, 4);
  assert.equal(r.dataOffset, 12 + fmt.length + list.length + 8);
});

test('parseWavHeader：非 WAV / 太短 → ok:false', () => {
  assert.equal(parseWavHeader(Buffer.from('not a wav file at all......')).ok, false);
  assert.equal(parseWavHeader(Buffer.alloc(10)).ok, false);
});

/* ---------- PCM16 <-> base64 ---------- */

test('pcm16ToBase64 / base64ToPcm16：往返一致', () => {
  const pcm = new Int16Array([0, 1, -1, 12345, -32768]);
  const b64 = pcm16ToBase64(pcm);
  assert.equal(typeof b64, 'string');
  const back = base64ToPcm16(b64);
  assert.deepEqual(Array.from(back), Array.from(pcm));
});

test('base64ToPcm16：空串返回空数组；奇数字节被截到整样本', () => {
  assert.equal(base64ToPcm16('').length, 0);
  const odd = Buffer.alloc(3);
  assert.equal(base64ToPcm16(odd.toString('base64')).length, 1);
});

/* ---------- POST /tts ---------- */

test('ttsRequest：input 必填，prompt 作为别名归一化', () => {
  assert.deepEqual(ttsRequest({ input: '你好' }), { input: '你好' });
  assert.deepEqual(ttsRequest({ prompt: 'hi' }), { input: 'hi' });
  assert.throws(() => ttsRequest({}), /input/);
  assert.throws(() => ttsRequest({ input: '   ' }), /input/);
});

test('ttsRequest：只带显式给过的字段，0 也要下发', () => {
  const b = ttsRequest({
    input: 'text',
    lang: 'zh',
    speakerRefB64: 'QUFERQ==',
    responseFormat: 'pcm',
    stream: true,
    temperature: 0,
    topK: 40,
    topP: 0.9,
    repeatPenalty: 1.05,
    seed: 7,
    nPredict: 1024,
  });
  assert.equal(b.lang, 'zh');
  assert.equal(b.speaker_ref_b64, 'QUFERQ==');
  assert.equal(b.response_format, 'pcm');
  assert.equal(b.stream, true);
  assert.equal(b.temperature, 0, 'temperature=0（贪心）是有效取值');
  assert.equal(b.top_k, 40);
  assert.equal(b.top_p, 0.9);
  assert.equal(b.repeat_penalty, 1.05);
  assert.equal(b.seed, 7);
  assert.equal(b.n_predict, 1024);
});

test('ttsRequest：未给的可选字段不出现，false/stream 缺省不下发', () => {
  const b = ttsRequest({ input: 'x', voice: 'male' });
  assert.deepEqual(Object.keys(b).sort(), ['input', 'voice']);
  const s = ttsRequest({ input: 'x', stream: false });
  assert.equal(s.stream, undefined, 'false = 跟随引擎默认，省略');
});

test('ttsRequest：voice 与 speakerRefB64 互斥（上游：预置音色不能和参考音频同用）', () => {
  assert.throws(() => ttsRequest({ input: 'x', voice: 'male', speakerRefB64: 'QQ==' }), /voice/);
});

/* ---------- POST /v1/audio/transcriptions ---------- */

test('transcriptionFields：OpenAI 字段名 + 文件字段单列', () => {
  const r = transcriptionFields({
    model: '/tmp/m.gguf',
    language: 'en',
    prompt: '专有名词参考',
    responseFormat: 'verbose_json',
    temperature: 0.2,
  });
  assert.equal(r.fileField, 'file');
  assert.equal(r.fields.model, '/tmp/m.gguf');
  assert.equal(r.fields.language, 'en');
  assert.equal(r.fields.prompt, '专有名词参考');
  assert.equal(r.fields.response_format, 'verbose_json');
  assert.equal(r.fields.temperature, '0.2');
});

test('transcriptionFields：只给模型时其余字段留空', () => {
  const r = transcriptionFields({ model: 'm' });
  assert.deepEqual(r.fields, { model: 'm' });
});

/* ---------- WebSocket /v1/realtime ---------- */

test('realtimeUrl：transcription 意图带 query，默认不带', () => {
  assert.equal(realtimeUrl('http://127.0.0.1:9931'), 'ws://127.0.0.1:9931/v1/realtime');
  assert.equal(
    realtimeUrl('http://127.0.0.1:9931', 'transcription'),
    'ws://127.0.0.1:9931/v1/realtime?intent=transcription',
  );
  assert.equal(realtimeUrl('https://x/y'), 'wss://x/y/v1/realtime');
});

test('realtime 客户端事件：形状与上游一致', () => {
  assert.deepEqual(realtimeAppendAudio('QUFB'), { type: 'input_audio_buffer.append', audio: 'QUFB' });
  assert.deepEqual(realtimeCommit(), { type: 'input_audio_buffer.commit' });
  assert.deepEqual(realtimeCommit(true), { type: 'input_audio_buffer.commit', final: true });
  assert.deepEqual(realtimeClearAudio(), { type: 'input_audio_buffer.clear' });
  assert.deepEqual(realtimeCancel(), { type: 'response.cancel' });
  assert.deepEqual(realtimeCreateTextItem('你好'), {
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] },
  });
  assert.deepEqual(realtimeFunctionCallOutput('call_1', '{"a":1}'), {
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: 'call_1', output: '{"a":1}' },
  });
  assert.deepEqual(realtimeCreateResponse(), { type: 'response.create' });
});

test('realtimeSessionUpdate：空 session 也要带对象，字段按上游命名', () => {
  assert.deepEqual(realtimeSessionUpdate({}), { type: 'session.update', session: {} });
  const ev = realtimeSessionUpdate({
    type: 'transcription',
    instructions: '你是记录员',
    outputModalities: ['text', 'audio'],
    maxOutputTokens: 'inf',
    toolChoice: 'none',
    transcriptionLanguage: 'zh',
    tools: [{ name: 'f', description: 'd', parameters: {} }],
  });
  assert.equal(ev.type, 'session.update');
  assert.equal(ev.session.type, 'transcription');
  assert.equal(ev.session.instructions, '你是记录员');
  assert.deepEqual(ev.session.output_modalities, ['text', 'audio']);
  assert.equal(ev.session.max_output_tokens, 'inf');
  assert.equal(ev.session.tool_choice, 'none');
  assert.deepEqual(ev.session.transcription, { language: 'zh' });
  assert.equal(ev.session.tools.length, 1);
});

test('realtimeSessionUpdate：未给的字段不出现（避免覆盖服务端默认）', () => {
  const ev = realtimeSessionUpdate({ instructions: 'x' });
  assert.deepEqual(Object.keys(ev.session), ['instructions']);
});

test('realtimeCreateResponse：无覆盖时不带 response 键', () => {
  assert.deepEqual(realtimeCreateResponse({ outputModalities: ['text'] }), {
    type: 'response.create',
    response: { output_modalities: ['text'] },
  });
});

/* ---------- 服务端事件解析 ---------- */

test('parseRealtimeEvent：归类各类服务端事件', () => {
  assert.deepEqual(parseRealtimeEvent({ type: 'session.created', session: { audio: 1 } }), {
    kind: 'session', session: { audio: 1 },
  });
  assert.deepEqual(parseRealtimeEvent({ type: 'session.updated', session: {} }), {
    kind: 'session', session: {},
  });
  assert.deepEqual(parseRealtimeEvent({ type: 'response.output_text.delta', delta: '你好' }), {
    kind: 'text', delta: '你好',
  });
  assert.deepEqual(parseRealtimeEvent({ type: 'response.output_audio.delta', delta: 'QUFB' }), {
    kind: 'audio', delta: 'QUFB',
  });
  assert.deepEqual(
    parseRealtimeEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: 'ab', item_id: 'i1' }),
    { kind: 'transcript', delta: 'ab', itemId: 'i1' },
  );
  assert.deepEqual(
    parseRealtimeEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'abc', item_id: 'i1' }),
    { kind: 'transcript_done', transcript: 'abc', itemId: 'i1' },
  );
  assert.deepEqual(parseRealtimeEvent({ type: 'response.function_call_arguments.delta', delta: '{"a":', item_id: 'i2' }), {
    kind: 'tool_call', delta: '{"a":', itemId: 'i2',
  });
  assert.deepEqual(parseRealtimeEvent({ type: 'input_audio_buffer.committed', item_id: 'i3', previous_item_id: null }), {
    kind: 'committed', itemId: 'i3', previousItemId: null,
  });
  assert.deepEqual(parseRealtimeEvent({ type: 'response.done' }), { kind: 'response_done' });
});

test('parseRealtimeEvent：error 事件提取 message', () => {
  const r = parseRealtimeEvent({ type: 'error', error: { message: 'buffer is empty', code: 'x' } });
  assert.equal(r.kind, 'error');
  assert.equal(r.message, 'buffer is empty');
  assert.equal(r.code, 'x');
});

test('parseRealtimeEvent：未知 / 缺 type → unknown，不抛错', () => {
  assert.equal(parseRealtimeEvent({ type: 'rates' }).kind, 'unknown');
  assert.equal(parseRealtimeEvent({}).kind, 'unknown');
  assert.equal(parseRealtimeEvent(null).kind, 'unknown');
});

'use strict';
/**
 * 文件角色识别（主模型 / mmproj 视觉投影 / 草稿模型）与
 * tensor 实测量化推导的测试。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseModelFile, deriveQuant, classifyRole, GGML_TYPES } = require('../main/gguf');
const { scanDir } = require('../main/models');
const { buildGguf } = require('./helpers');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lm-roles-'));
}

// ---------- classifyRole ----------

test('classifyRole：general.type=mmproj → mmproj', () => {
  const kv = { 'general.type': 'mmproj', 'general.architecture': 'clip' };
  assert.equal(classifyRole('clip', kv, '/m/mmproj-BF16.gguf'), 'mmproj');
});

test('classifyRole：arch=clip 无 general.type 也判为 mmproj', () => {
  const kv = { 'general.architecture': 'clip' };
  assert.equal(classifyRole('clip', kv, '/m/whatever.gguf'), 'mmproj');
});

test('classifyRole：文件名含 mmproj 兜底', () => {
  assert.equal(classifyRole('unknown', {}, '/m/GEV.mmproj-f16.gguf'), 'mmproj');
});

test('classifyRole：草稿架构（dflash/eagle3）→ draft', () => {
  assert.equal(classifyRole('dflash', {}, '/m/DFlash2.gguf'), 'draft');
  assert.equal(classifyRole('eagle3', {}, '/m/x.gguf'), 'draft');
});

test('classifyRole：普通模型 → model（含名字带 mtp 的主模型）', () => {
  assert.equal(classifyRole('qwen35', { 'general.type': 'model' }, '/m/Swift-IQ3_S-mtp.gguf'), 'model');
  assert.equal(classifyRole('llama', {}, '/m/llama-8b.gguf'), 'model');
});

// ---------- deriveQuant ----------

test('deriveQuant：按元素数取主类型，跳过 1 维张量', () => {
  const tensors = [
    { name: 'a.weight', dims: [4096, 4096], type: 12, elems: 4096 * 4096 }, // Q4_K
    { name: 'b.weight', dims: [1024, 1024], type: 8, elems: 1024 * 1024 }, // Q8_0 少量
    { name: 'norm.weight', dims: [4096], type: 0, elems: 4096 }, // F32，1 维应忽略
  ];
  const r = deriveQuant(tensors);
  assert.equal(r.quant, 'Q4_K_S');
  assert.equal(r.source, 'tensors');
  assert.ok(r.share > 0.9);
});

test('deriveQuant：Q4_K 主 + 显著 Q6_K → 判为 Q4_K_M 风格', () => {
  const tensors = [
    { name: 'a', dims: [1000, 100], type: 12, elems: 100000 }, // Q4_K 83%
    { name: 'b', dims: [100, 200], type: 14, elems: 20000 }, // Q6_K 17%
  ];
  assert.equal(deriveQuant(tensors).quant, 'Q4_K_M');
});

test('deriveQuant：纯 Q4_K → Q4_K_S', () => {
  const tensors = [{ name: 'a', dims: [1000, 100], type: 12, elems: 100000 }];
  assert.equal(deriveQuant(tensors).quant, 'Q4_K_S');
});

test('deriveQuant：f16/bf16 与无 2 维张量的边界', () => {
  assert.equal(deriveQuant([{ name: 'a', dims: [8, 8], type: 1, elems: 64 }]).quant, 'f16');
  assert.equal(deriveQuant([{ name: 'a', dims: [8, 8], type: 30, elems: 64 }]).quant, 'bf16');
  assert.equal(deriveQuant([{ name: 'n', dims: [16], type: 0, elems: 16 }]), null);
  assert.equal(deriveQuant([]), null);
});

test('GGML_TYPES 覆盖常见类型且无重复错位', () => {
  assert.equal(GGML_TYPES[0], 'F32');
  assert.equal(GGML_TYPES[8], 'Q8_0');
  assert.equal(GGML_TYPES[12], 'Q4_K');
  assert.equal(GGML_TYPES[14], 'Q6_K');
  assert.equal(GGML_TYPES[21], 'IQ3_S');
  assert.equal(GGML_TYPES[30], 'BF16');
});

// ---------- 端到端：解析出角色 + 实测量化 ----------

test('parseModelFile：mmproj 文件量化取自 tensor（而非错误的 general.file_type）', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'mmproj-BF16.gguf');
  buildGguf(
    {
      arch: 'clip',
      nLayer: 0,
      ctxTrain: 0,
      fileType: 32, // 发布者写错的元数据 IQ3_S
      extraKv: {
        'general.type': { type: 8, value: 'mmproj' },
        'clip.has_vision_encoder': { type: 8, value: 'x' },
      },
      tensors: [
        { name: 'v.blk.0.attn_q.weight', dims: [256, 256], type: 30 }, // BF16
        { name: 'v.blk.0.norm.weight', dims: [256], type: 0 },
      ],
    },
    p
  );
  const m = parseModelFile(p);
  assert.equal(m.role, 'mmproj');
  assert.equal(m.quant, 'bf16');
  assert.equal(m.fileTypeLabel, 'IQ3_S'); // 元数据仍保留，便于对照
  assert.equal(m.quantSource, 'tensors');
});

test('parseModelFile：草稿模型识别 + 内置 MTP 标记', () => {
  const dir = tmpDir();
  const draft = path.join(dir, 'X-DFlash2-Q4_K_M.gguf');
  buildGguf(
    { arch: 'dflash', nLayer: 5, fileType: 15, tensors: [{ name: 'w', dims: [64, 64], type: 12 }] },
    draft
  );
  const d = parseModelFile(draft);
  assert.equal(d.role, 'draft');
  assert.equal(d.quant, 'Q4_K_S');

  const main = path.join(dir, 'Big-IQ3_S-mtp.gguf');
  buildGguf(
    {
      arch: 'qwen35',
      nLayer: 65,
      fileType: 32,
      extraKv: { 'qwen35.nextn_predict_layers': { type: 10, value: 1 } },
      tensors: [{ name: 'w', dims: [64, 64], type: 21 }],
    },
    main
  );
  const m = parseModelFile(main);
  assert.equal(m.role, 'model');
  assert.equal(m.hasMtp, true);
  assert.equal(m.quant, 'IQ3_S');
});

// ---------- scanDir：附属文件归组 ----------

test('scanDir：mmproj/草稿归入同目录主模型的 companions，不再冒充独立模型', () => {
  const root = tmpDir();
  const modelDir = path.join(root, 'vendor', 'ModelX-GGUF');
  const main = path.join(modelDir, 'ModelX-Q4_K_M.gguf');
  const mmproj = path.join(modelDir, 'mmproj-ModelX-BF16.gguf');
  const draft = path.join(modelDir, 'ModelX-DFlash-Q4_K_M.gguf');
  buildGguf({ arch: 'qwen35', extraKv: { 'general.type': { type: 8, value: 'model' } }, tensors: [{ name: 'w', dims: [128, 128], type: 12 }] }, main);
  buildGguf({ arch: 'clip', extraKv: { 'general.type': { type: 8, value: 'mmproj' } }, tensors: [{ name: 'v', dims: [64, 64], type: 30 }] }, mmproj);
  buildGguf({ arch: 'dflash', tensors: [{ name: 'w', dims: [64, 64], type: 12 }] }, draft);
  // 孤立 mmproj（同目录没有主模型）
  const loneDir = path.join(root, 'lone');
  buildGguf({ arch: 'clip', extraKv: { 'general.type': { type: 8, value: 'mmproj' } }, tensors: [] }, path.join(loneDir, 'mmproj-lone.gguf'));

  const { models, companions, orphans } = scanDir(root);
  assert.equal(models.length, 1, '只有 1 个可独立加载的模型');
  assert.equal(models[0].path, main);
  assert.equal(models[0].companions.mmproj.length, 1);
  assert.equal(models[0].companions.mmproj[0].path, mmproj);
  assert.equal(models[0].companions.draft.length, 1);
  assert.equal(companions.length, 3, 'mmproj×2 + 草稿×1');
  assert.equal(orphans.length, 1, '孤立的 mmproj 单独列出');
  assert.ok(orphans[0].path.endsWith('mmproj-lone.gguf'));
});

test('scanDir：损坏文件只产生 warning，不影响其余模型', () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'broken.gguf'), Buffer.from('NOTGGUF'));
  buildGguf({ arch: 'llama', tensors: [] }, path.join(root, 'good.gguf'));
  const { models, warnings } = scanDir(root);
  assert.equal(models.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /不是 GGUF 文件/);
});

// ---------- decision（判决）模型 ----------

test('parseModelFile：支持的 decision 类型被判为可加载', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'judge-openjev.gguf');
  buildGguf(
    {
      arch: 'qwen35',
      extraKv: {
        'qwen35.decision.type': { type: 8, value: 'openjev' },
        'tokenizer.chat_template.systemone': { type: 8, value: 'systemone-template' },
      },
      tensors: [],
    },
    p
  );
  const m = parseModelFile(p);
  assert.equal(m.decisionType, 'openjev');
  assert.equal(m.decisionSupported, true);
  assert.equal(m.decisionAlias, null);
  assert.equal(m.decisionTemplate, true);
});

test('parseModelFile：未知 decision 类型 → 标记引擎不支持（加载会失败）', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'judge-unknown.gguf');
  buildGguf(
    {
      arch: 'qwen35',
      extraKv: {
        'qwen35.decision.type': { type: 8, value: 'some-future-type' },
        'tokenizer.chat_template.systemone': { type: 8, value: 'tpl' },
      },
      tensors: [],
    },
    p
  );
  const m = parseModelFile(p);
  assert.equal(m.decisionSupported, false);
  assert.equal(m.decisionAlias, null);
  assert.equal(m.decisionTemplate, true); // 结构完整 → 提示可用别名补丁解决
});

test('parseModelFile：别名 jev → 记为 supported 且带上目标类型', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'JEV-27B-VL-Q4_K_M.gguf');
  buildGguf(
    {
      arch: 'qwen35',
      extraKv: {
        'qwen35.decision.type': { type: 8, value: 'jev' },
        'tokenizer.chat_template.systemone': { type: 8, value: 'tpl' },
      },
      tensors: [],
    },
    p
  );
  const m = parseModelFile(p);
  assert.equal(m.decisionType, 'jev');
  assert.equal(m.decisionSupported, true);
  assert.equal(m.decisionAlias, 'openjev');
});

test('普通模型不带 decision 标记', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'plain.gguf');
  buildGguf({ arch: 'llama', tensors: [] }, p);
  const m = parseModelFile(p);
  assert.equal(m.decisionType, null);
  assert.equal(m.decisionSupported, null);
  assert.equal(m.decisionTemplate, false);
});

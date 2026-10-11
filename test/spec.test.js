'use strict';
/**
 * 投机解码类型与模型能力的匹配（shared/spec.js）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { supportFor, availableValues, specTypeForArch } = require('../shared/spec');

const PLAIN = { arch: 'llama', hasMtp: false, companions: { mmproj: [], draft: [] } };
const MTP = { arch: 'qwen35', hasMtp: true, companions: { mmproj: [], draft: [] } };
const draft = (arch) => ({ path: `/tmp/${arch}.gguf`, name: arch, arch, quant: 'Q4_K_S', sizeBytes: 1.1e9, sizeGB: 1.1 });

test('specTypeForArch：草稿架构 → 类型', () => {
  assert.equal(specTypeForArch('dflash'), 'draft-dflash');
  assert.equal(specTypeForArch('eagle3'), 'draft-eagle3');
  assert.equal(specTypeForArch('dspark'), 'draft-dspark');
  assert.equal(specTypeForArch('mtp'), 'draft-mtp');
  assert.equal(specTypeForArch('qwen3'), 'draft-simple');
  assert.equal(specTypeForArch(null), 'draft-simple');
});

test('无 MTP、无草稿：只有 none 与 ngram 可用，推荐 none', () => {
  const r = supportFor(PLAIN);
  assert.equal(r.recommended, 'none');
  const avail = availableValues(PLAIN);
  assert.deepEqual(avail, ['none', 'ngram-simple', 'ngram-mod', 'ngram-cache']);
  assert.ok(!avail.includes('draft-mtp'));
  assert.ok(!avail.includes('draft-simple'));
  // 不可用项要给出原因
  const mtp = r.options.find((o) => o.value === 'draft-mtp');
  assert.equal(mtp.available, false);
  assert.match(mtp.reason, /MTP/);
  const simple = r.options.find((o) => o.value === 'draft-simple');
  assert.match(simple.reason, /草稿模型/);
});

test('内置 MTP 模型：draft-mtp 可用且被推荐', () => {
  const r = supportFor(MTP);
  assert.equal(r.recommended, 'draft-mtp');
  assert.ok(availableValues(MTP).includes('draft-mtp'));
  assert.match(r.options.find((o) => o.value === 'draft-mtp').reason, /自带 MTP/);
});

test('配了 DFlash 草稿：只放行 draft-dflash，并屏蔽 eagle3/dspark', () => {
  const model = { ...PLAIN, companions: { mmproj: [], draft: [draft('dflash')] } };
  const avail = availableValues(model);
  assert.ok(avail.includes('draft-dflash'));
  assert.ok(avail.includes('draft-simple'), '通用草稿类型仍可用');
  assert.ok(!avail.includes('draft-eagle3'));
  assert.ok(!avail.includes('draft-dspark'));
  assert.equal(supportFor(model).recommended, 'draft-dflash');
  // 不可用原因要指向正确类型
  assert.match(supportFor(model).options.find((o) => o.value === 'draft-eagle3').reason, /draft-dflash/);
});

test('草稿模型存在但未在 params 中启用时，按同目录唯一草稿识别', () => {
  const model = { ...PLAIN, companions: { mmproj: [], draft: [draft('eagle3')] } };
  assert.equal(supportFor(model, {}).recommended, 'draft-eagle3');
  // 显式指定了路径则优先用它
  const p = supportFor(model, { specDraft: '/tmp/eagle3.gguf' });
  assert.equal(p.recommended, 'draft-eagle3');
  assert.ok(p.draft);
});

test('MTP 模型 + 草稿模型：按草稿架构推荐（草稿优先）', () => {
  const model = { ...MTP, companions: { mmproj: [], draft: [draft('dflash')] } };
  assert.equal(supportFor(model).recommended, 'draft-dflash');
  const avail = availableValues(model);
  assert.ok(avail.includes('draft-mtp'), '内置 MTP 仍可作为备选');
  assert.ok(avail.includes('draft-dflash'));
});

test('手填草稿路径（不在同目录）也能按文件名推断并放行对应类型', () => {
  const model = { ...PLAIN, companions: { mmproj: [], draft: [] } };
  const p = { specDraft: '/some/where/Qwen3.8-27B-DFlash2-Q4_K_M.gguf' };
  const r = supportFor(model, p);
  assert.equal(r.recommended, 'draft-dflash');
  assert.ok(availableValues(model, p).includes('draft-dflash'));
  assert.equal(r.draft.manual, true);
  // 文件名无特征 → 通用类型
  const p2 = { specDraft: '/some/where/small-draft-model.gguf' };
  assert.equal(supportFor(model, p2).recommended, 'draft-simple');
});

test('ngram 类型任何模型都可用（无需额外模型）', () => {
  for (const m of [PLAIN, MTP]) {
    const avail = availableValues(m);
    for (const t of ['ngram-simple', 'ngram-mod', 'ngram-cache']) {
      assert.ok(avail.includes(t), `${t} 应对任何模型可用`);
    }
  }
});

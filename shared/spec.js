'use strict';
/**
 * 投机解码（speculative decoding）类型与模型能力的对应关系（主进程/渲染层共用）。
 *
 * llama.cpp 的 --spec-type 取值（build 11553 实测）：
 *   none, draft-simple, draft-eagle3, draft-mtp, draft-dflash, draft-dspark,
 *   ngram-simple, ngram-map-k, ngram-map-k4v, ngram-mod, ngram-cache
 *
 * 可用性规则：
 *   - draft-* 需要对应来源：内置 MTP 头（模型自带 nextn 层）或草稿模型文件
 *   - ngram-* 不需要任何额外模型，按上下文里的 n-gram 统计猜词
 */

const SPEC_TYPES = [
  { value: 'none', label: 'none（不加速）', kind: 'off' },
  { value: 'draft-mtp', label: 'draft-mtp（内置 MTP 头）', kind: 'mtp' },
  { value: 'draft-dflash', label: 'draft-dflash（DFlash 草稿）', kind: 'draft', archs: ['dflash'] },
  { value: 'draft-eagle3', label: 'draft-eagle3（EAGLE3 草稿）', kind: 'draft', archs: ['eagle3', 'eagle'] },
  { value: 'draft-dspark', label: 'draft-dspark（DSpark 草稿）', kind: 'draft', archs: ['dspark'] },
  { value: 'draft-simple', label: 'draft-simple（普通草稿模型）', kind: 'draft' },
  { value: 'ngram-simple', label: 'ngram-simple（无模型，n-gram）', kind: 'ngram' },
  { value: 'ngram-mod', label: 'ngram-mod（无模型，n-gram）', kind: 'ngram' },
  { value: 'ngram-cache', label: 'ngram-cache（无模型，缓存 n-gram）', kind: 'ngram' },
];

/** 从文件名粗略推断草稿架构（用户手填路径时用） */
function inferArchFromName(p) {
  const s = String(p || '').toLowerCase();
  if (s.includes('dflash')) return 'dflash';
  if (s.includes('eagle')) return 'eagle3';
  if (s.includes('dspark')) return 'dspark';
  if (s.includes('mtp')) return 'mtp';
  return null;
}

/** 找出当前选中的草稿模型（优先 params.specDraft，其次同目录草稿） */
function pickDraft(model, params) {
  const list = model?.companions?.draft || [];
  if (params?.specDraft) {
    const hit = list.find((d) => d.path === params.specDraft);
    if (hit) return hit;
    // 手填路径：按文件名推断架构，仍纳入能力判定
    return {
      path: params.specDraft,
      name: String(params.specDraft).split('/').pop(),
      arch: inferArchFromName(params.specDraft),
      manual: true,
    };
  }
  return list[0] || null;
}

/** 草稿模型架构 → 最匹配的 spec 类型 */
function specTypeForArch(arch) {
  const a = String(arch || '').toLowerCase();
  if (a.includes('dflash')) return 'draft-dflash';
  if (a.includes('eagle')) return 'draft-eagle3';
  if (a.includes('dspark')) return 'draft-dspark';
  if (a.includes('mtp')) return 'draft-mtp';
  return 'draft-simple';
}

/**
 * 某模型支持哪些投机解码类型。
 * @param {object} model 解析后的模型信息（含 hasMtp / companions）
 * @param {object} [params] 当前参数（用于识别已选草稿模型）
 * @returns {{options: {value,label,available,reason}[], draft: object|null, recommended: string}}
 */
function supportFor(model, params) {
  const draft = pickDraft(model, params);
  const hasMtp = !!model?.hasMtp;
  const draftArch = draft?.arch ? String(draft.arch).toLowerCase() : null;

  const options = SPEC_TYPES.map((t) => {
    if (t.kind === 'off' || t.kind === 'ngram') {
      return { value: t.value, label: t.label, available: true, reason: t.kind === 'ngram' ? '无需额外模型' : '' };
    }
    if (t.kind === 'mtp') {
      return {
        value: t.value,
        label: t.label,
        available: hasMtp || draftArch === 'mtp',
        reason: hasMtp
          ? '模型自带 MTP 层，无需草稿文件'
          : draftArch === 'mtp'
            ? '草稿模型是 MTP 类型'
            : '该模型没有 MTP 层，也不存在 MTP 草稿模型',
      };
    }
    // draft-*：需要草稿模型；带 archs 的还要架构匹配
    if (!draft) {
      return { value: t.value, label: t.label, available: false, reason: '未检测到配套的草稿模型文件' };
    }
    if (t.archs && (!draftArch || !t.archs.some((a) => draftArch.includes(a)))) {
      return {
        value: t.value,
        label: t.label,
        available: false,
        reason: `已配草稿架构为 ${draftArch}，应用 ${specTypeForArch(draftArch)}`,
      };
    }
    return { value: t.value, label: t.label, available: true, reason: `草稿模型：${draft.name || draft.path}` };
  });

  // 推荐值：有草稿 → 按其架构；否则有 MTP → draft-mtp；都没有 → none
  const recommended = draft ? specTypeForArch(draftArch) : hasMtp ? 'draft-mtp' : 'none';
  return { options, draft, recommended };
}

/** 过滤出可用取值（用于下拉框） */
function availableValues(model, params) {
  return supportFor(model, params)
    .options.filter((o) => o.available)
    .map((o) => o.value);
}

module.exports = { SPEC_TYPES, supportFor, availableValues, specTypeForArch, pickDraft, inferArchFromName };

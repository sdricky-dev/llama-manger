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
  // 兼容缺少 arch 的旧数据：退化为按文件名推断，
  // 否则 dflash 草稿会被误判成「普通草稿」→ 推荐 draft-simple（实测比不加速还慢一倍）
  const withArch = (d) => {
    if (d && !d.arch) d.arch = inferArchFromName(`${d.path || ''} ${d.name || ''}`);
    return d;
  };
  if (params?.specDraft) {
    const hit = list.find((d) => d.path === params.specDraft);
    if (hit) return withArch(hit);
    // 手填路径：按文件名推断架构，仍纳入能力判定
    return {
      path: params.specDraft,
      name: String(params.specDraft).split('/').pop(),
      arch: inferArchFromName(params.specDraft),
      manual: true,
    };
  }
  return list.length ? withArch(list[0]) : null;
}

/**
 * 草稿模型架构 → 最匹配的 spec 类型
 *
 * 注意：dflash / eagle3 / dspark 都是**专用实现**，各自有独立的草稿生成方式
 * （dflash 靠块扩散一次并行出多个 token）。用通用的 draft-simple 跑它们时，
 * 专用机制完全用不上 —— 实测 Qwen3.8-27B-DFlash2：draft-simple 接受率 0.4%
 * （283 个草稿只接受 1 个），生成 16.2 tok/s，比不开加速（32.4 tok/s）还慢一倍；
 * 换 draft-dflash 后接受率 51.6%，44.9 tok/s。
 */
function specTypeForArch(arch) {
  const a = String(arch || '').toLowerCase();
  if (a.includes('dflash')) return 'draft-dflash';
  if (a.includes('eagle')) return 'draft-eagle3';
  if (a.includes('dspark')) return 'draft-dspark';
  if (a.includes('mtp')) return 'draft-mtp';
  return 'draft-simple';
}

/** 是否有专用实现（这类架构不能退化成 draft-simple） */
function isSpecializedDraftArch(arch) {
  const a = String(arch || '').toLowerCase();
  return a.includes('dflash') || a.includes('eagle') || a.includes('dspark');
}

/**
 * 某模型支持哪些投机解码类型。
 * @param {object} model 解析后的模型信息（含 hasMtp / companions）
 * @param {object} [params] 当前参数（用于识别已选草稿模型）
 * @returns {{options: {value,label,available,reason}[], draft: object|null, recommended: string, hint: string|null}}
 */
function supportFor(model, params) {
  const draft = pickDraft(model, params);
  const hasMtp = !!model?.hasMtp;
  const draftArch = draft?.arch ? String(draft.arch).toLowerCase() : null;
  const specialized = isSpecializedDraftArch(draftArch);
  const matched = draft ? specTypeForArch(draftArch) : null;

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
    // draft-*：需要草稿模型
    if (!draft) {
      return { value: t.value, label: t.label, available: false, reason: '未检测到配套的草稿模型文件' };
    }
    // 通用 draft-simple：只在草稿架构未知/无专用实现时可用，
    // 否则会静默地跑出极低接受率（比不加速更慢）
    if (!t.archs) {
      if (specialized) {
        return {
          value: t.value,
          label: t.label,
          available: false,
          reason: `草稿是 ${draftArch} 架构（有专用实现），用通用 draft-simple 会完全用不上它 → 必须用 ${matched}（实测：draft-simple 接受率 0.4%，比不加速还慢一倍）`,
        };
      }
      return { value: t.value, label: t.label, available: true, reason: `草稿模型：${draft.name || draft.path}` };
    }
    // 专用类型：架构必须匹配
    if (!draftArch || !t.archs.some((a) => draftArch.includes(a))) {
      return {
        value: t.value,
        label: t.label,
        available: false,
        reason: `已配草稿架构为 ${draftArch}，应用 ${matched}`,
      };
    }
    return { value: t.value, label: t.label, available: true, reason: `草稿模型：${draft.name || draft.path}` };
  });

  // 推荐值：有草稿 → 按其架构（含专用匹配）；否则有 MTP → draft-mtp；都没有 → none
  const recommended = draft ? matched : hasMtp ? 'draft-mtp' : 'none';

  // 同时有内置 MTP 与草稿模型时，速度取决于模型，提示用户实测对比
  const hint =
    hasMtp && draft && draftArch !== 'mtp'
      ? `该模型同时有内置 MTP 与配套草稿（${draftArch}）：两者速度取决于模型，建议各跑一次对比。本机实测（Qwen3.8-27B + DFlash2，256K/q8_0）：draft-mtp 52 tok/s（接受率 68%）略快于 draft-dflash 44 tok/s（接受率 52%），而 draft-dflash 把 --spec-draft-n-max 从 3 调到 8 可到 52 tok/s；draft-mtp 调大反而变慢（8→39、16→19 tok/s）。`
      : null;

  return { options, draft, recommended, hint };
}

/** 过滤出可用取值（用于下拉框） */
function availableValues(model, params) {
  return supportFor(model, params)
    .options.filter((o) => o.available)
    .map((o) => o.value);
}

module.exports = {
  SPEC_TYPES,
  supportFor,
  availableValues,
  specTypeForArch,
  isSpecializedDraftArch,
  pickDraft,
  inferArchFromName,
};

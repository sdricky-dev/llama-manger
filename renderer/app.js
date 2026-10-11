/**
 * LlamaManger 渲染层逻辑
 */
import { PARAMS, GROUPS, fmtGB, GB } from './i18n.js';
import { showMenu } from './ctxmenu.js';
import { baseName, dirOf, joinPath } from './paths.js';

const $ = (id) => document.getElementById(id);
const api = window.lm;

/* ---------------- 状态 ---------------- */
const state = {
  hw: null,
  models: [],
  companions: [],
  orphans: [],
  autoPaired: null,
  specOptions: null,
  specRecommended: 'none',
  model: null,
  mode: 'server',
  params: null,
  rec: null, // 最近一次一键推荐
  notes: [],
  mem: null,
  serverUrl: null,
  serverState: 'stopped',
  advanced: false,
  config: null,
  chatHistory: [],
};

const ALL_KEYS = Object.keys(PARAMS);

function defaultParams() {
  const p = {};
  for (const k of ALL_KEYS) {
    const d = PARAMS[k];
    p[k] = d.def !== undefined ? d.def : d.type === 'check' ? false : 0;
  }
  p.ngl = 'auto';
  return p;
}

state.params = defaultParams();

/* ---------------- 工具 ---------------- */
function gb(bytes) {
  return (bytes / GB).toFixed(2);
}
function fmtCtx(n) {
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024}K`;
  return String(n);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function log(text) {
  const c = $('console');
  c.textContent += text;
  c.scrollTop = c.scrollHeight;
}

/* ---------------- 轻提示 (toast) ---------------- */
let toastTimer = null;
function toast(msg, kind) {
  const t = $('toast');
  if (!t) return;
  t.className = `toast${kind ? ' ' + kind : ''}`;
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), kind === 'bad' ? 6000 : 2600);
}
const hideToast = () => $('toast')?.classList.add('hidden');

/* ---------------- 路径工具（见 paths.js） ---------------- */

/** 在系统文件管理器中定位文件 / 打开目录，并给出提示 */
async function revealPath(p, mode) {
  if (!p) return;
  let r;
  try {
    r = await api.fs.reveal(p, mode);
  } catch (err) {
    r = { ok: false, error: err.message };
  }
  if (r && r.ok) {
    toast(
      mode === 'dir'
        ? `已打开文件夹：${r.path}`
        : `已在文件夹中定位：${baseName(r.path)}`,
      'ok'
    );
  } else {
    toast(`打开失败：${(r && r.error) || '未知错误'}`, 'bad');
  }
}

/** 复制文本到系统剪贴板（走主进程，窗口失焦也不会失败） */
async function copyText(text, label) {
  const s = String(text ?? '');
  let r;
  try {
    r = await api.clipboard.write(s);
  } catch (err) {
    r = { ok: false, error: err.message };
  }
  if (r && r.ok) toast(`${label || '内容'}已复制到剪贴板`, 'ok');
  else toast(`复制失败：${(r && r.error) || '未知错误'}`, 'bad');
  return r;
}

async function copyPath(p) {
  return copyText(p, '路径');
}

/** 文件级右键菜单项：在文件夹中显示 / 打开所在文件夹 / 复制路径 */
function fileMenuItems(p, opts = {}) {
  return [
    {
      icon: '📂',
      label: opts.selectLabel || '在文件夹中显示（高亮文件）',
      hint: p,
      onClick: () => revealPath(p, 'select'),
    },
    { icon: '🗂', label: '打开所在文件夹', hint: dirOf(p), onClick: () => revealPath(p, 'dir') },
    { type: 'sep' },
    { icon: '📋', label: '复制完整路径', hint: p, onClick: () => copyPath(p) },
  ];
}

/** 某个模型（含其附属文件）的右键菜单；subject 为被右键的具体文件路径 */
function modelMenu(m, subject) {
  const files = [
    { path: m.path, kind: '主模型' },
    ...(m.companions?.mmproj || []).map((x) => ({ path: x.path, kind: '视觉投影' })),
    ...(m.companions?.draft || []).map((x) => ({ path: x.path, kind: '草稿模型' })),
  ].filter((f) => f.path);
  const cur = files.find((f) => f.path === subject) || files[0];
  const items = [
    { type: 'head', label: baseName(cur.path), sub: cur.path },
    ...fileMenuItems(cur.path, {
      selectLabel: cur.kind === '主模型' ? '在文件夹中显示（高亮文件）' : `在文件夹中显示 · ${cur.kind}`,
    }),
  ];
  const others = files.filter((f) => f.path !== cur.path);
  if (others.length) {
    items.push({ type: 'sep' }, { type: 'note', label: '同目录附属文件' });
    for (const f of others) {
      items.push({
        icon: '📂',
        label: `${f.kind} · ${baseName(f.path)}`,
        hint: f.path,
        onClick: () => revealPath(f.path, 'select'),
      });
    }
    const curDir = dirOf(cur.path);
    const dirs = [...new Set(others.map((f) => dirOf(f.path)).filter((d) => d && d !== curDir))];
    for (const d of dirs) {
      items.push({ icon: '🗂', label: `打开 ${baseName(d)}`, hint: d, onClick: () => revealPath(d, 'dir') });
    }
  }
  return items;
}
let updateTimer = null;
function scheduleUpdate() {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(updateDynamic, 150);
}

/* ---------------- 硬件 ---------------- */
async function scanHw() {
  $('hwCard').innerHTML = '<div class="hw-loading">检测硬件中…</div>';
  state.hw = await api.hw.scan();
  const h = state.hw;
  const gpuName = h.gpu ? h.gpu.name : '—';
  const gpuExtra = h.gpu?.cores ? ` · ${h.gpu.cores} 核` : '';
  const metal = h.gpu?.metal ? ` · ${h.gpu.metal}` : '';
  $('hwCard').innerHTML = `
    <div class="hw-item"><b>${esc(h.chip)}</b><span>芯片</span></div>
    <div class="hw-item"><b>${h.pCores}P + ${h.eCores}E</b><span>${h.totalCores} 核 CPU</span></div>
    <div class="hw-item"><b>${h.ramGB.toFixed(0)} GB${h.freeGB ? ` / 可用 ${h.freeGB.toFixed(0)} GB` : ''}</b><span>统一内存</span></div>
    <div class="hw-item"><b>${esc(gpuName)}${gpuExtra}${metal}</b><span>GPU</span></div>
    <div class="hw-refresh" id="hwRefresh" title="重新检测">⟳</div>`;
  $('hwRefresh').onclick = scanHw;
}

/* ---------------- 模型 ---------------- */
async function scanModels() {
  const dir = $('modelDir').value.trim();
  if (!dir) return;
  const list = $('modelList');
  list.innerHTML = '<div class="empty">扫描中…</div>';
  const { models, companions, orphans, warnings, decisionTypes } = await api.models.scan(dir);
  state.models = models;
  state.companions = companions || [];
  state.orphans = orphans || [];
  state.decisionTypes = decisionTypes || [];
  list.innerHTML = '';
  if (models.length === 0) {
    list.innerHTML = '<div class="empty">该目录下没有找到可用的 .gguf 模型文件</div>';
  }
  for (const m of models) {
    const el = document.createElement('div');
    el.className = 'model-item';
    el.dataset.path = m.path;
    const c = m.companions || { mmproj: [], draft: [] };
    const attach = [
      ...c.mmproj.map((x) => `<span class="tag attach" data-file="${esc(x.path)}" title="${esc(x.path)}（右键可打开所在目录）">👁 视觉投影 ${gb(x.sizeBytes)} GB (${esc(x.quant)})</span>`),
      ...c.draft.map((x) => `<span class="tag attach" data-file="${esc(x.path)}" title="${esc(x.path)}（右键可打开所在目录）">⚡ 草稿 ${esc(x.quant)} ${gb(x.sizeBytes)} GB</span>`),
    ].join('');
    el.innerHTML = `
      <button class="m-more" title="更多操作：在文件夹中显示 / 复制路径（右键模型同样可用）">⋯</button>
      <div class="m-name" data-file="${esc(m.path)}" title="${esc(m.path)}">${esc(m.name)}</div>
      <div class="m-meta">
        <span class="tag">${esc(m.quant)}</span>
        <span class="tag">${gb(m.sizeBytes)} GB</span>
        <span class="tag">${m.nLayer} 层${m.nAttnLayer && m.nAttnLayer !== m.nLayer ? `(注意力${m.nAttnLayer})` : ''}</span>
        <span class="tag">训练 ${fmtCtx(m.ctxTrain) || '—'}</span>
        ${m.isMoe ? `<span class="tag" style="color:var(--accent2)">MoE ${m.expertCount}e</span>` : ''}
        ${m.decisionType ? `<span class="tag ${m.decisionSupported ? 'attach' : 'bad'}" title="decision（判决/打分）模型：${esc(m.decisionType)}">🎯 判决模型 ${esc(m.decisionType)}${m.decisionSupported ? (m.decisionAlias ? `（别名→${m.decisionAlias}）` : '') : '（引擎不支持）'}</span>` : ''}
        ${attach}
      </div>`;
    el.onclick = () => selectModel(m, el);
    // 右键：菜单作用于被点中的那个文件（模型本身，或它下面的附属标签）
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const hit = e.target.closest?.('[data-file]');
      showMenu(e.clientX, e.clientY, modelMenu(m, hit ? hit.dataset.file : m.path));
    });
    const more = el.querySelector('.m-more');
    more.onclick = (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      showMenu(r.right - 6, r.bottom + 4, modelMenu(m, m.path));
    };
    list.appendChild(el);
  }
  // 扫描提示：未配对附属文件做成可点击/右键的标签，方便直接去目录里核对
  const w = $('modelWarnings');
  w.textContent = '';
  if (orphans && orphans.length) {
    const line = document.createElement('div');
    line.className = 'warn-line';
    line.append(`⚠ 已忽略 ${orphans.length} 个未配对的附属文件（点击定位文件，右键更多操作）：`);
    for (const o of orphans) {
      const t = document.createElement('span');
      t.className = 'tag orphan';
      t.dataset.file = o.path;
      t.title = `${o.path}\n${gb(o.sizeBytes)} GB · 未与任何主模型同目录，因此不会被自动配对`;
      t.textContent = baseName(o.path);
      t.onclick = () => revealPath(o.path, 'select');
      line.appendChild(t);
    }
    w.appendChild(line);
  }
  if (warnings.length) {
    const line = document.createElement('div');
    line.className = 'warn-line';
    line.textContent = '⚠ ' + warnings.join('；');
    w.appendChild(line);
  }
  w.classList.toggle('hidden', !w.childElementCount);
  w.oncontextmenu = (e) => {
    const hit = e.target.closest?.('[data-file]');
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    const p = hit.dataset.file;
    showMenu(e.clientX, e.clientY, [
      { type: 'head', label: baseName(p), sub: p },
      ...fileMenuItems(p),
    ]);
  };
  // 恢复上次选择
  if (state.model) {
    const el = list.querySelector(`[data-path="${CSS.escape(state.model.path)}"]`);
    if (el) selectModel(state.model, el, true);
  }
}

/** 依据草稿模型架构推断投机解码类型（与 shared/spec.js 保持一致，仅用于本地提示） */
function specTypeForDraft(draft) {
  if (!draft) return 'none';
  const key = `${draft.arch || ''} ${draft.path || ''}`.toLowerCase();
  if (key.includes('dflash')) return 'draft-dflash';
  if (key.includes('eagle')) return 'draft-eagle3';
  if (key.includes('dspark')) return 'draft-dspark';
  if (key.includes('mtp')) return 'draft-mtp';
  return 'draft-simple';
}

function selectModel(m, el, silent) {
  state.model = m;
  document.querySelectorAll('.model-item').forEach((x) => x.classList.remove('selected'));
  el?.classList.add('selected');
  const info = $('modelInfo');
  info.classList.remove('hidden');
  const c = m.companions || { mmproj: [], draft: [] };
  // 自动配对同目录的视觉投影 / 草稿模型
  const mm = c.mmproj[0];
  state.params.mmproj = mm ? mm.path : '';
  const dr = c.draft[0];
  state.params.specDraft = dr ? dr.path : '';
  syncSpecOptions(); // 拉取该模型支持的投机解码类型，并纠正非法取值
  state.autoPaired = { mmproj: !!mm, draft: !!dr };
  info.innerHTML = `
    <span class="mi">架构 <b>${esc(m.arch)}</b></span>
    <span class="mi">层数 <b>${m.nLayer}</b>${m.nAttnLayer && m.nAttnLayer !== m.nLayer ? `（注意力 ${m.nAttnLayer}）` : ''}</span>
    <span class="mi">嵌入维度 <b>${m.nEmb}</b> (${m.nHead}头/${m.nKvHead}KV头)</span>
    <span class="mi">头维 <b>${m.headDim}</b></span>
    <span class="mi">训练上下文 <b>${m.ctxTrain || '—'}</b></span>
    <span class="mi">量化 <b>${esc(m.quant)}</b>${m.fileTypeLabel && m.fileTypeLabel !== m.quant ? `<span class="dim">（元数据 ${esc(m.fileTypeLabel)} 不准）</span>` : ''}</span>
    ${m.isMoe ? `<span class="mi">专家 <b>${m.expertCount}</b>（共享 ${m.expertShared}）</span>` : ''}
    ${m.hasMtp ? `<span class="mi">内置 MTP <b>是</b></span>` : ''}
    ${m.decisionType ? `<span class="mi ${m.decisionSupported ? 'ok' : 'bad'}">判决模型 <b>${esc(m.decisionType)}</b>${m.decisionSupported ? (m.decisionAlias ? `（别名 → ${esc(m.decisionAlias)}）` : '') : '（当前引擎不支持）'}</span>` : ''}
    <span class="mi">大小 <b>${gb(m.sizeBytes)} GB</b></span>
    ${mm ? `<span class="mi ok">已配对视觉投影 <b>${gb(mm.sizeBytes)} GB</b></span>` : ''}
    ${dr ? `<span class="mi ok">已配对草稿模型 <b>${esc(dr.quant)} ${gb(dr.sizeBytes)} GB</b></span>` : ''}
    ${m.hasMtp || dr ? `<span class="mi">可加速 <b>${state.params.specType === 'none' ? '未开启（可开启）' : state.params.specType}</b></span>` : ''}`;
  if (!silent) {
    renderParams();
    saveConfig();
    scheduleUpdate();
  }
}

/** 拉取当前模型支持的投机解码类型；若当前取值不被支持则落到推荐值 */
async function syncSpecOptions() {
  if (!state.model) return;
  const r = await api.spec.options({ model: state.model, params: state.params });
  state.specOptions = r.options;
  state.specRecommended = r.recommended;
  const available = r.options.filter((o) => o.available).map((o) => o.value);
  if (!available.includes(state.params.specType)) {
    state.params.specType = r.recommended;
  }
  renderParams();
}

/* ---------------- 参数渲染 ---------------- */
function controlFor(key, p) {
  const d = PARAMS[key];
  const val = state.params[key];
  switch (d.type) {
    case 'ngl': {
      const mode = val === 'auto' ? 'auto' : val === 'all' ? 'all' : 'num';
      return `
        <select data-k="${key}">
          <option value="auto" ${mode === 'auto' ? 'selected' : ''}>auto（引擎自动）</option>
          <option value="all" ${mode === 'all' ? 'selected' : ''}>all（全部层）</option>
          <option value="num" ${mode === 'num' ? 'selected' : ''}>自定义…</option>
        </select>
        <input type="number" data-k="${key}-num" min="0" max="512" step="1"
          value="${mode === 'num' ? val : ''}" placeholder="层数"
          ${mode === 'num' ? '' : 'disabled'} style="width:80px">`;
    }
    case 'ctx': {
      // 档位上限跟随模型训练长度（超过训练长度需要 YaRN，默认不提供按钮）
      const presets = ctxPresets();
      return `
        <input type="number" data-k="${key}" min="${d.min}" max="${d.max}" step="${d.step}" value="${val}">
        <span class="ctx-presets">${presets.map((c) =>
          `<button data-ctx="${c}" class="${Number(val) === c ? 'active' : ''}">${fmtCtx(c)}</button>`).join('')}
          <span class="ctx-cap" title="模型训练上下文长度">训练上限 ${state.model?.ctxTrain ? fmtCtx(state.model.ctxTrain) : '—'}</span></span>`;
    }
    case 'select': {
      // 投机解码类型：只列当前模型真正支持的取值
      if (key === 'specType' && state.specOptions) {
        const avail = state.specOptions.filter((o) => o.available);
        const unusable = state.specOptions.filter((o) => !o.available);
        const opts = avail.map((o) =>
          `<option value="${o.value}" ${String(val) === o.value ? 'selected' : ''} title="${esc(o.reason || '')}">${esc(o.label)}</option>`).join('');
        const note = avail.length <= 1
          ? '<span class="spec-note">该模型不支持投机解码（无 MTP 层、无草稿模型）</span>'
          : unusable.length
            ? `<span class="spec-note" title="${esc(unusable.map((o) => `${o.value}: ${o.reason}`).join('；'))}">已隐藏 ${unusable.length} 项不可用（${unusable.map((o) => esc(o.value)).join('、')}）</span>`
            : '';
        return `<select data-k="${key}">${opts}</select>${note}`;
      }
      return `<select data-k="${key}">${d.options.map((o) =>
        `<option value="${o}" ${String(val) === String(o) ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
    }
    case 'check':
      return `<input type="checkbox" data-k="${key}" ${val ? 'checked' : ''}>`;
    case 'number':
      return `<input type="number" data-k="${key}" min="${d.min ?? 0}" max="${d.max ?? 1e9}" step="${d.step ?? 1}" value="${val}">`;
    case 'text':
    default:
      return `<input type="text" data-k="${key}" value="${esc(val)}" spellcheck="false">`;
  }
}

/** 当前模型可用的上下文档位（不超过训练长度；非整档时补一档） */
function ctxPresets() {
  const cap = state.model?.ctxTrain > 0 ? state.model.ctxTrain : 131072;
  const base = [4096, 8192, 16384, 32768, 65536, 98304, 131072, 196608, 262144].filter((c) => c <= cap);
  if (cap >= 4096 && !base.includes(cap)) base.push(cap);
  return base.length ? base : [4096];
}

function recBadge(key) {
  if (!state.rec) return '';
  const v = state.rec.params[key];
  if (v === undefined || v === null) return '';
  const s = typeof v === 'boolean' ? (v ? '开' : '关') : String(v);
  return `<span class="rec-badge" data-rec="${key}" title="点击应用推荐值 ${esc(s)}">荐: ${esc(s.length > 18 ? s.slice(0, 16) + '…' : s)}</span>`;
}

function renderParams() {
  const root = $('paramGroups');
  root.innerHTML = '';
  for (const g of GROUPS) {
    if (g.advanced && !state.advanced) continue;
    if (g.mode && g.mode !== state.mode) continue;
    const div = document.createElement('div');
    div.className = 'param-row-group param-group';
    div.dataset.group = g.id;
    div.innerHTML = `<h3>${g.name}</h3>`;
    for (const key of g.params) {
      const d = PARAMS[key];
      if (d.showIf && !d.showIf(state)) continue;
      const row = document.createElement('div');
      row.className = 'param-row';
      row.dataset.p = key;
      row.innerHTML = `
        <div class="p-label" data-k="${key}">
          ${d.label}<span class="flag">${d.flag}</span>
          <div class="tip">${d.desc}</div>
        </div>
        <div class="p-control" data-ctl="${key}">${controlFor(key)} ${recBadge(key)}</div>
        ${d.related ? `<div class="p-related">⤷ ${d.related}</div>` : ''}`;
      div.appendChild(row);
    }
    root.appendChild(div);
  }
  bindParamEvents();
}

function bindParamEvents() {
  const root = $('paramGroups');
  root.querySelectorAll('input, select').forEach((el) => {
    const ev = el.type === 'checkbox' || el.type === 'number' || el.type === 'text' ? 'input' : 'change';
    el.addEventListener(ev, () => {
      const k = el.dataset.k;
      if (k === 'ngl') {
        // 联动：num 输入框启用
        const num = root.querySelector('[data-k="ngl-num"]');
        if (el.value === 'num') {
          el.value = 'num';
          num.disabled = false;
          num.value = state.params.ngl === 'num' ? '' : state.params.ngl;
          state.params.ngl = num.value === '' ? 'all' : Number(num.value);
        } else {
          num.disabled = true;
          state.params.ngl = el.value;
        }
        afterParamChange();
        return;
      }
      if (k === 'ngl-num') {
        state.params.ngl = el.value === '' ? 'all' : Number(el.value);
        afterParamChange();
        return;
      }
      if (k === 'ctx') {
        state.params.ctx = Number(el.value) || 0;
        root.querySelectorAll('[data-ctx]').forEach((b) =>
          b.classList.toggle('active', Number(b.dataset.ctx) === state.params.ctx));
        afterParamChange();
        return;
      }
      const v = el.type === 'checkbox' ? el.checked : el.value;
      state.params[k] = el.type === 'number' ? Number(v) : v;
      if (k === 'slotSavePath') refreshSlots();
      afterParamChange();
    });
  });
  root.querySelectorAll('[data-ctx]').forEach((b) =>
    b.addEventListener('click', () => {
      state.params.ctx = Number(b.dataset.ctx);
      renderParams();
      afterParamChange();
    }));
  root.querySelectorAll('[data-rec]').forEach((b) =>
    b.addEventListener('click', () => {
      const k = b.dataset.rec;
      state.params[k] = state.rec.params[k];
      renderParams();
      afterParamChange();
    }));
}

function afterParamChange() {
  renderParams();
  scheduleUpdate();
  saveConfig();
}

/* ---------------- 动态计算：内存 / 提示 / 命令 / 换算 ---------------- */
async function updateDynamic() {
  updateTimer = null;
  const { model, params, hw, mode } = state;

  // 命令预览
  if (model) {
    const { text } = await api.args.build({ params, modelPath: model.path, mode });
    $('cmdPreview').textContent = text;
  } else {
    $('cmdPreview').textContent = '—（选择模型后生成）';
  }

  // 内存估算
  if (model && hw) {
    state.mem = await api.mem.estimate({ model, params, hw });
    renderMem();
  } else {
    state.mem = null;
    $('memEmpty').classList.remove('hidden');
    $('memBody').classList.add('hidden');
  }
  renderHints();
}

function renderMem() {
  const m = state.mem;
  if (!m) return;
  $('memEmpty').classList.add('hidden');
  $('memBody').classList.remove('hidden');
  const total = m.usable;
  const pct = (v) => Math.max(0, Math.min(100, (v / total) * 100));
  // ---------- 独立显卡（PC）：显存 / 内存 两条独立预算 ----------
  if (m.mode === 'discrete') {
    const row = (label, side) => {
      const p = (v) => Math.max(0, Math.min(100, (v / side.total) * 100));
      const segs = [
        ['gpu', side.weights],
        ['kv', side.kv],
        ['comp', side.compute],
      ];
      return `<div class="memrow">
        <div class="memrow-label">${label} <b>${gb(side.used)} / ${gb(side.total)}</b></div>
        <div class="mem-bar">${segs
          .map(([cls, v]) => `<div class="seg ${cls}" style="width:${p(v)}%" title="${gb(v)} GB"></div>`)
          .join('')}</div>
      </div>`;
    };
    $('memBar').className = 'mem-rows';
    $('memBar').innerHTML =
      row(`显存 ${(state.hw?.gpu?.vramGB || 0).toFixed(0)} GB`, m.vram) + row('系统内存', m.ram);
    $('memLegend').innerHTML = [
      ['var(--gpu)', '权重（显存）', m.vram.weights],
      ['var(--kv)', `KV 缓存（${m.vram.kv > 0 ? '显存' : '内存'}）`, m.vram.kv || m.ram.kv],
      ['var(--cpu)', '权重（内存）', m.ram.weights],
      ['var(--comp)', '计算缓冲', m.vram.compute + m.ram.compute],
      ['var(--free)', '两侧较小余量', Math.max(0, m.free)],
    ]
      .map(([c, label, v]) => `<div class="lg"><span class="dot" style="background:${c}"></span>${label}<b>${gb(v)} GB</b></div>`)
      .join('');
    const st = $('memStatus');
    const extra = (m.wMmproj || 0) + (m.wDraft || 0);
    const vramTxt = `显存 ${gb(m.vram.used)}/${gb(m.vram.total)}（余 ${gb(Math.max(0, m.vram.free))}）`;
    const ramTxt = `内存 ${gb(m.ram.used)}/${gb(m.ram.total)}（余 ${gb(Math.max(0, m.ram.free))}）`;
    st.className = `mem-status ${m.ok ? 'ok' : 'bad'}`;
    st.textContent = `${m.ok ? '✓' : '✗'} ${vramTxt} · ${ramTxt}${extra ? ` · 含附属文件 ${gb(extra)}` : ''}`;
    const { params } = state;
    $('cvCtx').textContent = fmtCtx(params.ctx);
    $('cvKv').textContent = gb(m.kv);
    updateMaxCtx();
    return;
  }

  const segs = [
    ['gpu', m.wGpu],
    ['cpu', m.wCpu],
    ['kv', m.kv],
    ['comp', m.compute],
  ];
  $('memBar').className = 'mem-bar';
  $('memBar').innerHTML = segs
    .map(([cls, v]) => `<div class="seg ${cls}" style="width:${pct(v)}%" title="${gb(v)} GB"></div>`)
    .join('');
  const legend = [
    ['var(--gpu)', 'GPU 常驻权重', m.wGpu],
    ['var(--cpu)', '内存池权重', m.wCpu],
    ['var(--kv)', 'KV 缓存', m.kv],
    ['var(--comp)', '计算缓冲', m.compute],
    ['var(--free)', '空闲', Math.max(0, m.free)],
  ];
  // 附属文件计入的额外常驻内存（已包含在 GPU/内存池权重里）
  if (m.wMmproj > 0) legend.splice(4, 0, ['var(--accent2)', '└ 视觉投影 mmproj', m.wMmproj]);
  if (m.wDraft > 0) legend.splice(legend.length - 1, 0, ['var(--accent2)', '└ 草稿模型', m.wDraft]);
  $('memLegend').innerHTML = legend
    .map(([c, label, v]) => `<div class="lg"><span class="dot" style="background:${c}"></span>${label}<b>${gb(v)} GB</b></div>`)
    .join('');
  const st = $('memStatus');
  const extra = (m.wMmproj || 0) + (m.wDraft || 0);
  if (m.ok) {
    st.className = 'mem-status ok';
    st.textContent = `✓ 总占用 ${gb(m.total)} GB，可用内存内余量 ${gb(m.free)} GB${extra ? `（含附属文件 ${gb(extra)} GB）` : ''}`;
  } else {
    st.className = 'mem-status bad';
    st.textContent = `✗ 总占用 ${gb(m.total)} GB，超出可用内存 ${gb(-m.free)} GB`;
  }
  // 换算
  const { params, model } = state;
  $('cvCtx').textContent = fmtCtx(params.ctx);
  $('cvKv').textContent = gb(m.kv);
  updateMaxCtx();
}

function updateMaxCtx() {
  const { model, params, hw, mem } = state;
  const budget = Number($('cvBudget').value);
  if (!model || !hw) {
    $('cvMaxCtx').textContent = '—';
    return;
  }
  const k = params.cacheTypeK || 'f16';
  const v = params.cacheTypeV || 'f16';
  const KV_ELEM = { f32: 4, f16: 2, bf16: 2, q8_0: 1.03, q4_0: 0.53, q4_1: 0.56, iq4_nl: 0.75, q5_0: 0.69, q5_1: 0.72 };
  // 混合 SSM/注意力架构只按注意力层计 KV（与 recommend.js 一致）
  const layers = model.nAttnLayer || model.nLayer;
  const perTok = layers * model.nKvHead * model.headDim * ((KV_ELEM[k] ?? 2) + (KV_ELEM[v] ?? 2));
  const par = params.parallel || 1;

  // PC（独立显卡）：显存与内存各自都要装得下
  if (mem && mem.mode === 'discrete') {
    // 最大上下文由主进程按「显存 + 内存」双预算算好（渲染层不重复 KV 数学，避免口径不一致）
    $('cvMaxCtx').textContent = mem.maxCtx > 0 ? fmtCtx(mem.maxCtx) : '不足 256';
    return;
  }

  // 统一内存（Apple Silicon）：按内存预算（可手动调整的 budget）
  if (!budget || budget <= 0) {
    $('cvMaxCtx').textContent = '—';
    return;
  }
  const W = model.sizeBytes + (mem?.wMmproj || 0) + (mem?.wDraft || 0);
  let lo = 256, hi = 1048576, best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((W + perTok * mid * par + 2e9) / 1e9 <= budget) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  $('cvMaxCtx').textContent = best > 0 ? fmtCtx(best) : '不足 256';
}

/* ---------------- 关联提示 ---------------- */
function computeHints() {
  const hints = [...state.notes.map((t) => ({ level: 'info', text: t }))];
  const { params: p, model, hw, mem } = state;
  if (!model) return hints;

  if (p.ctx > model.ctxTrain && model.ctxTrain > 0 && p.ropeScaling === 'none') {
    hints.push({
      level: 'warn',
      text: `上下文 ${fmtCtx(p.ctx)} 超过模型训练长度 ${fmtCtx(model.ctxTrain)}，超出部分质量会下降。建议开启 YaRN 外推。`,
      fix: { label: '开启 YaRN', apply: () => { p.ropeScaling = 'yarn'; p.yarnOrigCtx = model.ctxTrain; } },
    });
  }
  if (mem && !mem.ok) {
    hints.push({
      level: 'error',
      text: `估算总内存 ${gb(mem.total)} GB 超出可用 ${gb(mem.usable)} GB，引擎可能启动失败或系统卡顿。`,
      fixes: [
        { label: '降上下文一档', apply: () => { p.ctx = Math.max(4096, Math.floor(p.ctx / 2)); } },
        { label: 'KV 改 q8_0', apply: () => { p.cacheTypeK = 'q8_0'; p.cacheTypeV = 'q8_0'; } },
        ...(model.isMoe ? [{ label: 'MoE 专家全留 CPU', apply: () => { p.nCpuMoe = model.nLayer; } }] : []),
      ],
    });
  }
  if (p.parallel > 1) {
    hints.push({ level: 'info', text: `并行序列 = ${p.parallel}：KV 缓存内存 ×${p.parallel}，上下文与内存预算需同步考虑。` });
  }
  if (hw?.pCores > 0 && p.threads > hw.pCores) {
    hints.push({ level: 'info', text: `生成线程 ${p.threads} 超过 P 核数（${hw.pCores}）：Apple Silicon 上 E 核对逐 token 生成贡献有限。` });
  }
  if (model.isMoe && p.nCpuMoe === 0 && mem && mem.wGpu / 1e9 > mem.usable / 1e9 * 0.75) {
    hints.push({
      level: 'warn',
      text: 'MoE 模型全部上 GPU 会占用大量统一内存，建议将专家层留在内存池。',
      fix: { label: `专家层留 CPU（${model.nLayer}）`, apply: () => { p.nCpuMoe = model.nLayer; } },
    });
  }
  if (p.cacheTypeK !== 'f16' || p.cacheTypeV !== 'f16') {
    hints.push({ level: 'info', text: `量化 KV（K:${p.cacheTypeK} / V:${p.cacheTypeV}）：省内存，质量损失很小；Metal 的 Flash Attention 已支持 q8_0 KV。` });
  }
  if (p.batch > 4096) {
    hints.push({ level: 'info', text: `batch=${p.batch} 较大：提示词处理阶段峰值内存升高，长提示词场景才需要。` });
  }
  if (p.ubatch > p.batch) {
    hints.push({ level: 'warn', text: `ubatch(${p.ubatch}) 大于 batch(${p.batch})，请调整（ubatch 应 ≤ batch）。` });
  }
  if (mode_is('server') && p.apiKey) {
    hints.push({ level: 'info', text: '已设置 API Key：外部调用需携带 Authorization: Bearer <key>。' });
  }
  // ---- 附属文件（视觉投影 / 草稿模型）----
  if (p.mmproj) {
    const mm = (model.companions?.mmproj || []).find((x) => x.path === p.mmproj);
    const isVisionText = model.arch === 'clip';
    if (!mm && !p.mmproj.endsWith('.gguf')) {
      hints.push({ level: 'warn', text: 'mmproj 路径看起来不是 .gguf 文件，请确认。' });
    }
    if (mm && model.nLayer > 0) {
      hints.push({
        level: 'info',
        text: `已启用视觉：将加载 mmproj（${gb(mm.sizeBytes)} GB${mm.vision?.imageSize ? `，图片输入 ${mm.vision.imageSize}px` : ''}）。纯文本对话不受影响；发送图片请在请求里带 image_url。`,
      });
    }
    if (!mm) hints.push({ level: 'info', text: '已手动指定 mmproj 路径（非自动配对），请确认它与当前模型配套。' });
  }
  if (p.specDraft && p.specType === 'none') {
    hints.push({
      level: 'warn',
      text: '已指定草稿模型但没有选择投机解码类型，草稿模型不会生效。',
      fix: { label: `设为 ${state.specRecommended}`, apply: () => { p.specType = state.specRecommended; } },
    });
  }
  if (p.specDraft && p.specType !== 'none') {
    const dr = (model.companions?.draft || []).find((x) => x.path === p.specDraft);
    const sizeGB = dr ? gb(dr.sizeBytes) : '?';
    hints.push({
      level: 'info',
      text: `投机解码已开启（${p.specType}，草稿 ${sizeGB} GB）：草稿先猜、主模型校验，理论上限约 2–3×；猜中率低时提升有限。若加载报错先清空草稿模型。`,
    });
  }
  if (!p.specDraft && model.hasMtp) {
    hints.push({
      level: 'info',
      text: '该模型内置 MTP 头（无需草稿文件）：投机解码类型选 draft-mtp 即可启用内置加速。',
      fix: { label: '启用内置 MTP', apply: () => { p.specDraft = ''; p.specType = 'draft-mtp'; } },
    });
  }
  // 该模型完全不具备加速能力时，说明下拉框为何只有 none
  if (state.specOptions && state.specOptions.filter((o) => o.available).length <= 1 && p.specType === 'none') {
    hints.push({
      level: 'info',
      text: '该模型没有内置 MTP 层，也没有配套草稿模型：投机解码类型只有 none（下拉框已隐藏不可用项）。',
    });
  }
  // ---- decision（判决/打分）模型 ----
  if (model.decisionType && model.decisionSupported === false) {
    const supported = (state.decisionTypes || []).join(' / ') || '有限几种';
    hints.push({
      level: 'error',
      text: `该模型声明为 decision 判决模型（类型 "${model.decisionType}"），当前引擎只认 ${supported}；加载时会直接失败（unsupported decision model type），cli 与 server 都一样。${model.decisionTemplate ? '不过它的 systemone 模板与 decision 元数据都齐全，很可能只是类型名版本不同（如 openjev ↔ jev），可用引擎侧别名补丁解决（scripts/patches/decision-type-jev-alias.patch）。' : '该模型还缺少 systemone 模板，需要引擎更新才能支持。'}`,
    });
  }
  if (model.decisionAlias) {
    hints.push({
      level: 'info',
      text: `判决模型类型 "${model.decisionType}" 通过别名映射到 "${model.decisionAlias}"（引擎已打补丁）。换回未打补丁的引擎构建会加载失败。`,
    });
  }
  if (model.decisionType && model.decisionSupported) {
    hints.push({
      level: 'info',
      text: '判决模型走 /v1/systemone 接口（state + questions → 选项/分数），下方聊天面板用的是 /v1/chat/completions，不适合判决任务。',
    });
  }
  if (model.decisionTemplate && !model.decisionType) {
    hints.push({ level: 'info', text: '该模型带 systemone 模板，但未声明 decision 类型，按普通对话模型使用。' });
  }
  return hints;
}
function mode_is(m) { return state.mode === m; }

function renderHints() {
  const box = $('hints');
  const hints = computeHints();
  box.innerHTML = '';
  for (const h of hints) {
    const el = document.createElement('div');
    el.className = `hint ${h.level}`;
    const icons = { info: 'ℹ', warn: '⚠', error: '✗' };
    let fixesHtml = '';
    const fixList = h.fix ? [h.fix] : h.fixes || [];
    if (fixList.length) {
      fixesHtml = `<span class="h-fix">${fixList.map((f, i) => `<button data-fix="${i}">${esc(f.label)}</button>`).join('')}</span>`;
    }
    el.innerHTML = `<span class="h-icon">${icons[h.level]}</span><span>${esc(h.text)}</span>${fixesHtml}`;
    fixList.forEach((f, i) => {
      el.querySelector(`[data-fix="${i}"]`).onclick = () => {
        f.apply();
        renderParams();
        scheduleUpdate();
        saveConfig();
      };
    });
    box.appendChild(el);
  }
}

/* ---------------- 启动 ---------------- */
async function getBinaries() {
  return api.engine.binaries(state.config?.buildDir || '');
}

async function start() {
  if (!state.model) {
    alert('请先选择模型');
    return;
  }
  const bin = await getBinaries();
  if (state.mode === 'server') {
    if (!bin?.server) {
      alert('未找到 llama-server 二进制。\n请在 ③ 启动引擎 处填写 llama.cpp 的 build 目录（包含 bin/llama-server）。');
      return;
    }
    // 端口检查
    if (await api.engine.portStatus(state.params.port)) {
      const free = await api.engine.findFreePort(state.params.port + 1);
      const ok = free > 0 && confirm(`端口 ${state.params.port} 已被占用。改用空闲端口 ${free} 启动？`);
      if (!ok) return;
      if (free > 0) {
        state.params.port = free;
        renderParams();
        scheduleUpdate();
      }
    }
    const { args } = await api.args.build({ params: state.params, modelPath: state.model.path, mode: 'server' });
    setEngineState('starting');
    log(`\n$ llama-server ${args.join(' ')}\n`);
    await api.engine.startServer({ bin: bin.server, args });
  } else {
    if (!bin?.cli) {
      alert('未找到 llama-cli 二进制。\n请在 ③ 启动引擎 处填写 llama.cpp 的 build 目录（包含 bin/llama-cli）。');
      return;
    }
    const { args } = await api.args.build({ params: state.params, modelPath: state.model.path, mode: 'cli' });
    await api.engine.launchTerminal({ bin: bin.cli, args, terminalApp: state.config.terminalApp || 'Terminal' });
    setEngineState('running', '已在系统终端中打开');
    log(`\n已在系统终端中启动 llama-cli（参数 ${args.length} 项）\n`);
  }
}

function stop() {
  api.engine.stopServer();
  setEngineState('stopping');
}

function setEngineState(state_, extra) {
  state.serverState = state_;
  const el = $('engineState');
  el.className = `engine-state ${state_}`;
  el.textContent = {
    stopped: '未运行',
    starting: '启动中…',
    running: `运行中${extra ? `（${extra}）` : ''}`,
    stopping: '停止中…',
    error: '出错',
  }[state_] || state_;
  $('btnStop').disabled = !['starting', 'running', 'stopping'].includes(state_);
  if (state_ !== 'running' && state_ !== 'starting') state.serverUrl = null;
}

/* ---------------- 聊天 ---------------- */
let chatAbort = null;
function addMsg(role, text) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = text;
  $('chatMsgs').appendChild(el);
  $('chatMsgs').scrollTop = $('chatMsgs').scrollHeight;
  return el;
}

async function chatSend() {
  if (!state.serverUrl) {
    addMsg('error', '请先启动 API 服务（③ 启动引擎 → 启动）');
    return;
  }
  const text = $('chatText').value.trim();
  if (!text) return;
  $('chatText').value = '';
  addMsg('user', text);
  state.chatHistory.push({ role: 'user', content: text });
  const el = addMsg('assistant', '');
  $('btnChatSend').disabled = true;
  $('btnChatStop').disabled = false;
  chatAbort = new AbortController();
  try {
    const base = state.serverUrl.replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (state.params.apiKey) headers['Authorization'] = `Bearer ${state.params.apiKey}`;
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      signal: chatAbort.signal,
      body: JSON.stringify({
        model: state.model?.path,
        messages: state.chatHistory,
        stream: true,
        // 固定 slot：这样这段对话的上下文会保留在该 slot 里，可存盘/恢复、下次直接复用
        id_slot: slotId(),
        temperature: state.params.temp,
        top_k: state.params.topK,
        top_p: state.params.topP,
        min_p: state.params.minP,
        repeat_penalty: state.params.repeatPenalty,
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let think = '';
    let out = '';
    const render = () => {
      el.textContent = (think ? '💭 ' + think : '') + out;
      el.classList.toggle('thinking', !!think && !out);
      $('chatMsgs').scrollTop = $('chatMsgs').scrollHeight;
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const d = j.choices?.[0]?.delta || {};
          if (d.reasoning_content) think += d.reasoning_content;
          if (d.content) out += d.content;
          if (d.reasoning_content || d.content) render();
        } catch {}
      }
    }
    if (!out && !think) el.textContent = '（空响应）';
    else render();
    state.chatHistory.push({ role: 'assistant', content: out });
  } catch (err) {
    if (err.name === 'AbortError') {
      el.textContent = (el.textContent || '') + '\n[已停止]';
    } else {
      el.className = 'msg error';
      el.textContent = `请求失败: ${err.message}`;
    }
  } finally {
    chatAbort = null;
    $('btnChatSend').disabled = false;
    $('btnChatStop').disabled = true;
  }
}

/* ---------------- 会话存盘（磁盘） ---------------- */
function slotDir() {
  return String(state.params.slotSavePath || '').trim();
}

/** 当前会话固定使用的 slot（对话与存盘共用，确保存下来的是这段对话的上下文） */
function slotId() {
  const el = $('slotId');
  const n = el ? Number(el.value) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function slotStatus(text, kind) {
  const el = $('slotStatus');
  if (!el) return;
  el.className = `slot-status${kind ? ' ' + kind : ''}`;
  el.textContent = text;
}

async function refreshSlots() {
  const box = $('slotList');
  if (!box) return;
  const dir = slotDir();
  if (!dir) {
    box.innerHTML = '<div class="empty">未设置存盘目录（② 配置参数 → 高级选项 → 会话存盘目录）</div>';
    return;
  }
  const r = await api.slots.list(dir);
  if (!r.exists) {
    box.innerHTML = `<div class="empty">目录不存在：${esc(dir)}<br>（llama-server 启动时会在写入第一个文件时创建）</div>`;
    return;
  }
  if (!r.files.length) {
    box.innerHTML = `<div class="empty">${esc(dir)} 下暂无存盘文件</div>`;
    return;
  }
  box.innerHTML = r.files
    .map(
      (f) => `<div class="slot-item" data-name="${esc(f.name)}">
        <span class="s-name">${esc(f.name)}</span>
        <span class="s-meta">${gb(f.sizeBytes)} GB · ${new Date(f.mtimeMs).toLocaleString()}</span>
        <button class="btn ghost small" data-act="restore">恢复</button>
        <button class="btn ghost small" data-act="del">删文件</button>
      </div>`
    )
    .join('');
  box.querySelectorAll('.slot-item').forEach((el) => {
    const name = el.dataset.name;
    el.querySelector('[data-act="restore"]').onclick = () => {
      $('slotFile').value = name;
      slotAction('restore', name);
    };
    el.querySelector('[data-act="del"]').onclick = () => removeSlotFile(name);
    // 右键：直接打开存盘文件所在目录，方便核对文件
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const p = joinPath(slotDir(), name);
      showMenu(e.clientX, e.clientY, [
        { type: 'head', label: name, sub: p },
        ...fileMenuItems(p),
        { type: 'sep' },
        { icon: '🗑', label: '删除该存盘文件', danger: true, onClick: () => removeSlotFile(name) },
      ]);
    });
  });
}

/** 删除磁盘上的存盘文件（按钮与右键菜单共用） */
async function removeSlotFile(name) {
  if (!confirm(`删除磁盘上的存盘文件？\n\n${name}`)) return;
  try {
    await api.slots.remove({ dir: slotDir(), name });
    slotStatus(`已删除文件 ${name}`, 'ok');
    toast(`已删除 ${name}`, 'ok');
  } catch (err) {
    slotStatus(`删除失败: ${err.message}`, 'bad');
    toast(`删除失败：${err.message}`, 'bad');
  }
  refreshSlots();
}

async function slotAction(action, filenameOverride) {
  const name = filenameOverride || $('slotFile').value.trim();
  if (!state.serverUrl) return slotStatus('请先启动 API 服务（③ 启动引擎 → 启动）', 'bad');
  if (action !== 'erase' && !name) return slotStatus('请填写文件名', 'bad');
  if (action !== 'erase' && !slotDir()) {
    return slotStatus('未设置「会话存盘目录」：请在 ② 配置参数 → 高级选项 里填写，并重启服务', 'bad');
  }
  const id = slotId();
  const base = state.serverUrl.replace(/\/+$/, '');
  const label = { save: '保存', restore: '恢复', erase: '清空' }[action] || action;
  slotStatus(`${label}中…`);
  try {
    const resp = await fetch(`${base}/slots/${id}?action=${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action === 'erase' ? {} : { filename: name }),
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j.error?.message || j.message || `HTTP ${resp.status}`);
    if (action === 'save') {
      slotStatus(
        `✓ 已存盘 ${name}：${j.n_saved ?? '?'} tokens，${j.n_written ? (j.n_written / 1e9).toFixed(2) + ' GB，' : ''}耗时 ${j.timings?.save_ms?.toFixed(0) ?? '?'} ms`,
        'ok'
      );
    } else if (action === 'restore') {
      slotStatus(
        `✓ 已恢复 ${name}：${j.n_restored ?? '?'} tokens，${j.n_read ? (j.n_read / 1e9).toFixed(2) + ' GB，' : ''}耗时 ${j.timings?.restore_ms?.toFixed(0) ?? '?'} ms（这段提示词无需重新计算）`,
        'ok'
      );
    } else {
      slotStatus(`✓ 已清空 slot ${id}（${j.n_erased ?? '?'} tokens）`, 'ok');
    }
  } catch (err) {
    slotStatus(`${label}失败：${err.message}`, 'bad');
  }
  refreshSlots();
}

/* ---------------- 设置持久化 ---------------- */
let saveTimer = null;
function saveConfig() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    state.config = {
      ...state.config,
      modelDir: $('modelDir').value,
      buildDir: $('buildDir')?.value || '',
      terminalApp: state.config.terminalApp || 'Terminal',
      mode: state.mode,
      modelPath: state.model?.path || '',
      params: state.params,
    };
    api.config.save(state.config);
  }, 400);
}

async function loadConfig() {
  state.config = await api.config.load();
  $('modelDir').value = state.config.modelDir || '';
  if ($('buildDir')) $('buildDir').value = state.config.buildDir || '';
  if (state.config.mode) setMode(state.config.mode);
  if (state.config.params) Object.assign(state.params, state.config.params);
  if (state.config.modelPath) {
    $('modelDir').value = state.config.modelDir;
  }
}

/* ---------------- 模式切换 ---------------- */
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('#modeTabs .tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.mode === mode));
  renderParams();
  scheduleUpdate();
  saveConfig();
}

/* ---------------- 引擎事件 ---------------- */
function bindEngineEvents() {
  api.engine.on('engine:log', (text) => log(text));
  api.engine.on('engine:state', (s) => {
    setEngineState(s.state);
    if (s.url) {
      state.serverUrl = s.url;
      const a = $('serverUrl');
      a.href = s.url;
      a.textContent = s.url;
      a.classList.remove('hidden');
    }
    if (s.state === 'stopped') $('serverUrl').classList.add('hidden');
  });
}

/* ---------------- 引擎自检 ---------------- */
async function fitCheck() {
  if (!state.model) return alert('请先选择模型');
  const bin = await getBinaries();
  if (!bin?.fit) return alert('未找到 llama-fit-params 二进制');
  const out = $('fitOutput');
  out.classList.remove('hidden');
  out.textContent = '运行 llama-fit-params 中…';
  const r = await api.engine.fit({ bin: bin.fit, modelPath: state.model.path, ctx: state.params.ctx });
  out.textContent = (r.ok ? '' : '[非零退出] ') + r.output;
}

/* ---------------- 初始化 ---------------- */
async function init() {
  renderParams();
  bindEngineEvents();

  await loadConfig();
  await scanHw();
  if ($('modelDir').value) await scanModels();

  // 事件绑定
  $('btnPickDir').onclick = async () => {
    const dir = await api.models.pick();
    if (dir) {
      $('modelDir').value = dir;
      saveConfig();
      await scanModels();
    }
  };
  $('btnRescan').onclick = scanModels;
  $('modelDir').addEventListener('change', () => { saveConfig(); scanModels(); });
  $('btnOneClick').onclick = async () => {
    if (!state.model) return alert('请先选择模型');
    if (!state.hw) await scanHw();
    const r = await api.recommend.run({ hw: state.hw, model: state.model, params: state.params });
    Object.assign(state.params, r.params);
    state.rec = r;
    state.notes = r.notes;
    await syncSpecOptions();
    renderParams();
    scheduleUpdate();
    saveConfig();
  };
  $('btnFitCheck').onclick = fitCheck;
  $('btnStart').onclick = start;
  $('btnStop').onclick = stop;
  $('btnCopyCmd').onclick = async () => {
    const r = await copyText($('cmdPreview').textContent, '启动命令');
    $('btnCopyCmd').textContent = r && r.ok ? '已复制 ✓' : '复制失败';
    setTimeout(() => ($('btnCopyCmd').textContent = '复制'), 1200);
  };
  $('cvBudget').addEventListener('input', updateMaxCtx);
  $('cvBudget').value = state.hw ? Math.round(state.hw.ramGB * 0.8) : 48;
  document.querySelectorAll('#modeTabs .tab').forEach((t) => (t.onclick = () => setMode(t.dataset.mode)));
  const adv = $('advToggle');
  if (adv) adv.onchange = () => { state.advanced = adv.checked; renderParams(); scheduleUpdate(); };
  $('btnChatSend').onclick = chatSend;
  $('btnChatStop').onclick = () => chatAbort?.abort();
  $('btnChatClear').onclick = () => { $('chatMsgs').innerHTML = ''; state.chatHistory = []; };
  // 会话存盘面板
  $('btnSlotSave').onclick = () => slotAction('save');
  $('btnSlotRestore').onclick = () => slotAction('restore');
  $('btnSlotErase').onclick = () => slotAction('erase');
  $('btnSlotRefresh').onclick = refreshSlots;
  $('slotFile').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') slotAction('save');
  });
  refreshSlots();
  $('chatText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      chatSend();
    }
  });
  $('buildDir')?.addEventListener('change', saveConfig);
  $('toast')?.addEventListener('click', hideToast);

  updateDynamic();
}

init();

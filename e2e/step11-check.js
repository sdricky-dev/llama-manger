const $ = (id) => document.getElementById(id);
const val = (k) => { const c = document.querySelector(`[data-ctl="${k}"]`); if (!c) return '(无控件)'; const el = c.querySelector('input,select'); return el ? (el.type === 'checkbox' ? el.checked : el.value) : '(无输入)'; };
const rows = [...document.querySelectorAll('#paramGroups .param-row')].map(r => r.dataset.p);
return {
  rows,
  mmproj: val('mmproj'),
  mmprojOffload: val('mmprojOffload'),
  specDraft: val('specDraft'),
  specDraftNglRendered: !!document.querySelector('[data-ctl="specDraftNgl"]'),
  specTypeRendered: !!document.querySelector('[data-ctl="specType"]'),
};

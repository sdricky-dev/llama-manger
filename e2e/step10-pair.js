const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
const items = [...$('modelList').querySelectorAll('.model-item')];
const jev = items.find((el) => el.querySelector('.m-name').textContent.includes('JEV'));
jev.click();
await sleep(1200);
$('btnOneClick').click();
await sleep(2000);
const val = (k) => { const el = document.querySelector(`[data-k="${k}"]`); return el ? (el.type === 'checkbox' ? el.checked : el.value) : '(未渲染)'; };
return {
  modelInfo: $('modelInfo')?.textContent?.replace(/\s+/g, ' ').trim(),
  mmproj: val('mmproj'),
  mmprojOffload: val('mmprojOffload'),
  specDraft: val('specDraft'),
  specType: val('specType'),
  memStatus: $('memStatus')?.textContent,
  memLegend: $('memLegend')?.textContent?.replace(/\s+/g, ' ').trim(),
  cmd: $('cmdPreview')?.textContent,
  hints: [...document.querySelectorAll('#hints .hint')].map(h => h.textContent.replace(/\s+/g, ' ').trim()).slice(0, 4),
};

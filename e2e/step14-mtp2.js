const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
$('modelDir').value = MODELS_DIR;
$('modelDir').dispatchEvent(new Event('change', { bubbles: true }));
await sleep(5000);
const items = [...$('modelList').querySelectorAll('.model-item')];
const swift = items.find((el) => el.querySelector('.m-name').textContent.includes('Swift'));
swift.click();
await sleep(1000);
$('btnOneClick').click();
await sleep(1800);
const fixBtn = [...document.querySelectorAll('#hints .hint button')].find(b => b.textContent.includes('MTP'));
if (!fixBtn) return { error: '未找到 MTP 快捷按钮', hints: [...document.querySelectorAll('#hints .hint')].map(h=>h.textContent) };
fixBtn.click();
await sleep(1500);
const val = (k) => { const c = document.querySelector(`[data-ctl="${k}"]`); if (!c) return '(无控件)'; const el = c.querySelector('input,select'); return el ? (el.type === 'checkbox' ? el.checked : el.value) : null; };
const specType = val('specType');
$('btnStart').click();
const t0 = Date.now();
let state = '';
while (Date.now() - t0 < 90000) {
  state = $('engineState')?.textContent || '';
  if (state.includes('运行中') || state.includes('出错')) break;
  await sleep(1000);
}
const logs = $('console')?.textContent || '';
return {
  elapsed: Math.round((Date.now() - t0) / 1000) + 's',
  specType,
  cmdHasSpec: ($('cmdPreview')?.textContent || '').includes('--spec-type draft-mtp'),
  engineState: state,
  specLogs: logs.split('\n').filter(l => /spec|mtp|draft/i.test(l)).slice(-6).join('\n').slice(0, 600),
  tail: logs.slice(-260),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
$('modelDir').value = MODELS_DIR;
$('modelDir').dispatchEvent(new Event('change', { bubbles: true }));
await sleep(5000);
const items = [...$('modelList').querySelectorAll('.model-item')];
const jev = items.find((el) => el.querySelector('.m-name').textContent.includes('JEV'));
jev.click();
await sleep(1500);
const swift = items.find((el) => el.querySelector('.m-name').textContent.includes('Swift'));
swift.click();
await sleep(1200);
$('btnOneClick').click();
await sleep(2000);
const val = (k) => { const c = document.querySelector(`[data-ctl="${k}"]`); if (!c) return '(无控件)'; const el = c.querySelector('input,select'); return el ? (el.type === 'checkbox' ? el.checked : el.value) : null; };
return {
  jevTags: jev.querySelector('.m-meta').textContent.replace(/\s+/g, ' ').trim(),
  swiftMeta: swift.querySelector('.m-meta').textContent.replace(/\s+/g, ' ').trim(),
  swiftInfo: $('modelInfo')?.textContent?.replace(/\s+/g, ' ').trim(),
  mmproj: val('mmproj'), specDraft: val('specDraft'),
  memStatus: $('memStatus')?.textContent,
  cmd: ($('cmdPreview')?.textContent || '').slice(0, 200),
  hints: [...document.querySelectorAll('#hints .hint')].map(h => h.className + ' :: ' + h.textContent.replace(/\s+/g, ' ').trim()).slice(0, 3),
};

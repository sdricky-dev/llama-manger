const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
$('btnOneClick').click();
await sleep(1500);
const val = (k) => {
  const el = document.querySelector(`[data-k="${k}"]`);
  return el ? (el.type === 'check' ? el.checked : el.value) : null;
};
return {
  ctx: $('ctxSelect')?.value || val('ctx'),
  ctxPresets: [...document.querySelectorAll('[data-ctx]')].map(b => b.dataset.ctx + (b.classList.contains('active') ? '*' : '')),
  ngl: val('ngl'),
  fa: val('fa'),
  threads: val('threads'),
  threadsBatch: val('threadsBatch'),
  cacheK: val('cacheTypeK'),
  cacheV: val('cacheTypeV'),
  temp: val('temp'), topK: val('topK'), topP: val('topP'), minP: val('minP'), rp: val('repeatPenalty'),
  batch: val('batch'), ubatch: val('ubatch'),
  host: val('host'), port: val('port'),
  memStatus: $('memStatus')?.textContent,
  memLegend: $('memLegend')?.textContent?.replace(/\s+/g, ' ').trim(),
  memBarSegs: [...$('memBar').querySelectorAll('.seg')].map(s => s.className.replace('seg ', '') + ':' + s.style.width),
  cvCtx: $('cvCtx')?.textContent, cvKv: $('cvKv')?.textContent, cvMaxCtx: $('cvMaxCtx')?.textContent,
  notes: $('notes')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 400),
  cmd: $('cmdPreview')?.textContent,
};

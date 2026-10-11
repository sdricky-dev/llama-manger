const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
$('modelDir').value = MODELS_DIR;
$('modelDir').dispatchEvent(new Event('change', { bubbles: true }));
await sleep(5000);
const items = [...$('modelList').querySelectorAll('.model-item')];
const swift = items.find((el) => el.querySelector('.m-name').textContent.includes('Swift'));
swift.click();
await sleep(1500);
$('btnOneClick').click();
await sleep(2500);
const before = {
  ctx: $('cvCtx')?.textContent,
  kvType: document.querySelector('[data-ctl="cacheTypeK"] select')?.value,
  kvGB: $('cvKv')?.textContent,
  ctxMax: $('cvMaxCtx')?.textContent,
  specType: document.querySelector('[data-ctl="specType"] select')?.value,
  mem: $('memStatus')?.textContent,
  cmd: ($('cmdPreview')?.textContent || '').slice(0, 200),
};
$('btnStart').click();
const t0 = Date.now();
let state = '';
while (Date.now() - t0 < 150000) {
  state = $('engineState')?.textContent || '';
  if (state.includes('运行中') || state.includes('出错')) break;
  await sleep(1500);
}
const logs = $('console')?.textContent || '';
return {
  ...before,
  elapsed: Math.round((Date.now() - t0) / 1000) + 's',
  engineState: state,
  serverUrl: $('serverUrl')?.textContent,
  kvLog: logs.split('\n').filter(l => /n_ctx|KV|kv cache|listening|MTP|spec/i.test(l)).slice(-6).join('\n'),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
$('modelDir').value = MODELS_DIR;
$('modelDir').dispatchEvent(new Event('change', { bubbles: true }));
await sleep(5000);
const items = [...$('modelList').querySelectorAll('.model-item')];
const jev = items.find((el) => el.querySelector('.m-name').textContent.includes('JEV'));
jev.click();
await sleep(1000);
$('btnOneClick').click();
await sleep(2000);
const before = {
  tag: jev.querySelector('.m-meta').textContent.replace(/\s+/g, ' ').trim(),
  info: $('modelInfo')?.textContent?.replace(/\s+/g, ' ').trim(),
  hints: [...document.querySelectorAll('#hints .hint')].map(h => h.className.replace('hint ', '') + ': ' + h.textContent.replace(/\s+/g, ' ').trim().slice(0, 120)),
  mem: $('memStatus')?.textContent,
  cmd: ($('cmdPreview')?.textContent || '').slice(0, 130),
};
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
  ...before,
  elapsed: Math.round((Date.now() - t0) / 1000) + 's',
  engineState: state,
  serverUrl: $('serverUrl')?.textContent,
  decisionLog: logs.split('\n').filter(l => /decision|multimodal|listening/i.test(l)).slice(-4).join('\n'),
};

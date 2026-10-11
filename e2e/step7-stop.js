const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
$('btnStop').click();
const t0 = Date.now();
let state = '';
while (Date.now() - t0 < 15000) {
  state = $('engineState')?.textContent || '';
  if (state.includes('未运行') || state.includes('出错')) break;
  await sleep(500);
}
return {
  engineState: state,
  serverUrlHidden: $('serverUrl')?.classList?.contains('hidden'),
  logTail: ($('console')?.textContent || '').slice(-200),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
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
  engineState: state,
  serverUrl: $('serverUrl')?.classList?.contains('hidden') ? null : $('serverUrl')?.textContent,
  logTail: logs.slice(-600),
};

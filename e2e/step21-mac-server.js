const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
// 切回 server 模式
document.querySelector('#modeTabs .tab[data-mode="server"]').click();
await sleep(800);
$('btnStart').click();
const t0 = Date.now();
let st = '';
while (Date.now() - t0 < 150000) {
  st = $('engineState')?.textContent || '';
  if (st.includes('运行中') || st.includes('出错')) break;
  await sleep(1200);
}
return {
  mode: [...document.querySelectorAll('#modeTabs .tab')].filter(t => t.classList.contains('active')).map(t => t.dataset.mode),
  engineState: st,
  serverUrl: $('serverUrl')?.textContent || null,
  elapsed: Math.round((Date.now() - t0) / 1000) + 's',
  cmd: ($('cmdPreview')?.textContent || '').replace(/--temp.*-s -1 /, '').slice(0, 150),
  memMode: $('memStatus')?.textContent,
  logTail: ($('console')?.textContent || '').split('\n').slice(-3).join(' | '),
};

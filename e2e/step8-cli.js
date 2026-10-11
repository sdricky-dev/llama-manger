const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
document.querySelector('#modeTabs .tab[data-mode="cli"]').click();
await sleep(500);
const cmdCli = $('cmdPreview')?.textContent;
$('btnStart').click();
await sleep(2500);
return {
  mode: [...document.querySelectorAll('#modeTabs .tab')].map(t => t.dataset.mode + (t.classList.contains('active') ? '*' : '')),
  cmdCli: cmdCli,
  engineState: $('engineState')?.textContent,
  logTail: ($('console')?.textContent || '').slice(-300),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
// 点提示里的「启用内置 MTP」
const fixBtn = [...document.querySelectorAll('#hints .hint button')].find(b => b.textContent.includes('MTP'));
if (!fixBtn) return { error: '未找到 MTP 快捷按钮' };
fixBtn.click();
await sleep(1200);
$('btnStart').click();
const t0 = Date.now();
let state = '';
while (Date.now() - t0 < 90000) {
  state = $('engineState')?.textContent || '';
  if (state.includes('运行中') || state.includes('出错')) break;
  await sleep(1000);
}
const logs = $('console')?.textContent || '';
const spec = logs.split('\n').filter(l => /spec|mtp|draft|MTP/i.test(l)).slice(-8).join('\n');
return {
  elapsed: Math.round((Date.now() - t0) / 1000) + 's',
  engineState: state,
  cmd: $('cmdPreview')?.textContent?.slice(-160),
  specLogs: spec,
  tail: logs.slice(-300),
};

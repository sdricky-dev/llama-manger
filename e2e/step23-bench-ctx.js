// 多上下文基准：打开面板 → 选深度 0/4K → 重复 1 次 → 跑 → 收集表格
// 前置：step2（扫描）、step3（选中模型）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);

$('btnBench').click();
await sleep(200);

// 面板里直接填（等价于点 0 和 4K 两个 chip）
$('benchDepths').value = '0,4096';
$('benchDepths').dispatchEvent(new Event('input', { bubbles: true }));
$('benchReps').value = '1';
$('benchReps').dispatchEvent(new Event('input', { bubbles: true }));

const chipsOn = [...document.querySelectorAll('#benchCtxChips button.on')].map((b) => b.textContent);
const noteReps = $('benchNoteReps').textContent;

// 先等状态进入「跑基准中」，再等结束 —— 否则上一次运行留下的「✓ …」会让这里瞬间返回
$('btnBenchRun').click();
const t0 = Date.now();
let st = '';
while (Date.now() - t0 < 10000) {
  st = $('benchStatus')?.textContent || '';
  if (st.includes('跑基准中')) break;
  await sleep(100);
}
while (Date.now() - t0 < 600000) {
  st = $('benchStatus')?.textContent || '';
  if (st.startsWith('✓') || st.includes('失败')) break;
  await sleep(1000);
}

const rows = [...document.querySelectorAll('#benchTableBody tr')].map((tr) =>
  [...tr.children].map((td) => td.textContent)
);

return {
  chipsOn,
  noteReps,
  status: st,
  elapsed: `${Math.round((Date.now() - t0) / 1000)}s`,
  gridHidden: $('benchGrid').classList.contains('hidden'),
  tableHidden: $('benchTableWrap').classList.contains('hidden'),
  rows,
  meta: $('benchMeta').textContent,
};

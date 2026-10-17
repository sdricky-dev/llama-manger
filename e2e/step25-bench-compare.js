// M5 加速对照：勾选「M5 加速对照」后基准会跑两遍（第二遍 GGML_METAL_TENSOR_DISABLE=1）
// 断言表格多出「tensor 加速」列，且倍率 > 1
// 前置：step2、step3
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);

$('btnBench').click();
await sleep(200);
$('benchDepths').value = '0';
$('benchDepths').dispatchEvent(new Event('input', { bubbles: true }));
$('benchReps').value = '1';
$('benchReps').dispatchEvent(new Event('input', { bubbles: true }));

const cmp = $('benchCompareTensor');
const wrapVisible = $('benchCompareWrap') && !$('benchCompareWrap').classList.contains('hidden');
cmp.checked = true;
cmp.dispatchEvent(new Event('change', { bubbles: true }));

const pre = $('benchStatus').textContent;
$('btnBenchRun').click();

// 先等进入运行态（状态栏可能残留上一轮结果）
const t0 = Date.now();
let st = '';
while (Date.now() - t0 < 10000) {
  st = $('benchStatus')?.textContent || '';
  if (st.includes('跑基准中')) break;
  await sleep(100);
}
const statusDuring = st;

while (Date.now() - t0 < 600000) {
  st = $('benchStatus')?.textContent || '';
  if ((st.startsWith('✓') || st.includes('失败')) && st !== pre) break;
  await sleep(1000);
}

const head = [...document.querySelectorAll('#benchTableHead th')].map((th) => th.textContent);
const rows = [...document.querySelectorAll('#benchTableBody tr')].map((tr) =>
  [...tr.children].map((td) => td.textContent)
);

return {
  compareToggleVisible: !!wrapVisible,
  statusDuring,
  status: st,
  head,
  rows,
  elapsed: `${Math.round((Date.now() - t0) / 1000)}s`,
};

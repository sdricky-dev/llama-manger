// Metal 能力哨兵：启动引擎后应出现「神经加速器 ✓」徽标（M5+/Metal 4 才有）
// 前置：step2、step3、step18（已启动 server）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);

const t0 = Date.now();
let el = $('engineMetal');
while (Date.now() - t0 < 60000) {
  el = $('engineMetal');
  if (el && !el.classList.contains('hidden') && el.textContent) break;
  await sleep(300);
}

return {
  text: el?.textContent || '',
  className: el?.className || '',
  hidden: el ? el.classList.contains('hidden') : null,
  title: (el?.title || '').slice(0, 120),
  waited: `${Math.round((Date.now() - t0) / 1000)}s`,
};

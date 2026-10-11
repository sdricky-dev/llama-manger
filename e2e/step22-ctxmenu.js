const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
const out = {};

/* 1) 扫描真实模型目录 */
$('modelDir').value = MODELS_DIR;
$('modelDir').dispatchEvent(new Event('change', { bubbles: true }));
await sleep(7000);

const items = [...$('modelList').querySelectorAll('.model-item')];
out.cards = items.length;
out.everyCardHasMore = items.every((el) => !!el.querySelector('.m-more'));
out.everyCardNameHasPath = items.every((el) => (el.querySelector('.m-name')?.dataset.file || '').endsWith('.gguf'));
out.attachTagsWithPath = items.flatMap((el) => [...el.querySelectorAll('.tag.attach[data-file]')]).length;
out.hintVisible = !!document.querySelector('.list-hint');

/* 2) 右键第一个模型卡片 → 菜单内容 */
const card = items[0];
const r0 = card.getBoundingClientRect();
card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r0.left + 30, clientY: r0.top + 30 }));
await sleep(250);
let menu = document.querySelector('.ctx-menu');
out.menuVisible = !!menu && !menu.classList.contains('hidden');
out.menuHead = menu?.querySelector('.ctx-head b')?.textContent;
out.menuSub = menu?.querySelector('.ctx-head span')?.textContent;
out.menuLabels = [...menu.querySelectorAll('.ctx-item')].map((b) => b.querySelector('.ctx-lbl').textContent);
out.menuNotes = [...menu.querySelectorAll('.ctx-note')].map((n) => n.textContent);
out.menuInsideViewport = (() => {
  const r = menu.getBoundingClientRect();
  return r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
})();

/* 3) Esc 关闭 */
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await sleep(120);
out.escCloses = document.querySelector('.ctx-menu').classList.contains('hidden');

/* 4) ⋯ 按钮打开同一菜单 */
card.querySelector('.m-more').click();
await sleep(200);
menu = document.querySelector('.ctx-menu');
out.moreBtnOpensMenu = !menu.classList.contains('hidden');
out.moreBtnSameItems = [...menu.querySelectorAll('.ctx-item')].length === out.menuLabels.length;

/* 5) 点击「打开所在文件夹」→ 走完整链路（renderer → preload → 主进程 → 系统文件管理器） */
const dirItem = [...menu.querySelectorAll('.ctx-item')].find((b) => b.querySelector('.ctx-lbl').textContent.includes('打开所在文件夹'));
dirItem.click();
await sleep(1200);
out.toastAfterOpenDir = $('toast').textContent;
out.toastKind = $('toast').className;
out.menuClosedAfterClick = document.querySelector('.ctx-menu').classList.contains('hidden');

/* 6) 附属标签右键：菜单标题应是附属文件本身 */
const tag = items.flatMap((el) => [...el.querySelectorAll('.tag.attach[data-file]')])[0];
if (tag) {
  const r = tag.getBoundingClientRect();
  tag.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5 }));
  await sleep(200);
  menu = document.querySelector('.ctx-menu');
  out.tagMenuHead = menu?.querySelector('.ctx-head b')?.textContent;
  out.tagMenuPath = menu?.querySelector('.ctx-head span')?.textContent;
  out.tagMenuLabels = [...menu.querySelectorAll('.ctx-item')].map((b) => b.querySelector('.ctx-lbl').textContent);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

/* 7) 直接验证 IPC：缺失文件 / 空路径 / 目录目标 */
out.missingFile = await window.lm.fs.reveal('/tmp/definitely-missing-98765.gguf', 'select');
out.emptyPath = await window.lm.fs.reveal('', 'select');
out.missingDir = await window.lm.fs.reveal('/tmp/no-such-dir-54321/x.gguf', 'dir');

/* 8) 存盘文件右键菜单 */
$('advToggle').checked = true;
$('advToggle').onchange();
await sleep(300);
const slotInput = document.querySelector('[data-k="slotSavePath"]');
out.slotInputFound = !!slotInput;
if (slotInput) {
  slotInput.value = SLOTS_DIR;
  slotInput.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(200);
  await $('btnSlotRefresh').onclick();
  await sleep(900);
}
const slotItems = [...document.querySelectorAll('.slot-item')];
out.slotCount = slotItems.length;
if (slotItems.length) {
  const el = slotItems[0];
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 }));
  await sleep(250);
  menu = document.querySelector('.ctx-menu');
  out.slotMenuVisible = !menu.classList.contains('hidden');
  out.slotMenuHead = menu?.querySelector('.ctx-head b')?.textContent;
  out.slotMenuPath = menu?.querySelector('.ctx-head span')?.textContent;
  out.slotMenuLabels = [...menu.querySelectorAll('.ctx-item')].map((b) => b.querySelector('.ctx-lbl').textContent);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

/* 9) 菜单外点击关闭 */
if (items[1]) {
  const r = items[1].getBoundingClientRect();
  items[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }));
  await sleep(150);
  const opened = !document.querySelector('.ctx-menu').classList.contains('hidden');
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 5, clientY: 5 }));
  await sleep(150);
  out.clickOutsideCloses = opened && document.querySelector('.ctx-menu').classList.contains('hidden');
}

return out;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
const adv = $('advToggle');
if (adv && !adv.checked) { adv.checked = true; adv.onchange(); }
await sleep(600);
$('modelDir').value = MODELS_DIR;
$('modelDir').dispatchEvent(new Event('change', { bubbles: true }));
await sleep(5000);
const items = [...$('modelList').querySelectorAll('.model-item')];
items.find((el) => el.querySelector('.m-name').textContent.includes('ZDTaichu')).click();
await sleep(1200);
// 高级选项里填「会话存盘目录」（用注入的 SLOTS_DIR，别写死路径，见 e2e/README.md）
const dirInput = document.querySelector('[data-ctl="slotSavePath"] input');
dirInput.value = SLOTS_DIR;
dirInput.dispatchEvent(new Event('input', { bubbles: true }));
await sleep(1000);
$('btnOneClick').click();
await sleep(2500);
const panels = [...document.querySelectorAll('#paramGroups .param-group h3')].map(h => h.textContent);
const cmd = $('cmdPreview')?.textContent || '';
$('btnStart').click();
const t0 = Date.now();
let st = '';
while (Date.now() - t0 < 120000) {
  st = $('engineState')?.textContent || '';
  if (st.includes('运行中') || st.includes('出错')) break;
  await sleep(1200);
}
return {
  paramGroups: panels,
  slotDirParam: dirInput.value,
  cmdHasSlotPath: cmd.includes(`--slot-save-path ${SLOTS_DIR}`),
  cmd: cmd.slice(0, 190),
  engineState: st,
  slotStatus: $('slotStatus')?.textContent,
  slotListText: $('slotList')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 140),
};

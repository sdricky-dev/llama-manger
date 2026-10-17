const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
const items = [...$('modelList').querySelectorAll('.model-item')];
// 默认取第一个模型；用 LM_MODEL_MATCH=<子串> 指定，别把个人模型名写死进脚本
const target = MODEL_MATCH ? items.find((el) => (el.dataset.path || '').includes(MODEL_MATCH)) : items[0];
if (!target) {
  return {
    error: 'model not found',
    match: MODEL_MATCH || '(first)',
    count: items.length,
    models: items.map((el) => el.dataset.path),
  };
}
target.click();
await sleep(500);
return {
  selected: target.dataset.path,
  modelInfo: $('modelInfo')?.textContent?.replace(/\s+/g, ' ').trim(),
};

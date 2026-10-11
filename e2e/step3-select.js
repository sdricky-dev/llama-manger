const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
const items = [...$('modelList').querySelectorAll('.model-item')];
const target = items.find((el) => el.dataset.path.includes('ukisai'));
if (!target) return { error: 'model not found' };
target.click();
await sleep(500);
return {
  modelInfo: $('modelInfo')?.textContent?.replace(/\s+/g, ' ').trim(),
};

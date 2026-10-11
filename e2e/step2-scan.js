const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
$('modelDir').value = MODELS_DIR;
$('modelDir').dispatchEvent(new Event('change', { bubbles: true }));
await sleep(4000);
const items = [...$('modelList').querySelectorAll('.model-item')];
return {
  count: items.length,
  models: items.map((el) => ({
    name: el.querySelector('.m-name')?.textContent,
    meta: el.querySelector('.m-meta')?.textContent?.replace(/\s+/g, ' ').trim(),
    path: el.dataset.path,
  })),
  warnings: $('modelWarnings')?.textContent,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
$('modelDir').value = MODELS_DIR;
$('modelDir').dispatchEvent(new Event('change', { bubbles: true }));
await sleep(5000);
const items = [...$('modelList').querySelectorAll('.model-item')];
return {
  count: items.length,
  models: items.map((el) => ({
    name: el.querySelector('.m-name')?.textContent,
    meta: el.querySelector('.m-meta')?.textContent?.replace(/\s+/g, ' ').trim(),
  })),
  warnings: $('modelWarnings')?.classList.contains('hidden') ? null : $('modelWarnings')?.textContent,
  paramGroups: [...document.querySelectorAll('#paramGroups .param-group h3')].map(h => h.textContent),
};

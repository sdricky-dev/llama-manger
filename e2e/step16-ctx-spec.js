const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
$('modelDir').value = MODELS_DIR;
$('modelDir').dispatchEvent(new Event('change', { bubbles: true }));
await sleep(5000);
const items = [...$('modelList').querySelectorAll('.model-item')];
const out = {};
const ctxButtons = () => [...document.querySelectorAll('#paramGroups [data-ctx]')].map(b => b.textContent + (b.classList.contains('active') ? '*' : ''));
const specSelect = () => {
  const c = document.querySelector('[data-ctl="specType"]');
  const sel = c?.querySelector('select');
  return { options: sel ? [...sel.options].map(o => o.value + (o.selected ? '*' : '')) : null, note: c?.querySelector('.spec-note')?.textContent || null };
};
for (const name of ['Swift', 'JEV', 'GEV', 'ZDTaichu']) {
  const el = items.find(x => x.querySelector('.m-name').textContent.includes(name));
  el.click();
  await sleep(1500);
  $('btnOneClick').click();
  await sleep(2200);
  out[name] = {
    ctx: $('cvCtx')?.textContent,
    kv: $('cvKv')?.textContent,
    ctxButtons: ctxButtons(),
    spec: specSelect(),
    specType: document.querySelector('[data-ctl="specType"] select')?.value,
    mem: $('memStatus')?.textContent,
    notes: [...document.querySelectorAll('#hints .hint')].map(h => h.textContent.replace(/\s+/g, ' ').trim()).slice(0, 3),
    cmdTail: ($('cmdPreview')?.textContent || '').slice(0, 120),
  };
}
return out;

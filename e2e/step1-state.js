const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
await sleep(1500);
return {
  title: document.title,
  modelDir: $('modelDir')?.value,
  buildDir: $('buildDir')?.value,
  hwCard: $('hwCard')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 300),
  modelListCount: $('modelList')?.children?.length,
  modelListText: $('modelList')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 200),
  memEmpty: $('memEmpty')?.classList?.contains('hidden'),
  cmdPreview: $('cmdPreview')?.textContent?.slice(0, 120),
  engineState: $('engineState')?.textContent,
  modeTabs: [...document.querySelectorAll('#modeTabs .tab')].map(t => t.dataset.mode + (t.classList.contains('active') ? '*' : '')),
};

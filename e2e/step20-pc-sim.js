const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
const D = window.__lmDebug;
if (!D) return { error: '无调试钩子' };

// 选一个真实模型（Swift）
$('modelDir').value = MODELS_DIR;
$('modelDir').dispatchEvent(new Event('change', { bubbles: true }));
await sleep(5000);
const items = [...$('modelList').querySelectorAll('.model-item')];
items.find((el) => el.querySelector('.m-name').textContent.includes('Swift')).click();
await sleep(1200);

// 注入「假 Windows 硬件」：12GB 显存 + 32GB 内存
D.state.hw = {
  platform: 'win32', arch: 'x64', chip: 'AMD Ryzen 9 7950X',
  pCores: 16, eCores: 0, totalCores: 32, ramGB: 32, freeGB: 20,
  gpu: { name: 'NVIDIA GeForce RTX 4070', cores: null, vramGB: 12, vendor: 'nvidia' },
  isAppleSilicon: false, unifiedMemory: false, hasDiscreteGpu: true,
};
// 走 PC 规划器
const r = await window.lm.recommend.run({ hw: D.state.hw, model: D.state.model, params: D.state.params });
Object.assign(D.state.params, r.params);
D.state.notes = r.notes;
D.renderParams();
await D.updateDynamic();
await sleep(1200);

const mem = D.state.mem;
return {
  plan: {
    ngl: D.state.params.ngl,
    nCpuMoe: D.state.params.nCpuMoe,
    kvOffload: D.state.params.kvOffload,
    ctx: D.state.params.ctx,
    kvType: D.state.params.cacheTypeK,
  },
  memMode: mem.mode,
  vram: mem.vram && {
    total: +(mem.vram.total / 1e9).toFixed(2),
    used: +(mem.vram.used / 1e9).toFixed(2),
    weights: +(mem.vram.weights / 1e9).toFixed(2),
    kv: +(mem.vram.kv / 1e9).toFixed(2),
    ok: mem.vram.ok,
  },
  ram: mem.ram && {
    total: +(mem.ram.total / 1e9).toFixed(2),
    used: +(mem.ram.used / 1e9).toFixed(2),
    weights: +(mem.ram.weights / 1e9).toFixed(2),
    kv: +(mem.ram.kv / 1e9).toFixed(2),
    ok: mem.ram.ok,
  },
  ok: mem.ok,
  memStatusText: $('memStatus').textContent,
  memBarClass: $('memBar').className,
  memBarRows: [...$('memBar').querySelectorAll('.memrow-label')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
  memBarSegs: [...$('memBar').querySelectorAll('.mem-bar')].map((b) => [...b.querySelectorAll('.seg')].map((s) => s.className.replace('seg ', '') + ':' + s.style.width).join(' ')),
  legend: $('memLegend').textContent.replace(/\s+/g, ' ').trim(),
  cvMaxCtx: $('cvMaxCtx').textContent,
  kvOffloadParamShown: !!document.querySelector('[data-ctl="kvOffload"]'),
  cmd: ($('cmdPreview')?.textContent || '').replace(/--temp.*-s -1 /, ''),
  notes: D.state.notes.slice(0, 3),
};

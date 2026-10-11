'use strict';
/**
 * 硬件检测：macOS / Linux / Windows。
 *
 * 关键差异：
 *  - Apple Silicon 是**统一内存**（GPU 与 CPU 共用），vramGB = null、unifiedMemory = true
 *  - PC 是**独立显存**，必须拿到 vramGB，推荐引擎才能决定放几层到 GPU
 *
 * 解析逻辑全部是纯函数（导出供单测），系统调用只负责取原始文本。
 */
const { execFileSync } = require('child_process');
const os = require('os');
const fs = require('fs');

/* ================= 纯解析函数 ================= */

/** NVIDIA: nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits */
function parseNvidiaSmi(out) {
  const gpus = [];
  for (const line of String(out || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const [name, mem] = t.split(',').map((s) => s.trim());
    const mib = Number(mem);
    if (!name || !Number.isFinite(mib) || mib <= 0) continue;
    gpus.push({ name, vramGB: (mib * 1024 * 1024) / 1e9, vendor: 'nvidia' });
  }
  return gpus;
}

/** AMD ROCm: rocm-smi --showmeminfo vram --csv （取 VRAM Total Memory (B)） */
function parseRocmSmi(out) {
  const gpus = [];
  const text = String(out || '');
  // 逐行找 "cardN" 与其中的总显存字节数
  let current = null;
  for (const line of text.split('\n')) {
    const card = line.match(/(card\d+)/i);
    if (card) {
      if (current) gpus.push(current);
      current = { name: card[1], vramGB: 0, vendor: 'amd' };
    }
    const total = line.match(/VRAM Total Memory \(B\)[",\s]+(\d+)/i);
    if (total && current) current.vramGB = Number(total[1]) / 1e9;
  }
  if (current) gpus.push(current);
  return gpus.filter((g) => g.vramGB > 0);
}

/**
 * Windows 注册表 HardwareInformation.qwMemorySize（QWORD，最可靠的显存值）。
 * 输入可为 PowerShell 输出的十六进制（0x...）或十进制数字。
 */
function parseRegMemorySize(out) {
  const m = String(out || '').match(/0x[0-9a-f]+|\d+/i);
  if (!m) return null;
  const v = Number(m[0]);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v / 1e9;
}

/** Windows: Win32_VideoController 的 AdapterRAM（uint32，>4GB 会溢出，仅作兜底） */
function parseWmiAdapterRam(name, adapterRam) {
  const v = Number(adapterRam);
  // 0xFFFFFFFF / 接近上限说明溢出，不可信
  if (!Number.isFinite(v) || v <= 0 || v >= 4294967295) return null;
  return { name: String(name || '').trim() || 'GPU', vramGB: v / 1e9, vendor: null };
}

/** 取显存最大的显卡（多卡时关注主卡） */
function pickBestGpu(list) {
  const arr = (list || []).filter((g) => g && g.vramGB > 0);
  if (!arr.length) return null;
  return arr.slice().sort((a, b) => b.vramGB - a.vramGB)[0];
}

/** lscpu 输出 → 物理核/逻辑核 */
function parseLscpu(out) {
  const text = String(out || '');
  const num = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) : null;
  };
  const sockets = num(/^Socket\(s\):\s+(\d+)/m) || 1;
  const perSocket = num(/^Core\(s\) per socket:\s+(\d+)/m);
  const logical = num(/^CPU\(s\):\s+(\d+)/m);
  const pCores = perSocket ? perSocket * sockets : logical || 0;
  return { pCores, totalCores: logical || pCores };
}

/** PowerShell JSON（Get-CimInstance）→ {chip, pCores, totalCores} */
function parseWinCpu(json) {
  let j = json;
  if (typeof json === 'string') {
    try {
      j = JSON.parse(json);
    } catch {
      return null;
    }
  }
  if (!j) return null;
  const o = Array.isArray(j) ? j[0] : j;
  if (!o) return null;
  const p = Number(o.NumberOfCores) || 0;
  const l = Number(o.NumberOfLogicalProcessors) || 0;
  return {
    chip: String(o.Name || '').trim() || null,
    pCores: p || l,
    totalCores: l || p,
  };
}

/* ================= 系统调用 ================= */

function run(cmd, args, timeout = 8000) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function sysctl(key) {
  const v = run('sysctl', ['-n', key], 5000);
  return v === null ? null : v.trim();
}

function sysctlNum(key) {
  const v = sysctl(key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseVmStat() {
  const out = run('vm_stat', [], 5000);
  if (out === null) return null;
  const page = sysctlNum('hw.pagesize') || 16384;
  const get = (name) => {
    const m = out.match(new RegExp(`^\\s*${name}:\\s+(\\d+)`, 'm'));
    return m ? Number(m[1]) : 0;
  };
  // 可用内存 ≈ free + inactive（保守估算，speculative 不计）
  return ((get('Pages free') + get('Pages inactive')) * page) / 1e9;
}

function parseGpuMac() {
  const out = run('system_profiler', ['SPDisplaysDataType'], 15000);
  if (out === null) return null;
  const name = (out.match(/Chipset Model:\s*(.+)/) || [])[1];
  const cores = (out.match(/Total Number of Cores:\s*(\d+)/) || [])[1];
  const metal = (out.match(/Metal Support:\s*(.+)/) || [])[1];
  if (!name) return null;
  return {
    name: name.trim(),
    cores: cores ? Number(cores) : null,
    metal: metal ? metal.trim() : null,
    vramGB: null, // 统一内存：无独立显存
    vendor: 'apple',
  };
}

/* ================= 各平台检测 ================= */

function detectMac() {
  const ramBytes = sysctlNum('hw.memsize') || 0;
  const pCores = sysctlNum('hw.perflevel0.physicalcpu') || 0;
  const eCores = sysctlNum('hw.perflevel1.physicalcpu') || 0;
  const totalCores = sysctlNum('hw.ncpu') || pCores + eCores;
  return {
    platform: 'darwin',
    arch: os.arch(),
    chip: sysctl('machdep.cpu.brand_string') || 'Apple Silicon',
    pCores,
    eCores,
    totalCores,
    ramGB: ramBytes / 1e9,
    freeGB: parseVmStat(),
    gpu: parseGpuMac(),
    isAppleSilicon: os.arch() === 'arm64',
    unifiedMemory: os.arch() === 'arm64',
    hasDiscreteGpu: false,
  };
}

function detectLinux() {
  let memTotal = 0;
  let memAvail = null;
  try {
    const mi = fs.readFileSync('/proc/meminfo', 'utf8');
    const t = mi.match(/MemTotal:\s+(\d+) kB/);
    const a = mi.match(/MemAvailable:\s+(\d+) kB/);
    if (t) memTotal = Number(t[1]) * 1024;
    if (a) memAvail = Number(a[1]) * 1024;
  } catch {}
  let chip = null;
  try {
    const ci = fs.readFileSync('/proc/cpuinfo', 'utf8');
    const m = ci.match(/model name\s*:\s*(.+)/);
    if (m) chip = m[1].trim();
  } catch {}

  // 物理核 / 逻辑核
  const cpu = parseLscpu(run('lscpu', [], 5000) || '');
  const logical = os.cpus().length;
  const pCores = cpu.pCores || logical;

  // 显存：先 nvidia-smi，再 rocm-smi，最后 lspci 只取名字
  let gpus = parseNvidiaSmi(run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], 8000) || '');
  if (!gpus.length) gpus = parseRocmSmi(run('rocm-smi', ['--showmeminfo', 'vram', '--csv'], 8000) || '');
  let gpu = pickBestGpu(gpus);
  if (!gpu) {
    const out = run('sh', ['-c', 'lspci | grep -iE "vga|3d" | head -1'], 5000);
    if (out && out.trim()) {
      gpu = { name: out.trim(), cores: null, vramGB: null, vendor: null };
    }
  }

  return {
    platform: 'linux',
    arch: os.arch(),
    chip: chip || `${os.arch()} Linux`,
    pCores,
    eCores: 0,
    totalCores: logical || pCores,
    ramGB: memTotal / 1e9,
    freeGB: memAvail !== null ? memAvail / 1e9 : null,
    gpu,
    isAppleSilicon: false,
    unifiedMemory: false,
    hasDiscreteGpu: !!(gpu && gpu.vramGB),
  };
}

function detectWin() {
  // 一次 PowerShell 调用取 CPU + 显卡名 + 注册表显存（wmic 在新版 Windows 已移除）
  const ps = [
    '$ErrorActionPreference="SilentlyContinue"',
    '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors',
    '$vc = Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM',
    // 注册表里的 qwMemorySize 是 64 位，唯一能正确反映 >4GB 显存的值
    '$mem = @()',
    'Get-ChildItem "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}" -ErrorAction SilentlyContinue | ForEach-Object {',
    '  $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue',
    '  if ($p."HardwareInformation.qwMemorySize") { $mem += [pscustomobject]@{ Name = $p.DriverDesc; Size = $p."HardwareInformation.qwMemorySize" } }',
    '}',
    '[pscustomobject]@{ cpu = $cpu; vc = $vc; mem = $mem } | ConvertTo-Json -Depth 4 -Compress',
  ].join('; ');

  const raw = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], 15000);
  let parsed = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      parsed = null;
    }
  }

  const cpus = os.cpus();
  const cpuInfo = parseWinCpu(parsed && parsed.cpu) || {};
  const logical = cpus.length;

  // 显存：注册表 qwMemorySize 优先，其次 WMI AdapterRAM
  let gpu = null;
  const memList = (parsed && parsed.mem) || [];
  const vcList = parsed && parsed.vc ? (Array.isArray(parsed.vc) ? parsed.vc : [parsed.vc]) : [];
  const candidates = [];
  for (const m of Array.isArray(memList) ? memList : [memList]) {
    const gb = parseRegMemorySize(m && m.Size);
    if (gb) candidates.push({ name: String((m && m.Name) || '').trim() || 'GPU', vramGB: gb, vendor: null });
  }
  if (!candidates.length) {
    for (const v of vcList) {
      const g = parseWmiAdapterRam(v && v.Name, v && v.AdapterRAM);
      if (g) candidates.push(g);
    }
  }
  gpu = pickBestGpu(candidates);
  if (!gpu && vcList.length) {
    const name = String((vcList[0] && vcList[0].Name) || '').trim();
    if (name) gpu = { name, cores: null, vramGB: null, vendor: null };
  }

  return {
    platform: 'win32',
    arch: os.arch(),
    chip: cpuInfo.chip || cpus[0]?.model || 'CPU',
    pCores: cpuInfo.pCores || logical,
    eCores: 0,
    totalCores: cpuInfo.totalCores || logical,
    ramGB: os.totalmem() / 1e9,
    freeGB: os.freemem() / 1e9,
    gpu,
    isAppleSilicon: false,
    unifiedMemory: false,
    hasDiscreteGpu: !!(gpu && gpu.vramGB),
  };
}

function scan() {
  if (process.platform === 'darwin') return detectMac();
  if (process.platform === 'linux') return detectLinux();
  return detectWin();
}

module.exports = {
  scan,
  // 纯解析函数（单测用）
  parseNvidiaSmi,
  parseRocmSmi,
  parseRegMemorySize,
  parseWmiAdapterRam,
  pickBestGpu,
  parseLscpu,
  parseWinCpu,
};

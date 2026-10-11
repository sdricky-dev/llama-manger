'use strict';
/**
 * 硬件检测的纯解析函数（Windows/Linux 的显存与核心数）。
 * 用真实命令的样例输出驱动，保证在没有 Windows 机器时也能验证逻辑。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseNvidiaSmi,
  parseRocmSmi,
  parseRegMemorySize,
  parseWmiAdapterRam,
  pickBestGpu,
  parseLscpu,
  parseWinCpu,
} = require('../main/hardware');

test('parseNvidiaSmi：MiB → GB 换算与多卡', () => {
  const out = 'NVIDIA GeForce RTX 4090, 24564\nNVIDIA GeForce RTX 3060, 12288\n';
  const gpus = parseNvidiaSmi(out);
  assert.equal(gpus.length, 2);
  assert.equal(gpus[0].name, 'NVIDIA GeForce RTX 4090');
  assert.ok(Math.abs(gpus[0].vramGB - 25.76) < 0.05, `实际 ${gpus[0].vramGB}`);
  assert.equal(gpus[0].vendor, 'nvidia');
});

test('parseNvidiaSmi：空输出 / 异常行不产生垃圾数据', () => {
  assert.deepEqual(parseNvidiaSmi(''), []);
  assert.deepEqual(parseNvidiaSmi(null), []);
  assert.deepEqual(parseNvidiaSmi('name, memory.total [MiB]\n'), []);
  assert.deepEqual(parseNvidiaSmi('GPU, N/A'), []);
});

test('parseRocmSmi：解析 VRAM Total Memory', () => {
  const out = [
    'card0,VRAM Total Memory (B),25753026560',
    'card0,VRAM Total Used Memory (B),123456',
  ].join('\n');
  const gpus = parseRocmSmi(out);
  assert.equal(gpus.length, 1);
  assert.equal(gpus[0].vendor, 'amd');
  assert.ok(Math.abs(gpus[0].vramGB - 25.75) < 0.1, `实际 ${gpus[0].vramGB}`);
});

test('parseRegMemorySize：注册表 QWORD（十六进制/十进制）', () => {
  assert.ok(Math.abs(parseRegMemorySize('0x300000000') - 12.88) < 0.05); // 12GiB
  assert.ok(Math.abs(parseRegMemorySize('12884901888') - 12.88) < 0.05);
  assert.equal(parseRegMemorySize(''), null);
  assert.equal(parseRegMemorySize('abc'), null);
  assert.equal(parseRegMemorySize('0'), null);
});

test('parseWmiAdapterRam：普通值可用，溢出值（0xFFFFFFFF）判为不可信', () => {
  const ok = parseWmiAdapterRam('Intel UHD 630', 2147483648);
  assert.equal(ok.name, 'Intel UHD 630');
  assert.ok(Math.abs(ok.vramGB - 2.15) < 0.05);
  assert.equal(parseWmiAdapterRam('RTX 4090', 4294967295), null, 'uint32 溢出 → 不可信');
  assert.equal(parseWmiAdapterRam('x', 0), null);
  assert.equal(parseWmiAdapterRam('x', null), null);
});

test('pickBestGpu：多卡时取显存最大的', () => {
  const best = pickBestGpu([
    { name: 'iGPU', vramGB: 1 },
    { name: 'RTX 4090', vramGB: 24 },
    { name: 'RTX 3060', vramGB: 12 },
  ]);
  assert.equal(best.name, 'RTX 4090');
  assert.equal(pickBestGpu([]), null);
  assert.equal(pickBestGpu([{ name: 'x', vramGB: 0 }]), null);
});

test('parseLscpu：物理核 = 每槽核心 × 槽数，逻辑核单列', () => {
  const out = ['CPU(s):              24', 'Socket(s):           1', 'Core(s) per socket:  8'].join('\n');
  const r = parseLscpu(out);
  assert.equal(r.pCores, 8);
  assert.equal(r.totalCores, 24);

  const dual = ['CPU(s):              64', 'Socket(s):           2', 'Core(s) per socket:  16'].join('\n');
  assert.deepEqual(parseLscpu(dual), { pCores: 32, totalCores: 64 });
});

test('parseWinCpu：PowerShell JSON → 芯片与核心数（对象或数组）', () => {
  const single = { Name: 'AMD Ryzen 9 7950X', NumberOfCores: 16, NumberOfLogicalProcessors: 32 };
  assert.deepEqual(parseWinCpu(JSON.stringify(single)), {
    chip: 'AMD Ryzen 9 7950X',
    pCores: 16,
    totalCores: 32,
  });
  assert.equal(parseWinCpu(JSON.stringify([single])).pCores, 16);
  assert.deepEqual(parseWinCpu(single).chip, 'AMD Ryzen 9 7950X');
  assert.equal(parseWinCpu('not json'), null);
  assert.equal(parseWinCpu(null), null);
});

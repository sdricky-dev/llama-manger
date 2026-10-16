'use strict';
/**
 * 子进程沙箱化（main/sandbox.js）单元测试
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  macosSandboxProfile,
  linuxBubblewrapArgs,
  sandboxCapability,
  shouldEnableSandbox,
  wrapCommand,
  validateSandboxProfile,
  validateBubblewrapArgs,
} = require('../main/sandbox');

/* ---------- macosSandboxProfile ---------- */

test('macosSandboxProfile：基本结构（含 deny default + inbound）', () => {
  const p = macosSandboxProfile({ modelPath: '/m.gguf' });
  assert.match(p, /\(version 1\)/);
  assert.match(p, /\(deny default\)/);
  assert.match(p, /\(allow network inbound\)/);
  assert.match(p, /\(allow file-read/);
  assert.match(p, /\(allow file-write/);
});

test('macosSandboxProfile：默认只允许出站到本机（含 Unix socket）', () => {
  const p = macosSandboxProfile({ modelPath: '/m' });
  assert.match(p, /\(remote ip4 \(lo-127\.0\.0\.1\)\)/);
  // unix domain socket 是本地 IPC，仍允许
  assert.match(p, /\(remote unix\)/);
  // 不应允许 remote tcp（任意 IP）
  assert.doesNotMatch(p, /\(remote tcp\)/);
});

test('macosSandboxProfile：allowLanOut=true 时放行 remote tcp', () => {
  const p = macosSandboxProfile({ modelPath: '/m', allowLanOut: true });
  assert.match(p, /\(remote tcp\)/);
});

test('macosSandboxProfile：路径里的引号被转义', () => {
  // 用包含引号的目录路径（dirname 不会切掉中间的引号）
  const p = macosSandboxProfile({
    modelPath: '/foo"bar/baz.gguf',
    slotSavePath: '/quux"x/slots',
  });
  // SBPL 字符串里 " 必须转义为 \"
  assert.match(p, /\\"/);
});

test('macosSandboxProfile：slotSavePath 出现在 file-write 列表', () => {
  const p = macosSandboxProfile({
    modelPath: '/m',
    slotSavePath: '/var/data/slots',
  });
  assert.match(p, /\/var\/data\/sols|\/var\/data\/slots/);
});

test('macosSandboxProfile：无 modelPath / slotSavePath 时使用 home 兜底', () => {
  const p = macosSandboxProfile({});
  assert.match(p, /\(subpath "[^"]+"\)/); // 至少有 subpath
});

/* ---------- linuxBubblewrapArgs ---------- */

test('linuxBubblewrapArgs：基本结构（ro-bind / dev / chdir）', () => {
  const a = linuxBubblewrapArgs({
    bin: '/usr/bin/llama-server',
    args: ['-m', '/m.gguf'],
    modelPath: '/m.gguf',
  });
  assert.ok(Array.isArray(a));
  assert.ok(a.includes('--ro-bind'));
  assert.ok(a.includes('--dev'));
  assert.ok(a.includes('--chdir'));
  // 末尾应该是 "-- <bin> <args...>"
  const sepIdx = a.indexOf('--');
  assert.ok(sepIdx > 0, '应有 -- 分隔');
  assert.equal(a[sepIdx + 1], '/usr/bin/llama-server');
  assert.deepEqual(a.slice(sepIdx + 2), ['-m', '/m.gguf']);
});

test('linuxBubblewrapArgs：默认隔离（不暴露 LAN）', () => {
  const a = linuxBubblewrapArgs({ bin: 'x', args: [] });
  assert.ok(a.includes('--unshare-net-try'));
});

test('linuxBubblewrapArgs：allowLanOut=true 不隔离', () => {
  const a = linuxBubblewrapArgs({ bin: 'x', args: [], allowLanOut: true });
  assert.ok(!a.includes('--unshare-net-try'));
});

test('linuxBubblewrapArgs：模型目录 bind', () => {
  const a = linuxBubblewrapArgs({
    bin: 'x',
    args: [],
    modelPath: '/home/u/models/a.gguf',
  });
  // 应该把 /home/u/models bind 进去
  assert.ok(a.includes('/home/u/models'));
});

/* ---------- sandboxCapability ---------- */

test('sandboxCapability：macOS 支持 sandbox-exec', () => {
  const c = sandboxCapability('darwin');
  assert.equal(c.available, true);
  assert.equal(c.method, 'sandbox-exec');
});

test('sandboxCapability：Linux 支持 bubblewrap', () => {
  const c = sandboxCapability('linux');
  assert.equal(c.available, true);
  assert.equal(c.method, 'bubblewrap');
});

test('sandboxCapability：Windows 未实现', () => {
  const c = sandboxCapability('win32');
  assert.equal(c.available, false);
  assert.equal(c.method, null);
});

test('sandboxCapability：未知平台', () => {
  const c = sandboxCapability('freebsd');
  assert.equal(c.available, false);
});

/* ---------- shouldEnableSandbox ---------- */

test('shouldEnableSandbox：未开启 → 关', () => {
  const r = shouldEnableSandbox({ enabled: false }, 'darwin');
  assert.equal(r.enabled, false);
});

test('shouldEnableSandbox：开启 + macOS → 期望开（probe 依赖系统）', () => {
  const r = shouldEnableSandbox({ enabled: true }, 'darwin');
  // macOS 上 sandbox-exec 必然存在
  assert.equal(r.enabled, true);
  assert.equal(r.method, 'sandbox-exec');
});

test('shouldEnableSandbox：开启 + Windows → 关（不支持）', () => {
  const r = shouldEnableSandbox({ enabled: true }, 'win32');
  assert.equal(r.enabled, false);
  assert.match(r.reason, /Job Object|未实现/);
});

/* ---------- wrapCommand ---------- */

test('wrapCommand：macOS 返回 sandbox-exec + profileContent', () => {
  const r = wrapCommand({
    bin: '/usr/bin/llama-server',
    args: ['-m', '/m.gguf'],
    modelPath: '/m.gguf',
    platform: 'darwin',
  });
  assert.equal(r.cmd, '/usr/bin/sandbox-exec');
  assert.ok(Array.isArray(r.args));
  assert.ok(typeof r.profileContent === 'string' && r.profileContent.length > 0);
});

test('wrapCommand：Linux 返回 bwrap', () => {
  const r = wrapCommand({
    bin: '/usr/bin/llama-server',
    args: ['-m', '/m.gguf'],
    modelPath: '/m.gguf',
    platform: 'linux',
  });
  assert.equal(r.cmd, 'bwrap');
  assert.ok(r.args.includes('--ro-bind'));
});

test('wrapCommand：不支持平台 → 返回原命令', () => {
  const r = wrapCommand({
    bin: '/x',
    args: ['-m', '/m'],
    platform: 'win32',
  });
  assert.equal(r.cmd, '/x');
  assert.deepEqual(r.args, ['-m', '/m']);
});

/* ---------- validate* 工具 ---------- */

test('validateSandboxProfile：合法 profile', () => {
  const p = macosSandboxProfile({ modelPath: '/m' });
  assert.equal(validateSandboxProfile(p).ok, true);
});

test('validateSandboxProfile：缺 deny default', () => {
  const p = '(allow network inbound)\n(allow file-read)';
  const r = validateSandboxProfile(p);
  assert.equal(r.ok, false);
  assert.match(r.reason, /deny default/);
});

test('validateSandboxProfile：缺 inbound', () => {
  const p = '(deny default)\n(allow file-read)';
  const r = validateSandboxProfile(p);
  assert.equal(r.ok, false);
  assert.match(r.reason, /inbound/);
});

test('validateSandboxProfile：非字符串', () => {
  assert.equal(validateSandboxProfile(null).ok, false);
});

test('validateBubblewrapArgs：合法', () => {
  const a = linuxBubblewrapArgs({ bin: 'x', args: [] });
  assert.equal(validateBubblewrapArgs(a).ok, true);
});

test('validateBubblewrapArgs：缺 --ro-bind', () => {
  const a = ['--dev', '/dev', '--chdir', '/'];
  assert.equal(validateBubblewrapArgs(a).ok, false);
});

test('validateBubblewrapArgs：缺 --dev', () => {
  const a = ['--ro-bind', '/', '/', '--chdir', '/'];
  assert.equal(validateBubblewrapArgs(a).ok, false);
});

test('validateBubblewrapArgs：非数组', () => {
  assert.equal(validateBubblewrapArgs(null).ok, false);
  assert.equal(validateBubblewrapArgs('x').ok, false);
});
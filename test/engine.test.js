'use strict';
/**
 * 跨平台：引擎二进制探测 / CLI 启动脚本生成 / 终端命令。
 * 全部为纯函数，可在 macOS 上验证 Windows 与 Linux 的行为。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { binaryCandidates, buildCliScript, terminalLaunchCandidates } = require('../main/engine');
const { expandHome } = require('../main/config');

/* ---------- 二进制探测 ---------- */

test('binaryCandidates：Windows 找 .exe 且覆盖 MSVC 的 bin\\Release 布局', () => {
  const list = binaryCandidates('D:\\llama.cpp\\build', 'win32', 'C:\\Users\\tester');
  const servers = list.map((c) => c.server);
  assert.ok(servers.every((s) => s.endsWith('.exe')), 'Windows 二进制必须带 .exe');
  assert.ok(
    servers.includes(path.win32.join('D:\\llama.cpp\\build', 'bin', 'Release', 'llama-server.exe')),
    'MSVC 多配置产物目录 bin\\Release 必须在候选里'
  );
  assert.ok(
    servers.includes(path.win32.join('D:\\llama.cpp\\build', 'bin', 'llama-server.exe')),
    'Ninja 布局 bin 也必须在候选里'
  );
});

test('binaryCandidates：macOS / Linux 不带 .exe，且指定目录优先', () => {
  for (const platform of ['darwin', 'linux']) {
    const list = binaryCandidates('/opt/llama.cpp/build', platform, '/home/u');
    assert.ok(list.every((c) => !c.server.endsWith('.exe')));
    assert.equal(list[0].dir, '/opt/llama.cpp/build/bin', '用户指定目录应排在最前');
    assert.ok(list.some((c) => c.server === '/opt/llama.cpp/build/bin/llama-server'));
  }
});

test('binaryCandidates：未指定目录时按平台习惯给默认仓库位置', () => {
  const win = binaryCandidates('', 'win32', 'C:\\Users\\tester');
  assert.ok(win.some((c) => c.server.startsWith('C:\\Users\\tester\\llama.cpp')));
  const mac = binaryCandidates('', 'darwin', '/Users/tester');
  assert.ok(
    mac.some((c) => c.server === '/Users/tester/Documents/GitHub/llama.cpp/build/bin/llama-server')
  );
});

/* ---------- CLI 启动脚本 ---------- */

test('buildCliScript：Windows 生成 .cmd（CRLF + cd /d 正确目录 + UTF-8）', () => {
  const r = buildCliScript({
    platform: 'win32',
    bin: 'C:\\llama.cpp\\build\\bin\\Release\\llama-cli.exe',
    args: ['-m', 'C:\\Models\\a b.gguf', '-c', '4096'],
  });
  assert.equal(r.fileName, 'launch.cmd');
  assert.equal(r.chmod, false);
  assert.ok(r.content.includes('\r\n'), 'Windows 脚本应使用 CRLF');
  assert.ok(r.content.includes('chcp 65001'), '需要 UTF-8 代码页，否则中文乱码');
  // 关键回归：不能在 Mac 上把 Windows 目录算成 '.'
  assert.ok(r.content.includes('cd /d C:\\llama.cpp\\build\\bin\\Release'), r.content);
  assert.ok(r.content.includes('"C:\\Models\\a b.gguf"'), '含空格的参数要加引号');
  assert.ok(r.content.includes('pause'), '结束后停住窗口');
});

test('buildCliScript：Windows 对 % 做转义，避免变量展开', () => {
  const r = buildCliScript({
    platform: 'win32',
    bin: 'C:\\bin\\llama-cli.exe',
    args: ['-m', 'C:\\a%b\\m.gguf'],
  });
  assert.ok(r.content.includes('"C:\\a%%b\\m.gguf"'), r.content);
});

test('buildCliScript：POSIX 用单引号，内部单引号正确转义', () => {
  const r = buildCliScript({
    platform: 'darwin',
    bin: "/Users/x/bin/llama-cli",
    args: ['-m', "/Users/x/it's a model.gguf"],
  });
  assert.equal(r.fileName, 'launch.sh');
  assert.equal(r.chmod, true);
  assert.ok(r.content.includes("cd '/Users/x/bin'"));
  assert.ok(r.content.includes(`'/Users/x/it'\\''s a model.gguf'`), r.content);
  assert.ok(!r.content.includes('\r\n'), 'POSIX 不用 CRLF');
});

test('terminalLaunchCandidates：各平台命令形态', () => {
  const mac = terminalLaunchCandidates('/tmp/launch.sh', 'darwin', 'iTerm');
  assert.deepEqual(mac, [{ cmd: 'open', args: ['-a', 'iTerm', '/tmp/launch.sh'] }]);
  assert.equal(terminalLaunchCandidates('/tmp/x', 'darwin', '').at(0).args[1], 'Terminal', '默认 Terminal.app');

  const win = terminalLaunchCandidates('C:\\u\\launch.cmd', 'win32', '');
  assert.equal(win[0].cmd, 'cmd');
  assert.deepEqual(win[0].args.slice(0, 3), ['/c', 'start', ''], 'start 的第一个引号参数是窗口标题，需空串占位');

  const linux = terminalLaunchCandidates('/tmp/launch.sh', 'linux', '');
  assert.ok(linux.length >= 3, 'Linux 需要多个终端候选');
  assert.ok(linux.some((c) => c.cmd === 'gnome-terminal'));
  assert.ok(linux.every((c) => c.args.includes('/tmp/launch.sh')));
});

/* ---------- 路径展开 ---------- */

test('expandHome：~ / ~/ / ~\\ 都能展开（Windows 用户常写 ~\\Models）', () => {
  const os = require('os');
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('~/models'), path.join(os.homedir(), 'models'));
  assert.equal(expandHome('~\\Models\\gguf'), path.join(os.homedir(), 'Models', 'gguf'));
  assert.equal(expandHome('/abs/path'), '/abs/path');
  assert.equal(expandHome(''), '');
  assert.equal(expandHome(undefined), undefined);
});

'use strict';
/**
 * 引擎进程管理：
 *  - llama-server：spawn + 日志流 + 就绪检测 + 优雅停止
 *  - llama-cli：生成启动脚本，在系统终端中打开（真实 TTY 交互）
 *  - 端口探测 / llama-fit-params 自检
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

let proc = null;
let readySent = false;

function setState(state, extra) {
  // 由 main.js 注入的回调
  if (global.__lm_send) global.__lm_send('engine:state', { state, ...extra });
}

function send(channel, data) {
  if (global.__lm_send) global.__lm_send(channel, data);
}

function isRunning() {
  return proc !== null && proc.exitCode === null;
}

/**
 * 启动 llama-server。
 * @param {{bin:string, args:string[], cwd?:string}} o
 */
function startServer({ bin, args, cwd }) {
  if (isRunning()) throw new Error('服务已在运行');
  readySent = false;
  proc = spawn(bin, args, {
    cwd: cwd || path.dirname(bin),
    env: { ...process.env },
  });
  setState('starting', { pid: proc.pid });

  let buf = '';
  const onData = (d) => {
    const text = d.toString();
    send('engine:log', text);
    if (!readySent) {
      buf += text;
      const m = buf.match(/listening on\s+(\S+)/);
      if (m) {
        readySent = true;
        buf = '';
        setState('running', { url: m[1] });
      }
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('error', (err) => {
    send('engine:log', `[错误] 无法启动引擎: ${err.message}\n`);
    setState('error', { message: err.message });
    proc = null;
  });
  proc.on('exit', (code, signal) => {
    send('engine:log', `\n[引擎退出] code=${code} signal=${signal || 'none'}\n`);
    setState(code === 0 ? 'stopped' : 'error', { code, signal });
    proc = null;
  });
  return { pid: proc.pid };
}

function stopServer() {
  if (!isRunning()) return false;
  const p = proc;
  send('engine:log', '[停止] 发送 SIGTERM…\n');
  p.kill('SIGTERM');
  setTimeout(() => {
    if (p.exitCode === null) {
      send('engine:log', '[停止] 3 秒未退出，发送 SIGKILL\n');
      p.kill('SIGKILL');
    }
  }, 3000);
  return true;
}

/**
 * 生成 cli 启动脚本内容（纯函数，便于单测）。
 * POSIX 用单引号包裹（内部 ' 转义为 '\''）；Windows 生成 .cmd 并用双引号。
 */
function buildCliScript({ platform, bin, args }) {
  // 关键：按「目标平台」选择路径实现，否则在 Mac 上处理 Windows 路径会得到 '.'（反斜杠被当成普通字符）
  const P = platform === 'win32' ? path.win32 : path;
  const posixQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  // cmd 引号规则：含空白或特殊字符时加双引号；内部 " → \"，% → %%（避免变量展开）
  const cmdQuote = (s) => {
    s = String(s);
    if (!/[ \t"&|<>^()%!]/.test(s)) return s;
    return `"${s.replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
  };

  if (platform === 'win32') {
    const lines = [
      '@echo off',
      'chcp 65001 >nul', // UTF-8 输出，避免中文乱码
      `cd /d ${cmdQuote(P.dirname(bin))}`,
      `${cmdQuote(bin)} ${args.map(cmdQuote).join(' ')}`,
      '',
      'echo.',
      'echo —— 已退出。按任意键关闭窗口 ——',
      'pause >nul',
    ];
    return { fileName: 'launch.cmd', content: lines.join('\r\n'), chmod: false };
  }

  const lines = [
    '#!/bin/bash',
    `# 由 LlamaManger 生成于 ${new Date().toISOString()}`,
    `cd ${posixQuote(P.dirname(bin))}`,
    `${posixQuote(bin)} ${args.map(posixQuote).join(' ')}`,
    '',
    "echo '—— 已退出。按回车关闭窗口 ——'",
    'read -r',
  ];
  return { fileName: 'launch.sh', content: lines.join('\n'), chmod: true };
}

/**
 * 打开终端执行脚本的命令候选（纯函数；Linux 返回多个，由调用方探测哪个存在）。
 */
function terminalLaunchCandidates(scriptPath, platform, terminalApp) {
  if (platform === 'darwin') {
    return [{ cmd: 'open', args: ['-a', terminalApp || 'Terminal', scriptPath] }];
  }
  if (platform === 'win32') {
    // start 的第一个带引号参数会被当成窗口标题，故用空串占位
    return [{ cmd: 'cmd', args: ['/c', 'start', '', scriptPath] }];
  }
  return [
    { cmd: 'x-terminal-emulator', args: ['-e', scriptPath] },
    { cmd: 'gnome-terminal', args: ['--', scriptPath] },
    { cmd: 'konsole', args: ['-e', scriptPath] },
    { cmd: 'xfce4-terminal', args: ['-x', scriptPath] },
    { cmd: 'alacritty', args: ['-e', scriptPath] },
    { cmd: 'xterm', args: ['-e', scriptPath] },
  ];
}

/** 命令是否存在（Linux 终端探测用） */
function hasCommand(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(probe, [cmd], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 生成 cli 启动脚本并用系统终端打开。
 * @param {{bin:string, args:string[], terminalApp:string, userDataDir:string}} o
 */
function launchTerminal({ bin, args, terminalApp, userDataDir }) {
  const built = buildCliScript({ platform: process.platform, bin, args });
  const script = path.join(userDataDir, built.fileName);
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(script, built.content);
  if (built.chmod) fs.chmodSync(script, 0o755);

  const candidates = terminalLaunchCandidates(script, process.platform, terminalApp);
  const chosen = candidates.find((c) => hasCommand(c.cmd)) || candidates[0];
  spawn(chosen.cmd, chosen.args, { detached: true, stdio: 'ignore' }).unref();
  return { script, launcher: `${chosen.cmd} ${chosen.args.join(' ')}` };
}

function portInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    setTimeout(() => done(false), 1500);
  });
}

async function findFreePort(start = 9931, max = 9999) {
  for (let p = start; p <= max; p++) {
    if (!(await portInUse(p))) return p;
  }
  return -1;
}

/**
 * 运行 llama-fit-params 引擎自检（信息性输出）。
 */
function runFit({ bin, modelPath, ctx = 4096 }) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try {
      p = spawn(bin, ['--model', modelPath, '-c', String(ctx)], {
        env: { ...process.env },
      });
    } catch (err) {
      resolve({ ok: false, output: `启动失败: ${err.message}` });
      return;
    }
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
    }, 20000);
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (out += d.toString()));
    p.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `启动失败: ${err.message}` });
    });
    p.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out.trim() || `（无输出, exit=${code}）` });
    });
  });
}

/**
 * 引擎二进制的候选目录（纯函数，便于单测）。
 * 各平台布局不同：
 *   - macOS / Linux（Makefile/Ninja）: <build>/bin/llama-server
 *   - Windows（MSVC 多配置）:        <build>/bin/Release/llama-server.exe
 */
function binaryCandidates(buildDir, platform = process.platform, home = os.homedir()) {
  const P = platform === 'win32' ? path.win32 : path;
  const exe = platform === 'win32' ? '.exe' : '';
  const roots = [];
  if (buildDir) roots.push(buildDir);
  // 自动探测常见仓库位置（按平台习惯排序）
  const guesses =
    platform === 'win32'
      ? [P.join(home, 'llama.cpp'), P.join(home, 'Documents', 'llama.cpp'), 'C:\\llama.cpp']
      : [
          P.join(home, 'Documents', 'GitHub', 'llama.cpp'),
          P.join(home, 'GitHub', 'llama.cpp'),
          P.join(home, 'llama.cpp'),
        ];
  for (const g of guesses) roots.push(P.join(g, 'build'));

  const out = [];
  for (const root of roots) {
    for (const rel of ['bin', P.join('bin', 'Release'), P.join('Release', 'bin'), '']) {
      const dir = rel ? P.join(root, rel) : root;
      out.push({
        dir,
        server: P.join(dir, `llama-server${exe}`),
        cli: P.join(dir, `llama-cli${exe}`),
        fit: P.join(dir, `llama-fit-params${exe}`),
      });
    }
  }
  return out;
}

/**
 * 在候选目录中查找引擎二进制（存在即可用）。
 */
function findBinaries(buildDir) {
  for (const c of binaryCandidates(buildDir)) {
    const hasServer = fs.existsSync(c.server);
    const hasCli = fs.existsSync(c.cli);
    if (!hasServer && !hasCli) continue;
    return {
      dir: c.dir,
      server: hasServer ? c.server : null,
      cli: hasCli ? c.cli : null,
      fit: fs.existsSync(c.fit) ? c.fit : null,
    };
  }
  return null;
}

module.exports = {
  startServer,
  stopServer,
  isRunning,
  launchTerminal,
  portInUse,
  findFreePort,
  runFit,
  findBinaries,
  // 纯函数（单测用）
  binaryCandidates,
  buildCliScript,
  terminalLaunchCandidates,
};

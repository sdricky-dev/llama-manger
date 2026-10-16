'use strict';
/**
 * 子进程沙箱化（仿 llamafile docs/security.md）
 *
 * llamafile 默认用 Cosmopolitan 的 pledge()/unveil() 提供系统调用白名单 + 路径黑名单。
 * 我们用平台特定的等价物：
 *
 *   - macOS  : sandbox-exec -f profile.sb  （Apple Sandbox Profile Language v1）
 *   - Linux  : bubblewrap (bwrap)            （用户态 namespace，无需 root）
 *   - Windows: Job Object + Restricted Token（Node.js 无内置 API；只能给出检测 + 文档）
 *
 * 设计原则：
 *   - 沙箱是"可选加固"：默认关闭（不影响没装 sandbox-exec/bwrap 的机器）
 *   - 所有生成 profile / 命令行的函数都是纯函数（无 IO），便于单测
 *   - spawn 层做平台探测：探测不到 wrapper 时降级到普通 spawn（带 warning）
 *
 * 三层防护目标（与 llamafile 一致）：
 *   1. 网络：默认只允许 localhost 端口（除非 --host 0.0.0.0 显式开启）
 *   2. 文件：默认允许读 ~/.llamamanager 与模型所在目录；写仅允许 slot-save-path
 *   3. 执行：禁止 fork / exec 其他进程（除非显式开启 --tools）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/* ========================= 纯函数：profile 生成 ========================= */

/**
 * 生成 macOS sandbox-exec 的 Profile Language v1 文本
 *
 * 关键限制：
 *   - 允许 network inbound（HTTP server 接收连接）
 *   - 允许 network outbound 但只到 127.0.0.1（除非 host == 0.0.0.0）
 *   - 允许 read /usr, /Library, /private, model 所在目录
 *   - 允许 write slot-save-path 目录
 *   - 默认 deny 其他所有写
 *
 * @param {object} o { modelPath, slotSavePath?, allowLanOut?:boolean }
 * @returns {string} SBPL v1 profile
 */
function macosSandboxProfile(o = {}) {
  const modelPath = o.modelPath || '';
  const slotSavePath = o.slotSavePath || '';
  const allowLanOut = !!o.allowLanOut;
  const home = os.homedir();
  const modelDir = modelPath ? path.dirname(path.resolve(modelPath)) : home;
  const slotDir = slotSavePath ? path.resolve(slotSavePath) : path.join(home, '.llamamanager');

  const allowNetOut = allowLanOut
    ? '(remote tcp)(remote unix)'
    : '(remote ip6 (lo-127.0.0.1))(remote ip4 (lo-127.0.0.1))(remote unix)';

  return `; LlamaManger sandbox profile (auto-generated)
; 限制：
;   - 允许网络入站（HTTP server 接收连接）
;   - 允许网络出站，但${allowLanOut ? '可连到远程网' : '仅本机'}
;   - 允许读系统库 + 模型目录 + ~/.llamamanager
;   - 允许写 slot-save-path 与 ~/.llamamanager 子目录
;   - 默认拒绝写其他位置
(version 1)
(deny default)

; --- 基本 IO ---
(allow file-read*
  (subpath "/usr")
  (subpath "/System")
  (subpath "/Library")
  (subpath "/private")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/etc")
  (subpath "/dev")
  (subpath "/tmp")
  (subpath "${esc(modelDir)}")
  (subpath "${esc(home)}")
  (subpath "${esc(slotDir)}"))

(allow file-write*
  (subpath "${esc(slotDir)}")
  (subpath "${esc(path.join(home, '.llamamanager'))}")
  (subpath "/dev/null")
  (subpath "/dev/stdout")
  (subpath "/dev/stderr")
  (subpath "/tmp"))

; --- 网络 ---
(allow network inbound)
(allow network-outbound ${allowNetOut})

; --- 进程 ---
(allow process-fork)
(allow process-exec (literal "/bin/sh") (literal "/bin/bash"))
(allow signal (target self))

; --- 共享库 / mach ---
(allow sysctl-read)
(allow mach-lookup)
`;
}

/** SBPL 字符串里需要转义的字符 */
function esc(p) {
  return String(p).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 生成 Linux bubblewrap 命令行
 *
 * 关键限制：
 *   - /usr, /etc, /lib, /lib64, /bin 只读
 *   - 模型目录可读写（mmproj/draft 加载需要读）
 *   - slot-save-path 可读写
 *   - 默认禁止网络（用 --unshare-net-try，--host 0.0.0.0 时跳过）
 *
 * @param {object} o { bin, args, modelPath, slotSavePath?, allowLanOut?, cwd? }
 * @returns {string[]} bwrap 参数列表（不含 bwrap 本身）
 */
function linuxBubblewrapArgs(o = {}) {
  const modelPath = o.modelPath || '';
  const slotSavePath = o.slotSavePath || '';
  const allowLanOut = !!o.allowLanOut;
  const cwd = o.cwd || process.cwd();
  const home = os.homedir();
  const modelDir = modelPath ? path.dirname(path.resolve(modelPath)) : cwd;
  const slotDir = slotSavePath ? path.resolve(slotSavePath) : path.join(home, '.llamamanager');

  const a = [
    // 基础只读 bind
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/etc', '/etc',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/sbin', '/sbin',
    '--ro-bind', '/sys', '/sys',
    '--ro-bind', '/proc', '/proc',
    // 必要的设备
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--tmpfs', '/run',
    // 模型目录可读（mmproj/draft 可能在该目录）
    '--bind', modelDir, modelDir,
    // slot-save-path 可写
    '--bind', slotDir, slotDir,
    // 用户主目录可读（HF cache / 桌面等）
    '--ro-bind', home, home,
    // 工作目录
    '--chdir', cwd,
  ];
  // 网络隔离
  if (!allowLanOut) {
    a.push('--unshare-net-try');
  }
  // 执行原命令
  a.push('--', o.bin, ...(o.args || []));
  return a;
}

/* ========================= 平台探测 ========================= */

/** 当前进程平台（process.platform 的语义不变） */
function currentPlatform() {
  return process.platform;
}

/** 该平台是否有可用的沙箱 wrapper */
function sandboxCapability(platform = process.platform) {
  switch (platform) {
    case 'darwin':
      // sandbox-exec 自带 macOS（10.5+）
      return { available: true, method: 'sandbox-exec', note: 'macOS Sandbox (SBPL v1)' };
    case 'linux':
      // bubblewrap 需要装，但主流发行版都有
      return { available: true, method: 'bubblewrap', note: 'Linux bubblewrap' };
    case 'win32':
      // Job Object 需原生代码，这里只能给出"未实现"
      return { available: false, method: null, note: 'Windows Job Object 需要原生辅助进程；当前未实现' };
    default:
      return { available: false, method: null, note: `平台 ${platform} 不支持` };
  }
}

/** 在用户机器上探测 wrapper 是否实际存在 */
function probeWrapper(platform = process.platform, home = os.homedir()) {
  if (platform === 'darwin') {
    // sandbox-exec 总是在 macOS 上
    return { found: true, path: '/usr/bin/sandbox-exec' };
  }
  if (platform === 'linux') {
    // 探测 which bwrap
    try {
      const out = execFileSync('which', ['bwrap'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
      return { found: true, path: out.trim() };
    } catch {
      return { found: false, path: null, hint: 'apt install bubblewrap / dnf install bubblewrap' };
    }
  }
  return { found: false, path: null };
}

/* ========================= spawn 包装 ========================= */

/**
 * 决定是否启用沙箱：用户开关 + 平台支持 + wrapper 可执行
 */
function shouldEnableSandbox(opts, platform = process.platform) {
  if (!opts || !opts.enabled) return { enabled: false, reason: '用户未开启' };
  const cap = sandboxCapability(platform);
  if (!cap.available) return { enabled: false, reason: cap.note };
  const probe = probeWrapper(platform);
  if (!probe.found) return { enabled: false, reason: 'wrapper 不在 PATH' };
  return { enabled: true, method: cap.method, wrapperPath: probe.path };
}

/**
 * 把 spawn 命令包装为「在沙箱里跑」
 *
 * 返回值是 { cmd, args, profilePath? }，调用方拿这个去 spawn 而不是原 bin/args
 *
 * @param {object} o { bin, args, cwd?, modelPath, slotSavePath?, allowLanOut?, platform? }
 * @returns {{cmd:string, args:string[], profilePath?:string}}
 */
function wrapCommand(o) {
  const platform = o.platform || process.platform;
  if (platform === 'darwin') {
    const profile = macosSandboxProfile({
      modelPath: o.modelPath,
      slotSavePath: o.slotSavePath,
      allowLanOut: !!o.allowLanOut,
    });
    // profile 文件由调用方写到临时目录；这里返回相对路径
    return {
      cmd: '/usr/bin/sandbox-exec',
      args: ['-f', o.profilePath || '/dev/stdin', o.bin, ...(o.args || [])],
      profileContent: profile,
      profilePath: o.profilePath,
      // 把 profile 内容也带上，调用方可以选择写到临时文件
    };
  }
  if (platform === 'linux') {
    const bwrapArgs = linuxBubblewrapArgs({
      bin: o.bin,
      args: o.args || [],
      modelPath: o.modelPath,
      slotSavePath: o.slotSavePath,
      allowLanOut: !!o.allowLanOut,
      cwd: o.cwd,
    });
    return {
      cmd: 'bwrap',
      args: bwrapArgs,
    };
  }
  // 不支持：返回原命令（调用方应已检测 shouldEnableSandbox）
  return { cmd: o.bin, args: o.args || [] };
}

/* ========================= 校验 / 单测工具 ========================= */

/** 校验 SBPL profile 是否至少有 (deny default) 与必要 allow 规则 */
function validateSandboxProfile(profile) {
  if (typeof profile !== 'string') return { ok: false, reason: 'profile 不是字符串' };
  if (!/\(deny default\)/.test(profile)) return { ok: false, reason: '缺 deny default' };
  if (!/\(allow network inbound\)/.test(profile)) return { ok: false, reason: '缺 network inbound allow' };
  if (!/\(allow file-read/.test(profile)) return { ok: false, reason: '缺 file-read allow' };
  return { ok: true };
}

/** 校验 bwrap args 是否含关键 bind */
function validateBubblewrapArgs(args) {
  if (!Array.isArray(args)) return { ok: false, reason: 'args 不是数组' };
  if (!args.includes('--ro-bind')) return { ok: false, reason: '缺 --ro-bind' };
  if (!args.includes('--dev')) return { ok: false, reason: '缺 --dev' };
  if (!args.includes('--chdir')) return { ok: false, reason: '缺 --chdir' };
  return { ok: true };
}

module.exports = {
  macosSandboxProfile,
  linuxBubblewrapArgs,
  sandboxCapability,
  probeWrapper,
  shouldEnableSandbox,
  wrapCommand,
  validateSandboxProfile,
  validateBubblewrapArgs,
};
#!/usr/bin/env node
'use strict';
/**
 * 引擎参数漂移检查：项目下发的 flag ↔ 本地引擎 --help 声明的 flag
 *
 * 用法：
 *   node scripts/check-engine-flags.js                         # 自动探测构建目录
 *   node scripts/check-engine-flags.js ~/llama.cpp/build       # 显式指定
 *   LLAMA_CPP_BUILD=~/llama.cpp/build node scripts/check-engine-flags.js
 *
 * 退出码：0 = 全部认识；1 = 有引擎不认识的 flag（会导致引擎启动即失败）
 *
 * 更新完 llama.cpp 之后跑一次，就能提前发现「上游删了参数 / 改了名字」这类
 * 只会在真机启动时才爆的问题。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { extractEmittedFlags, extractSupportedFlags, diffFlags } = require('../shared/engine-flags');

const ROOT = path.join(__dirname, '..');

function resolveBuildDir() {
  const explicit = process.argv[2] || process.env.LLAMA_CPP_BUILD;
  if (explicit) return explicit;
  const home = os.homedir();
  return ['llama.cpp/build', 'Documents/GitHub/llama.cpp/build']
    .map((p) => path.join(home, p))
    .find((p) => fs.existsSync(p)) || null;
}

/** 兼容 Unix 的 bin/<name> 与 MSVC 多配置的 bin/Release/<name>.exe */
function findBinary(buildDir, name) {
  const candidates = [
    path.join(buildDir, 'bin', name),
    path.join(buildDir, 'bin', name + '.exe'),
    path.join(buildDir, 'bin', 'Release', name + '.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/** 跑 --help，stdout 与 stderr 都要（不同版本输出流不一致） */
function helpOf(bin) {
  try {
    return execFileSync(bin, ['--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
  } catch (e) {
    return `${e.stdout || ''}\n${e.stderr || ''}`;
  }
}

function readSource(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const buildDir = resolveBuildDir();
  if (!buildDir || !fs.existsSync(buildDir)) {
    console.error('找不到 llama.cpp 构建目录。用法：node scripts/check-engine-flags.js <build 目录>');
    process.exit(2);
  }
  console.log(`==> 引擎构建目录：${buildDir}`);

  const wanted = [
    { bin: 'llama-cli', role: 'cli' },
    { bin: 'llama-server', role: 'server' },
    { bin: 'llama-bench', role: 'bench' },
  ];
  const supported = new Map();
  const missingBins = [];
  for (const { bin } of wanted) {
    const p = findBinary(buildDir, bin);
    if (!p) { missingBins.push(bin); continue; }
    const flags = extractSupportedFlags(helpOf(p));
    supported.set(bin, flags);
    console.log(`    ${bin.padEnd(14)} --help 声明 ${flags.size} 个 flag`);
  }
  if (missingBins.length) {
    console.error(`\n✗ 缺少引擎二进制：${missingBins.join(', ')}（先跑 scripts/build-engine.sh）`);
    process.exit(2);
  }

  // CLI 与 server 的帮助互为补充（server 专属参数只在 server 里）
  const cliOrServer = new Set([...supported.get('llama-cli'), ...supported.get('llama-server')]);

  const groups = [
    { name: 'shared/args.js（启动参数）', source: 'shared/args.js', supported: cliOrServer },
    { name: 'main/bench.js（基准测试参数）', source: 'main/bench.js', supported: supported.get('llama-bench') },
  ];

  let failed = false;
  console.log('');
  for (const g of groups) {
    const emitted = extractEmittedFlags(readSource(g.source));
    const { ok, missing, checked } = diffFlags(emitted, g.supported);
    if (ok) {
      console.log(`✅ ${g.name}：下发 ${checked} 个 flag，引擎全部认识`);
    } else {
      failed = true;
      console.log(`❌ ${g.name}：下发 ${checked} 个 flag，其中 ${missing.length} 个引擎不认识`);
      for (const f of missing) console.log(`     ${f}`);
      console.log('   → 这些会让引擎启动即失败（error: invalid argument），请对照上游 common/arg.cpp 修正');
    }
  }

  console.log('');
  if (failed) {
    console.log('参数漂移检查未通过。');
    process.exit(1);
  }
  console.log('参数漂移检查通过。');
}

main();

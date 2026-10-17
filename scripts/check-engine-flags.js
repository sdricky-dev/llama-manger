#!/usr/bin/env node
'use strict';
/**
 * 引擎参数漂移检查：项目下发的 flag ↔ 引擎认识的 flag
 *
 * 两种模式：
 *
 *   1) 帮助模式（默认，最准，需要本地已编译的引擎）
 *        node scripts/check-engine-flags.js                      # 自动探测构建目录
 *        node scripts/check-engine-flags.js ~/llama.cpp/build     # 显式指定
 *        LLAMA_CPP_BUILD=~/llama.cpp/build node scripts/check-engine-flags.js
 *      跑 llama-cli / llama-server / llama-bench 的 --help，取并集对照。
 *
 *   2) 源码模式（不需要编译，给 CI 用）
 *        node scripts/check-engine-flags.js --source ~/llama.cpp/common/arg.cpp
 *      解析 common/arg.cpp 里 common_arg({...}) 的声明。
 *      只覆盖 shared/args.js（启动参数）；llama-bench 自己的参数不在 arg.cpp 里。
 *
 * 退出码：0 = 全部认识；1 = 有引擎不认识的 flag（会让引擎启动即失败）；2 = 环境问题
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  extractEmittedFlags,
  extractSupportedFlags,
  extractDeclaredFlagsFromSource,
  diffFlags,
} = require('../shared/engine-flags');

const ROOT = path.join(__dirname, '..');

function readSource(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    return '';
  }
}

function report(groups) {
  let failed = false;
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

/* ---------- 模式 1：读引擎 --help ---------- */

function resolveBuildDir(explicit) {
  if (explicit) return explicit;
  if (process.env.LLAMA_CPP_BUILD) return process.env.LLAMA_CPP_BUILD;
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

function runHelpMode(buildDirArg) {
  const buildDir = resolveBuildDir(buildDirArg);
  if (!buildDir || !fs.existsSync(buildDir)) {
    console.error('找不到 llama.cpp 构建目录。用法：node scripts/check-engine-flags.js <build 目录>');
    process.exit(2);
  }
  console.log(`==> 引擎构建目录：${buildDir}`);

  const bins = ['llama-cli', 'llama-server', 'llama-bench'];
  const supported = new Map();
  const missing = [];
  for (const bin of bins) {
    const p = findBinary(buildDir, bin);
    if (!p) { missing.push(bin); continue; }
    const flags = extractSupportedFlags(helpOf(p));
    supported.set(bin, flags);
    console.log(`    ${bin.padEnd(14)} --help 声明 ${flags.size} 个 flag`);
  }
  if (missing.length) {
    console.error(`\n✗ 缺少引擎二进制：${missing.join(', ')}（先跑 scripts/build-engine.sh）`);
    process.exit(2);
  }

  // CLI 与 server 的帮助互为补充（server 专属参数只在 server 里）
  const cliOrServer = new Set([...supported.get('llama-cli'), ...supported.get('llama-server')]);

  console.log('');
  report([
    { name: 'shared/args.js（启动参数）', source: 'shared/args.js', supported: cliOrServer },
    { name: 'main/bench.js（基准测试参数）', source: 'main/bench.js', supported: supported.get('llama-bench') },
  ]);
}

/* ---------- 模式 2：读上游源码（CI 用，无需编译） ---------- */

function runSourceMode(sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    console.error('找不到 common/arg.cpp。用法：node scripts/check-engine-flags.js --source <llama.cpp>/common/arg.cpp');
    process.exit(2);
  }
  const declared = extractDeclaredFlagsFromSource(fs.readFileSync(sourcePath, 'utf8'));
  console.log(`==> 上游源码：${sourcePath}`);
  console.log(`    common/arg.cpp 声明 ${declared.size} 个 flag`);
  console.log('    注意：源码模式只覆盖 shared/args.js；llama-bench 自己的参数不在此文件内，');
  console.log('          完整检查请在有编译产物的机器上跑帮助模式。');
  console.log('');
  report([{ name: 'shared/args.js（启动参数）', source: 'shared/args.js', supported: declared }]);
}

/* ---------- 入口 ---------- */

const argv = process.argv.slice(2);
const srcIdx = argv.indexOf('--source');
if (srcIdx >= 0) {
  runSourceMode(argv[srcIdx + 1]);
} else {
  runHelpMode(argv.find((a) => !a.startsWith('--')));
}

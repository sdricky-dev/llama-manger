'use strict';
/**
 * CLI 参数迁移层（仿 llamafile/llamafile/args.cpp 的 legacy_load_flag）
 *
 * 触发场景：
 *   1. 用户从旧版本升级时，settings.json 里有已被 llama.cpp 改名的字段
 *   2. 旧版本用的是 --mmap / --no-mmap / --mlock / -dio 等离散 flag；
 *      llama.cpp b11100 之后改用 --load-mode auto|none|mmap|mlock|mmap+mlock|dio
 *
 * 翻译规则（与 llamafile/args.cpp legacy_load_flag 对齐）：
 *   --mmap       true  → loadMode='mmap'（mmap=true 默认行为，可省）
 *   --mmap       false → loadMode='none'
 *   --mlock      true  → loadMode='mmap+mlock'（llama.cpp 用 mlock 隐含 mmap）
 *   -dio /       true  → loadMode='dio'   （DIO 优先级最高，覆盖 mmap/mlock）
 *   -ndio / false      → 保持原状（恢复 mmap）
 *   多个一起时：dio > mlock > mmap，最后写 wins（与 llama.cpp 行为一致）
 *
 * 此模块只放**纯函数**：
 *   - migrateParams(params) → { params, migrations, hasBreakingChanges }
 *   - mergeLoadFlags({ mmap, mlock, dio }) → 'auto'|'none'|'mmap'|'mlock'|'mmap+mlock'|'dio'
 */

/**
 * 合并三个布尔标志为一个 loadMode 字符串（与 llama.cpp 一致）
 *
 * @param {{mmap?:boolean, mlock?:boolean, dio?:boolean}} flags
 * @returns {string} loadMode 值
 */
function mergeLoadFlags({ mmap, mlock, dio } = {}) {
  if (dio) return 'dio';
  // dio 为 false → 隐含回退到 mmap（如 -ndio）
  // llama.cpp 的语义：DIO 优先级最高，关闭则退回 mmap
  if (dio === false) mmap = (mlock || mmap) ? true : mmap;
  if (mlock) return mmap ? 'mmap+mlock' : 'mlock';
  if (mmap === false) return 'none';
  return 'mmap';
}

/**
 * 把旧版离散字段翻译为新版 loadMode
 *
 * 输入可能是 settings.json 反序列化得到的对象：
 *   { mmap: true/false, mlock: true/false, directIo: true/false }
 * 或者已经是新版的：
 *   { loadMode: 'mmap+mlock' }
 *
 * @param {object} params
 * @returns {{params:object, migrations:Array<{from:string,to:string,reason:string}>}}
 */
function migrateParams(params) {
  const out = params && typeof params === 'object' ? { ...params } : {};
  const migrations = [];

  // loadMode 优先；只有「用户没真正选过」时才从旧字段翻译。
  // 'auto' 视为没选过 —— 老版本 settings.json 里 mlock/mmap/dio 与 loadMode:'auto'
  // 会同时存在，若把 'auto' 当成明确选择，用户的 mlock 意图会被静默丢掉。
  const loadModeChosen = typeof out.loadMode === 'string' && out.loadMode !== '' && out.loadMode !== 'auto';
  if (!loadModeChosen) {
    // 只有「携带意图」的旧字段才值得翻译：
    //   - mmap 出现（true→mmap / false→none）
    //   - mlock 为 true
    //   - directIo / dio / ndio 出现（含 false，-ndio 语义是"恢复 mmap"）
    // 而 `mlock: false` 这种「UI 默认值被顺手存进 settings.json」的情况没有任何意图，
    // 翻译它只会凭空多出一个 `--load-mode mmap`（引擎默认本来就是 mmap）。
    const hasIntent =
      'mmap' in out ||
      out.mlock === true ||
      'directIo' in out ||
      'dio' in out ||
      'ndio' in out;
    if (hasIntent) {
      const mlock = !!out.mlock;
      // directIo / dio / ndio 三个字段在历史版本里都有人用，统一读取
      let dio = null;
      if ('directIo' in out) dio = !!out.directIo;
      else if ('dio' in out) dio = !!out.dio;
      else if ('ndio' in out) dio = out.ndio ? false : null;

      const mmap = 'mmap' in out ? !!out.mmap : null;
      const mode = mergeLoadFlags({ mmap, mlock, dio });
      out.loadMode = mode;

      // 记录每一项迁移
      if ('mmap' in out) migrations.push({ from: 'mmap', to: `loadMode=${mode}`, reason: 'llama.cpp b11100: --mmap 被 --load-mode 替代' });
      if ('mlock' in out) migrations.push({ from: 'mlock', to: `loadMode=${mode}`, reason: 'llama.cpp b11100: --mlock 被 --load-mode 替代' });
      if ('directIo' in out || 'dio' in out || 'ndio' in out) {
        const k = 'directIo' in out ? 'directIo' : ('dio' in out ? 'dio' : 'ndio');
        migrations.push({ from: k, to: `loadMode=${mode}`, reason: 'llama.cpp b11100: -dio/-ndio 被 --load-mode 替代' });
      }
    }
  }

  // 删掉已迁移的旧字段，避免重复翻译
  for (const k of ['mmap', 'mlock', 'directIo', 'dio', 'ndio']) {
    if (k in out) delete out[k];
  }

  // 检测其他已废弃的命名（如老版本用过的 _cmoe 之类）
  if ('cmoeInCpu' in out && !('cpuMoe' in out)) {
    out.cpuMoe = !!out.cmoeInCpu;
    migrations.push({ from: 'cmoeInCpu', to: 'cpuMoe', reason: '字段重命名：cmoeInCpu → cpuMoe' });
    delete out.cmoeInCpu;
  }

  return {
    params: out,
    migrations,
    hasBreakingChanges: migrations.length > 0,
  };
}

/**
 * 把 buildArgs 输出的 argv 数组做"老 flag → 新 flag"翻译
 * （这是最后一道防线，settings.json 之外从命令行或脚本传入的参数）
 *
 * @param {string[]} argv
 * @returns {{argv:string[], warnings:string[]}}
 */
function migrateArgv(argv) {
  const list = Array.isArray(argv) ? argv.slice() : [];
  const warnings = [];
  const out = [];
  let mmap = null, mlock = null, dio = null;
  let sawAnyLegacy = false;

  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--mmap') {
      mmap = true; sawAnyLegacy = true;
      warnings.push('--mmap 已废弃；自动翻译为 --load-mode');
      continue;
    }
    if (a === '--no-mmap') {
      mmap = false; sawAnyLegacy = true;
      warnings.push('--no-mmap 已废弃；自动翻译为 --load-mode');
      continue;
    }
    if (a === '--mlock') {
      mlock = true; sawAnyLegacy = true;
      warnings.push('--mlock 已废弃；自动翻译为 --load-mode');
      continue;
    }
    if (a === '-dio' || a === '--direct-io') {
      dio = true; sawAnyLegacy = true;
      warnings.push(`${a} 已废弃；自动翻译为 --load-mode`);
      continue;
    }
    if (a === '-ndio' || a === '--no-direct-io') {
      dio = false; sawAnyLegacy = true;
      warnings.push(`${a} 已废弃；自动翻译为 --load-mode`);
      continue;
    }
    out.push(a);
  }

  if (sawAnyLegacy) {
    const mode = mergeLoadFlags({ mmap, mlock, dio });
    out.push('--load-mode', mode);
  }

  return { argv: out, warnings };
}

module.exports = {
  mergeLoadFlags,
  migrateParams,
  migrateArgv,
};
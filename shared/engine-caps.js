'use strict';
/**
 * 引擎 Metal 能力哨兵（纯函数，供 main/engine.js 与单测共用）
 *
 * 为什么需要它：
 *   M5 起 GPU 里有「神经加速器」，llama.cpp 通过 Metal 4 的 tensor API 使用它。
 *   实测同一模型同一引擎（ZDTaichu 9B Q5_K_M / M5 Max）：
 *     tensor API 开 → prompt 2310 t/s
 *     tensor API 关 → prompt  837 t/s   （约 2.8×）
 *   但这条路径是**静默失败**的：芯片名不在白名单、Metal 版本不够、tensor kernel
 *   编译不过、或环境里设了 GGML_METAL_TENSOR_DISABLE，引擎只会打一行 WARN，
 *   然后退回 simdgroup 路径 —— 界面上看不出任何差别，只有速度掉了三倍。
 *
 * 引擎日志里的关键行（ggml-metal-device.m）：
 *   ggml_metal_device_init: GPU name:   MTL0 (Apple M5 Max)
 *   ggml_metal_device_init: has tensor            = true
 *   ggml_metal_device_init: has bfloat            = true
 *   ggml_metal_library_init: using embedded metal library
 */

// 与 ggml-metal-device.m 的芯片白名单保持一致：M5/M6/A19/A20 默认启用 tensor API
const TENSOR_CHIP_RE = /M5|M6|A19|A20/;

/** 这颗芯片是否属于「上游默认启用 tensor API」的型号 */
function chipExpectsTensor(chip) {
  return TENSOR_CHIP_RE.test(String(chip || ''));
}

/**
 * 从引擎日志片段里抽取 Metal 能力。
 * @param {string} text
 * @returns {{gpuName?:string, hasTensor?:boolean, hasBfloat?:boolean, embeddedMetal?:boolean}|null}
 */
function parseEngineCaps(text) {
  const s = String(text || '');
  if (!s) return null;
  const out = {};
  const gpu = s.match(/GPU name:\s*\S+\s*\(([^)]+)\)/);
  if (gpu) out.gpuName = gpu[1].trim();
  const tensor = s.match(/has tensor\s*=\s*(true|false)/);
  if (tensor) out.hasTensor = tensor[1] === 'true';
  const bfloat = s.match(/has bfloat\s*=\s*(true|false)/);
  if (bfloat) out.hasBfloat = bfloat[1] === 'true';
  if (/using embedded metal library/.test(s)) out.embeddedMetal = true;
  return Object.keys(out).length ? out : null;
}

/**
 * 给出界面上的提示。
 *
 * @param {{platform?:string, chip?:string, caps?:object}} o
 * @returns {{level:'none'|'ok'|'bad', text?:string, title?:string}}
 */
function metalVerdict({ platform, chip, caps } = {}) {
  if (platform !== 'darwin') return { level: 'none' };
  const c = caps || {};
  const name = chip || c.gpuName || '';
  const expected = chipExpectsTensor(name);

  if (c.hasTensor === true) {
    return {
      level: 'ok',
      text: expected ? '神经加速器 ✓' : 'Metal tensor ✓',
      title: `${name || 'Metal'}：Metal 4 tensor API 已启用，prefill 走 GPU 神经加速器`,
    };
  }
  if (c.hasTensor === false && expected) {
    return {
      level: 'bad',
      text: '神经加速器未启用',
      title:
        '本机是 M5 级芯片，但引擎没有启用 Metal 4 tensor API，prefill 会慢约 2.8×。' +
        '检查：① 构建用的 macOS SDK 是否支持 Metal 4（需较新的 Xcode）；' +
        '② 环境变量里是否设了 GGML_METAL_TENSOR_DISABLE；' +
        '③ 引擎日志里 "testing tensor API" 之后是否有 "not supported in this environment"。',
    };
  }
  // 非 M5 级芯片且 tensor 关闭：上游默认行为，不打扰
  return { level: 'none' };
}

module.exports = { chipExpectsTensor, parseEngineCaps, metalVerdict };

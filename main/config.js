'use strict';
/**
 * 设置持久化：userData/settings.json
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function settingsPath(appUserData) {
  return path.join(appUserData, 'settings.json');
}

/**
 * 展开 ~ / ~/ / ~\（Windows 用户也常写 ~\Models），并把分隔符统一为当前平台形式。
 */
function expandHome(p) {
  if (!p) return p;
  const s = String(p).trim();
  if (s === '~') return os.homedir();
  if (/^~[/\\]/.test(s)) {
    const rest = s.slice(2).split(/[/\\]+/).filter(Boolean);
    return path.join(os.homedir(), ...rest);
  }
  return s;
}

function load(appUserData) {
  const def = {
    modelDir: path.join(os.homedir(), 'models'),
    buildDir: '', // 空 = 自动探测
    terminalApp: 'Terminal',
    mode: 'server',
    modelPath: '',
    params: null,
  };
  try {
    const raw = fs.readFileSync(settingsPath(appUserData), 'utf8');
    const j = JSON.parse(raw);
    return { ...def, ...j };
  } catch {
    return def;
  }
}

function save(appUserData, settings) {
  const p = settingsPath(appUserData);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(settings, null, 2));
  return p;
}

module.exports = { load, save, expandHome, settingsPath };

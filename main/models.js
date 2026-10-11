'use strict';
/**
 * 模型目录扫描：递归查找 *.gguf，解析元数据。
 */
const fs = require('fs');
const path = require('path');
const { parseModelFile, DECISION_TYPES } = require('./gguf');

function findGgufFiles(dir, depth = 0) {
  const out = [];
  if (depth > 5) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      out.push(...findGgufFiles(full, depth + 1));
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.gguf')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 扫描模型目录，按角色归类：
 *  - models：可独立加载的对话模型（每个带 companions：同目录的 mmproj / draft 附属文件）
 *  - companions：全部附属文件
 *  - orphans：没配上主模型的附属文件
 * @param {string} dir 模型目录
 * @returns {{models: object[], companions: object[], orphans: object[], warnings: string[]}}
 */
function scanDir(dir) {
  const warnings = [];
  const files = findGgufFiles(dir).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
  const parsed = [];
  for (const f of files) {
    try {
      parsed.push(parseModelFile(f));
    } catch (err) {
      warnings.push(`${f}: ${err.message}`);
    }
  }

  const byDir = new Map();
  for (const m of parsed) {
    if (m.role === 'model') continue;
    const d = path.dirname(m.path);
    if (!byDir.has(d)) byDir.set(d, { mmproj: [], draft: [] });
    const bucket = byDir.get(d);
    if (m.role === 'mmproj') bucket.mmproj.push(m);
    else bucket.draft.push(m);
  }

  const brief = (c) => ({
    path: c.path,
    name: c.name,
    quant: c.quant,
    sizeBytes: c.sizeBytes,
    sizeGB: c.sizeGB,
    vision: c.vision || null,
  });

  const models = parsed.filter((m) => m.role === 'model');
  for (const m of models) {
    const bucket = byDir.get(path.dirname(m.path)) || { mmproj: [], draft: [] };
    m.companions = {
      mmproj: bucket.mmproj.map(brief),
      draft: bucket.draft.map(brief),
    };
  }

  const usedDirs = new Set(models.map((m) => path.dirname(m.path)));
  const companions = parsed.filter((m) => m.role !== 'model').map(brief);
  const orphans = parsed
    .filter((m) => m.role !== 'model' && !usedDirs.has(path.dirname(m.path)))
    .map(brief);

  return { models, companions, orphans, warnings, decisionTypes: DECISION_TYPES };
}

module.exports = { scanDir, findGgufFiles };

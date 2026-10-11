/**
 * 路径字符串工具（渲染层用，纯字符串、不依赖 node）。
 *
 * 同时兼容 / 与 \ 分隔符：渲染层拿到的路径来自主进程扫描结果，
 * 在 Windows 上是反斜杠形式，在 macOS/Linux 上是斜杠形式。
 */

/** 取文件名（最后一段） */
export function baseName(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** 取所在目录；路径本身带末尾分隔符时视为目录，原样返回（去掉分隔符） */
export function dirOf(p) {
  const s = String(p || '');
  if (/[\\/]+$/.test(s)) return s.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i > 0 ? s.slice(0, i) : s;
}

/** 拼接目录与文件名，沿用目录本身的分隔符风格 */
export function joinPath(dir, name) {
  const d = String(dir || '').replace(/[\\/]+$/, '');
  return d.includes('\\') ? `${d}\\${name}` : `${d}/${name}`;
}

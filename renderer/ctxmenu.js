/**
 * 轻量右键菜单（无依赖）。
 *
 * 用法：
 *   showMenu(x, y, [
 *     { type: 'head', label: '文件名', sub: '完整路径' },
 *     { icon: '📂', label: '在文件夹中显示', onClick: () => {} },
 *     { type: 'sep' },
 *     { label: '删除', danger: true, onClick: () => {} },
 *   ]);
 *
 * 关闭：点击别处 / Esc / 滚轮 / 窗口失焦 / 缩放。
 */

let el = null;
let opened = false;

function ensureEl() {
  if (el && el.isConnected) return el;
  el = document.createElement('div');
  el.className = 'ctx-menu hidden';
  el.setAttribute('role', 'menu');
  // 菜单内部的按下事件不要冒泡到 document，否则会被“点击别处”逻辑关掉
  el.addEventListener('mousedown', (e) => e.stopPropagation());
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  document.body.appendChild(el);
  return el;
}

export function hideMenu() {
  if (!el) return;
  el.classList.add('hidden');
  el.textContent = '';
  opened = false;
}

export function isMenuOpen() {
  return opened;
}

function makeItem(item) {
  if (item.type === 'sep') {
    const s = document.createElement('div');
    s.className = 'ctx-sep';
    return s;
  }
  if (item.type === 'head') {
    const h = document.createElement('div');
    h.className = 'ctx-head';
    const b = document.createElement('b');
    b.textContent = item.label || '';
    h.appendChild(b);
    if (item.sub) {
      const s = document.createElement('span');
      s.textContent = item.sub;
      s.title = item.sub;
      h.appendChild(s);
    }
    return h;
  }
  if (item.type === 'note') {
    const n = document.createElement('div');
    n.className = 'ctx-note';
    n.textContent = item.label || '';
    return n;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ctx-item' + (item.danger ? ' danger' : '');
  btn.disabled = !!item.disabled;
  btn.title = item.hint || item.label || '';
  const ico = document.createElement('span');
  ico.className = 'ctx-ico';
  ico.textContent = item.icon || '';
  const lbl = document.createElement('span');
  lbl.className = 'ctx-lbl';
  lbl.textContent = item.label || '';
  btn.append(ico, lbl);
  if (item.tail) {
    const t = document.createElement('span');
    t.className = 'ctx-tail';
    t.textContent = item.tail;
    btn.appendChild(t);
  }
  btn.onclick = () => {
    hideMenu();
    try {
      const r = item.onClick && item.onClick();
      if (r && typeof r.catch === 'function') r.catch((err) => console.error('[ctxmenu]', err));
    } catch (err) {
      console.error('[ctxmenu]', err);
    }
  };
  return btn;
}

/** 在 (x, y) 处弹出菜单，自动夹取到视口内 */
export function showMenu(x, y, items) {
  const m = ensureEl();
  m.textContent = '';
  for (const it of items || []) {
    if (!it) continue;
    m.appendChild(makeItem(it));
  }
  if (!m.childElementCount) return;
  m.style.left = '0px';
  m.style.top = '0px';
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  const pad = 8;
  const left = Math.max(pad, Math.min(x, window.innerWidth - r.width - pad));
  const top = Math.max(pad, Math.min(y, window.innerHeight - r.height - pad));
  m.style.left = `${Math.round(left)}px`;
  m.style.top = `${Math.round(top)}px`;
  const first = m.querySelector('.ctx-item:not([disabled])');
  if (first) first.focus({ preventScroll: true });
  opened = true;
}

/* 全局关闭时机：只注册一次 */
if (typeof document !== 'undefined') {
  document.addEventListener('mousedown', (e) => {
    if (!opened) return;
    if (el && el.contains(e.target)) return;
    hideMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (opened && e.key === 'Escape') hideMenu();
  });
  document.addEventListener('scroll', () => opened && hideMenu(), true);
  window.addEventListener('wheel', () => opened && hideMenu(), { passive: true });
  window.addEventListener('blur', () => opened && hideMenu());
  window.addEventListener('resize', () => opened && hideMenu());
}

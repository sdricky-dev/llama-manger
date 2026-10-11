'use strict';
/**
 * LlamaManger — Electron 主进程
 */
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const hardware = require('./hardware');
const models = require('./models');
const gguf = require('./gguf');
const recommend = require('./recommend');
const engine = require('./engine');
const slots = require('./slots');
const reveal = require('./reveal');
const config = require('./config');
const { buildArgs, argsToString } = require('../shared/args');
const spec = require('../shared/spec');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'LlamaManger · llama.cpp 一键启动器',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('set-window-title', () => {});
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

/** 探测路径状态（不存在时不抛异常） */
function probe(p) {
  try {
    const st = fs.statSync(p);
    return { exists: true, isDirectory: st.isDirectory(), isFile: st.isFile() };
  } catch {
    return { exists: false };
  }
}

/**
 * 在系统文件管理器中定位文件 / 打开目录。
 * mode 'select'（默认）：打开所在目录并高亮该文件；目标本身是目录则直接打开
 * mode 'dir'：直接打开目标所在目录
 */
async function revealInFileManager(target, mode) {
  const raw = typeof target === 'string' ? config.expandHome(target) : '';
  if (!raw || !raw.trim()) return { ok: false, error: '没有可打开的路径' };
  const abs = path.resolve(raw.trim());

  if (mode === 'dir') {
    const st = probe(abs);
    // 目标自己就是目录时直接打开它，否则打开它所在目录
    const dir = st.exists && st.isDirectory ? abs : reveal.containingDir(abs);
    if (!probe(dir).exists) return { ok: false, error: `目录不存在：${dir}` };
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: err, path: dir } : { ok: true, action: 'open', path: dir };
  }

  const plan = reveal.revealPlan(abs, probe(abs));
  if (plan.action === 'error') return { ok: false, error: plan.error, path: plan.dir };
  if (plan.action === 'open') {
    const err = await shell.openPath(plan.path);
    return err ? { ok: false, error: err, path: plan.path } : { ok: true, action: 'open', path: plan.path };
  }
  shell.showItemInFolder(plan.path); // 高亮文件
  return { ok: true, action: 'select', path: plan.path };
}

const isMac = process.platform === 'darwin';

app.whenReady().then(() => {
  global.__lm_send = send;

  // ---------- 硬件 ----------
  ipcMain.handle('hw:scan', () => hardware.scan());

  // ---------- 模型 ----------
  ipcMain.handle('models:scan', (_e, dir) => models.scanDir(config.expandHome(dir)));
  ipcMain.handle('models:parse', (_e, file) => gguf.parseModelFile(file));
  ipcMain.handle('models:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择模型目录',
      properties: ['openDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // ---------- 推荐 / 内存 / 参数 ----------
  ipcMain.handle('recommend:run', (_e, { hw, model, params }) => recommend.recommend({ hw, model, params }));
  ipcMain.handle('spec:options', (_e, { model, params }) => spec.supportFor(model, params));
  ipcMain.handle('mem:estimate', (_e, { model, params, hw }) =>
    recommend.memoryBreakdown({ model, params, hw })
  );
  ipcMain.handle('args:build', (_e, { params, modelPath, mode }) => {
    const args = buildArgs(params, modelPath, mode);
    return { args, text: argsToString(args) };
  });

  // ---------- 引擎 ----------
  ipcMain.handle('engine:binaries', (_e, buildDir) =>
    engine.findBinaries(config.expandHome(buildDir))
  );
  ipcMain.handle('engine:start-server', (_e, o) => engine.startServer(o));
  ipcMain.handle('engine:stop-server', () => engine.stopServer());
  ipcMain.handle('engine:is-running', () => engine.isRunning());
  ipcMain.handle(
    'engine:launch-terminal',
    (_e, o) => engine.launchTerminal({ userDataDir: app.getPath('userData'), ...o })
  );
  ipcMain.handle('engine:port-status', (_e, port) => engine.portInUse(port));
  ipcMain.handle('engine:find-free-port', (_e, start) => engine.findFreePort(start));
  ipcMain.handle('engine:fit', (_e, o) => engine.runFit(o));

  // ---------- 会话存盘（磁盘侧） ----------
  ipcMain.handle('slots:list', (_e, dir) => slots.list(config.expandHome(dir)));
  ipcMain.handle('slots:remove', (_e, { dir, name }) =>
    slots.remove(config.expandHome(dir), name)
  );
  ipcMain.handle('slots:pick-dir', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择会话存盘目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // ---------- 设置 ----------
  ipcMain.handle('config:load', () => config.load(app.getPath('userData')));
  ipcMain.handle('config:save', (_e, s) => config.save(app.getPath('userData'), s));
  ipcMain.handle('fs:expand', (_e, p) => config.expandHome(p));

  // ---------- 文件定位（右键菜单） ----------
  ipcMain.handle('fs:reveal', (_e, o) => {
    const { path: target, mode } = o || {};
    return revealInFileManager(target, mode);
  });

  // ---------- 剪贴板 ----------
  // 走主进程写剪贴板：渲染层的 navigator.clipboard 要求文档处于聚焦状态，
  // 窗口失焦时会直接失败（Document is not focused）。
  ipcMain.handle('clipboard:write', (_e, text) => {
    const s = String(text ?? '');
    clipboard.writeText(s);
    return { ok: true, length: s.length };
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (engine.isRunning()) engine.stopServer();
  if (!isMac) app.quit();
});

// 单实例
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

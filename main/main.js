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
const bench = require('./bench');
const slots = require('./slots');
const reveal = require('./reveal');
const config = require('./config');
const { buildArgs, argsToString } = require('../shared/args');
const spec = require('../shared/spec');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    // 窗口位置/尺寸/显示模式跨启动记忆（Electron 44 起内置，标注为 Experimental）。
    // `name` 是必填项：不提供时 windowStatePersistence 不生效。
    name: 'main',
    windowStatePersistence: true,
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

  // ---------- 基准测试（仿 LocalScore） ----------
  // 日志通过 onLog 经由引擎日志通道流回渲染层，spawn 一完成就把 summary 回传
  ipcMain.handle('bench:run', (_e, o) => {
    const cb = {
      onLog: (t) => send('engine:log', t),
    };
    return bench.runBench(o, cb);
  });

  // ---------- Agent 模式：工具权限 ----------
  // 渲染层检测到 tool_calls 时，对每个非 read 工具都发一次 ask 决定 yes/no
  const { dialog } = require('electron');
  // preload 在沙箱里不能 require ../shared/*，所以这两个纯函数由主进程算好交给渲染层
  const { autoApproveSet } = require('../shared/agent');
  ipcMain.handle('agent:auto-approve', (_e, toolsArg) => Array.from(autoApproveSet(toolsArg)));
  ipcMain.handle('app:api-styles', () => require('../shared/anthropic').ANTHROPIC_API_STYLES);
  ipcMain.handle('agent:confirm', async (_e, { name, args, autoApproveList }) => {
    const isAuto = Array.isArray(autoApproveList) && autoApproveList.includes(name);
    if (isAuto) return { approved: true, auto: true };
    // 弹原生确认框（modal：阻塞主进程消息循环直到用户点）
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['拒绝', '允许'],
      defaultId: 0,
      cancelId: 0,
      title: `模型想调用工具：${name}`,
      message: `工具：${name}\n参数：${JSON.stringify(args, null, 2)}`,
      detail: '该工具将按你的本机用户权限执行。请确认是否允许。',
      noLink: true,
    });
    return { approved: r.response === 1, auto: false };
  });

  // ---------- 多模态：选择图片 ----------
  ipcMain.handle('mm:pick-images', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择图片（最多 4 张）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
      ],
    });
    return r.canceled ? [] : r.filePaths;
  });

  // ---------- 多模态：data URI 编码 ----------
  const mm = require('../shared/multimodal');
  ipcMain.handle('mm:encode-files', async (_e, paths) => {
    return (Array.isArray(paths) ? paths : []).map((p) => mm.fileToDataUri(p));
  });

  // ---------- 会话存档（轻量 JSONL） ----------
  const sessions = require('../shared/sessions');
  const userData = app.getPath('userData');
  ipcMain.handle('sessions:list', () => {
    const dir = sessions.defaultSessionsDir(userData);
    if (!fs.existsSync(dir)) return { dir, exists: false, files: [] };
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.jsonl') || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      try {
        const raw = fs.readFileSync(full, 'utf8');
        const parsed = sessions.parse(raw);
        const st = fs.statSync(full);
        out.push({
          name: e.name,
          path: full,
          sizeBytes: st.size,
          sizeGB: st.size / 1e9,
          mtimeMs: st.mtimeMs,
          summary: sessions.summarize(parsed),
          errors: parsed.errors.slice(0, 3),
        });
      } catch (err) {
        out.push({ name: e.name, path: full, error: err.message });
      }
    }
    out.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
    return { dir, exists: true, files: out };
  });
  ipcMain.handle('sessions:save', (_e, { header, messages }) => {
    const dir = sessions.defaultSessionsDir(userData);
    fs.mkdirSync(dir, { recursive: true });
    const name = sessions.genSessionFilename();
    const full = path.join(dir, name + '.jsonl');
    fs.writeFileSync(full, sessions.serialize({ header, messages }), 'utf8');
    return { name, path: full, dir };
  });
  ipcMain.handle('sessions:load', (_e, name) => {
    const dir = sessions.defaultSessionsDir(userData);
    const v = sessions.validateSessionName(name);
    if (!v.ok) throw new Error(v.reason);
    const full = path.join(dir, name);
    if (!full.startsWith(path.resolve(dir) + path.sep)) throw new Error('越界');
    const raw = fs.readFileSync(full, 'utf8');
    return sessions.parse(raw);
  });
  ipcMain.handle('sessions:remove', (_e, name) => {
    const dir = sessions.defaultSessionsDir(userData);
    const v = sessions.validateSessionName(name);
    if (!v.ok) throw new Error(v.reason);
    const full = path.join(dir, name);
    if (!full.startsWith(path.resolve(dir) + path.sep)) throw new Error('越界');
    fs.unlinkSync(full);
    return { removed: full };
  });
  ipcMain.handle('sessions:export', (_e, { name, parsed }) => {
    return sessions.exportMarkdown(parsed);
  });
  ipcMain.handle('sessions:pick-file', async () => {
    const r = await dialog.showSaveDialog(win, {
      title: '导出会话为 Markdown',
      defaultPath: 'session.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    return r.canceled ? null : r.filePath;
  });

  // ---------- 子进程沙箱化 ----------
  const sandbox = require('./sandbox');
  ipcMain.handle('sandbox:capability', () => sandbox.sandboxCapability());
  ipcMain.handle('sandbox:probe', () => sandbox.probeWrapper());
  ipcMain.handle('sandbox:should-enable', (_e, opts) => sandbox.shouldEnableSandbox(opts));

  // ---------- HF 模型下载 ----------
  const hf = require('./hf');
  ipcMain.handle('hf:list', async (_e, spec) => {
    const v = hf.validateSpec(spec);
    if (!v.ok) return { ok: false, error: v.reason };
    const { repo, ref, filter } = v.parsed;
    const url = `${hf.HF_BASE}/api/models/${repo}`;
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'LlamaManger/0.1' } });
      if (!resp.ok) return { ok: false, error: `HF API 返回 ${resp.status}` };
      const j = await resp.json();
      const siblings = Array.isArray(j.siblings) ? j.siblings : [];
      const files = siblings.map(hf.normalizeHfFile).filter(Boolean);
      const ggufs = hf.filterGgufFiles(files, { filter });
      const picked = hf.pickPrimaryAndCompanions(ggufs);
      return {
        ok: true,
        repo, ref, filter,
        files: ggufs,
        picked,
        totalSize: ggufs.reduce((s, f) => s + (f.size || 0), 0),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('hf:download', async (_e, { spec, filenames, destDir }) => {
    const v = hf.validateSpec(spec);
    if (!v.ok) return { ok: false, error: v.reason };
    const { repo, ref } = v.parsed;
    fs.mkdirSync(destDir, { recursive: true });
    const results = [];
    for (const filename of filenames || []) {
      const vf = hf.validateFilename(filename);
      if (!vf.ok) { results.push({ filename, ok: false, error: vf.reason }); continue; }
      const url = hf.buildHfDownloadUrl(repo, ref, filename);
      const dest = path.join(destDir, filename);
      try {
        const resp = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'LlamaManger/0.1' } });
        if (!resp.ok) {
          results.push({ filename, ok: false, error: `HTTP ${resp.status}` });
          continue;
        }
        const total = Number(resp.headers.get('content-length') || 0);
        let received = 0;
        send('hf:progress', { filename, received: 0, total, done: false });
        const out = fs.createWriteStream(dest);
        const reader = resp.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          out.write(Buffer.from(value));
          received += value.length;
          send('hf:progress', { filename, received, total, done: false });
        }
        await new Promise((res, rej) => out.end((err) => err ? rej(err) : res()));
        const st = fs.statSync(dest);
        results.push({ filename, ok: true, path: dest, sizeBytes: st.size });
        send('hf:progress', { filename, received: st.size, total, done: true });
      } catch (err) {
        results.push({ filename, ok: false, error: err.message });
        send('hf:progress', { filename, received: 0, total: 0, done: true, error: err.message });
      }
    }
    return { ok: true, results, destDir };
  });

  // ---------- Agent 模式：调用 llama.cpp 的 /tools 端点执行已批准的工具 ----------
  ipcMain.handle('agent:execute', async (_e, { baseUrl, name, args }) => {
    if (!baseUrl) return { ok: false, error: '服务未启动' };
    const url = `${String(baseUrl).replace(/\/+$/, '')}/tools`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, arguments: args || {} }),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return { ok: false, error: j.error?.message || j.message || `HTTP ${resp.status}` };
      }
      // llama.cpp /tools 返回 { success: true, content: [{ type: 'text', text: '...' }, ...] }
      const content = Array.isArray(j.content)
        ? j.content.map((p) => (typeof p.text === 'string' ? p.text : JSON.stringify(p))).join('\n')
        : (typeof j === 'string' ? j : JSON.stringify(j));
      return { ok: true, content };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

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
  // 注意：Electron 44 起 clipboard 对齐 W3C Clipboard API，writeText 变成异步，
  // 必须 await —— 否则会"先返回 ok 再落盘"，写失败也变成未捕获的 rejection。
  ipcMain.handle('clipboard:write', async (_e, text) => {
    const s = String(text ?? '');
    await clipboard.writeText(s);
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

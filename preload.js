'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const listener = (_e, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('lm', {
  hw: {
    scan: () => ipcRenderer.invoke('hw:scan'),
  },
  models: {
    scan: (dir) => ipcRenderer.invoke('models:scan', dir),
    parse: (file) => ipcRenderer.invoke('models:parse', file),
    pick: () => ipcRenderer.invoke('models:pick'),
  },
  recommend: {
    run: (o) => ipcRenderer.invoke('recommend:run', o),
  },
  spec: {
    // 按模型能力返回可选的投机解码类型（含不可用原因）
    options: (o) => ipcRenderer.invoke('spec:options', o),
  },
  mem: {
    estimate: (o) => ipcRenderer.invoke('mem:estimate', o),
  },
  args: {
    build: (o) => ipcRenderer.invoke('args:build', o),
  },
  engine: {
    binaries: (buildDir) => ipcRenderer.invoke('engine:binaries', buildDir),
    startServer: (o) => ipcRenderer.invoke('engine:start-server', o),
    stopServer: () => ipcRenderer.invoke('engine:stop-server'),
    isRunning: () => ipcRenderer.invoke('engine:is-running'),
    launchTerminal: (o) => ipcRenderer.invoke('engine:launch-terminal', o),
    portStatus: (port) => ipcRenderer.invoke('engine:port-status', port),
    findFreePort: (start) => ipcRenderer.invoke('engine:find-free-port', start),
    fit: (o) => ipcRenderer.invoke('engine:fit', o),
    on: on,
  },
  config: {
    load: () => ipcRenderer.invoke('config:load'),
    save: (s) => ipcRenderer.invoke('config:save', s),
  },
  slots: {
    // 会话存盘目录的磁盘侧操作（写入由 llama-server 负责）
    list: (dir) => ipcRenderer.invoke('slots:list', dir),
    remove: (o) => ipcRenderer.invoke('slots:remove', o),
    pickDir: () => ipcRenderer.invoke('slots:pick-dir'),
  },
  fs: {
    expand: (p) => ipcRenderer.invoke('fs:expand', p),
    // 在系统文件管理器中定位文件（mode 'select'）或打开所在目录（mode 'dir'）
    reveal: (p, mode) => ipcRenderer.invoke('fs:reveal', { path: p, mode: mode || 'select' }),
  },
  clipboard: {
    // 由主进程写系统剪贴板（不依赖窗口聚焦）
    write: (text) => ipcRenderer.invoke('clipboard:write', text),
  },
});

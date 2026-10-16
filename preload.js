'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const { ANTHROPIC_API_STYLES } = require('./shared/anthropic');
const { expandToolsArg, autoApproveSet, toolRequiresConfirm } = require('./shared/agent');
const {
  SUPPORTED_IMAGE_MIMES,
  detectMimeByExt,
  toMultimodalContent,
  toMultimodalMessage,
  dataUriSize,
} = require('./shared/multimodal');

function on(channel, cb) {
  const listener = (_e, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// 这些常量直接从主进程注册到 window（不需要走 IPC）
contextBridge.exposeInMainWorld('lm', {
  apiStyles: ANTHROPIC_API_STYLES,
  // 多模态辅助（直接挂在主进程上下文中，不需要走 IPC）
  mm: {
    SUPPORTED_IMAGE_MIMES: Array.from(SUPPORTED_IMAGE_MIMES),
    detectMimeByExt,
    toMultimodalContent,
    toMultimodalMessage,
    dataUriSize,
  },
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
  bench: {
    // 仿 LocalScore：在本机上用 llama-bench 跑一次实测
    run: (o) => ipcRenderer.invoke('bench:run', o),
  },
  agent: {
    // 弹原生确认框，问用户是否允许当前工具调用
    confirm: (o) => ipcRenderer.invoke('agent:confirm', o),
    // 通过 llama.cpp /tools 端点执行已批准的工具
    execute: (o) => ipcRenderer.invoke('agent:execute', o),
    // 工具名唯一来源在 shared/agent.js（主进程与渲染层共用，避免两边列表漂移）
    expandTools: (v) => expandToolsArg(v),
    autoApprove: (v) => Array.from(autoApproveSet(v)),
    requiresConfirm: (name) => toolRequiresConfirm(name),
  },
  mmIpc: {
    pick: () => ipcRenderer.invoke('mm:pick-images'),
    encode: (paths) => ipcRenderer.invoke('mm:encode-files', paths),
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    save: (o) => ipcRenderer.invoke('sessions:save', o),
    load: (name) => ipcRenderer.invoke('sessions:load', name),
    remove: (name) => ipcRenderer.invoke('sessions:remove', name),
    export: (o) => ipcRenderer.invoke('sessions:export', o),
    pickFile: () => ipcRenderer.invoke('sessions:pick-file'),
  },
  sandbox: {
    capability: () => ipcRenderer.invoke('sandbox:capability'),
    probe: () => ipcRenderer.invoke('sandbox:probe'),
    shouldEnable: (o) => ipcRenderer.invoke('sandbox:should-enable', o),
  },
  hf: {
    list: (spec) => ipcRenderer.invoke('hf:list', spec),
    download: (o) => ipcRenderer.invoke('hf:download', o),
    onProgress: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('hf:progress', listener);
      return () => ipcRenderer.removeListener('hf:progress', listener);
    },
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

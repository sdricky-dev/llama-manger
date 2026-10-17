'use strict';
/**
 * 注意：渲染进程默认开启 sandbox，**沙箱化的 preload 不能 require 相对路径文件**
 * （只能 require electron / events / timers / url 等内置模块）。
 * 因此这里不引入 ../shared/*，需要复用的纯函数一律通过 IPC 由主进程计算：
 *   - API 风格列表   → ipcRenderer.invoke('app:api-styles')
 *   - 工具自动放行集 → ipcRenderer.invoke('agent:auto-approve')
 * 多模态图片在选图时已由主进程编码成 data URI，渲染层直接用即可。
 */
const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const listener = (_e, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// 这些常量直接从主进程注册到 window（不需要走 IPC）
contextBridge.exposeInMainWorld('lm', {
  app: {
    // shared/anthropic.js 的 ANTHROPIC_API_STYLES（preload 不能 require，改由主进程给）
    apiStyles: () => ipcRenderer.invoke('app:api-styles'),
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
    caps: (buildDir) => ipcRenderer.invoke('engine:caps', buildDir),
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
    // 工具自动放行集合：由主进程用 shared/agent.js 计算（唯一来源，避免两边列表漂移）
    autoApprove: (v) => ipcRenderer.invoke('agent:auto-approve', v),
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

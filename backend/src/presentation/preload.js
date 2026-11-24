/**
 * Electron 预加载脚本 (Preload Script)
 * 安全桥接 Electron 主进程 API 与渲染页面
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    platform: process.platform,
    version: process.versions.electron,
    openExternal: (url) => ipcRenderer.send('open-external', url),
    minimizeWindow: () => ipcRenderer.send('window-minimize'),
    maximizeWindow: () => ipcRenderer.send('window-maximize'),
    closeWindow: () => ipcRenderer.send('window-close')
});

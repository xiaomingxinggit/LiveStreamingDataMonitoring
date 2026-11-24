/**
 * Electron 主进程 (Main Process)
 * 职责：
 * 1. 启动内嵌的数据采集接收服务 (CollectorServer)
 * 2. 创建并管理 Windows 桌面大屏窗口
 * 3. 管理系统托盘与生命周期
 */

const { app, BrowserWindow, Menu, Tray, shell } = require('electron');
const path = require('path');
const { CollectorServer } = require('../collector/server');

let mainWindow = null;
let tray = null;
let collectorServer = null;

const PORT = process.env.PORT || 28888;
const HOST = '127.0.0.1';

function startBackendServer(callback) {
    collectorServer = new CollectorServer({
        port: PORT,
        host: HOST
    });
    collectorServer.start((err) => {
        if (err) {
            console.error('[Electron Main] 启动 CollectorServer 失败:', err);
        }
        if (callback) callback(err);
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 700,
        title: '抖音直播多房间作战大屏 - 本地总控客户端',
        backgroundColor: '#0b0f19',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    // 载入本地总控大屏页面
    mainWindow.loadURL(`http://${HOST}:${PORT}`);

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// 确保单实例运行
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(() => {
        startBackendServer(() => {
            createWindow();
        });

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    });
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        if (collectorServer) {
            collectorServer.stop(() => {
                app.quit();
            });
        } else {
            app.quit();
        }
    }
});

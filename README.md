# LiveStreamingDataMonitoring (抖音直播实时数据监控系统)

本项目是一个专为抖音直播（电商罗盘/巨量百应大屏）打造的实时多房间数据监控系统，采用**“前端油猴哨兵 + 本地桌面总控软件”**的前后端分离架构。

---

## 总体架构与数据流向

```
[ 抖音电商罗盘大屏 A ] ───(被动网络嗅探)───▶ [ 油猴哨兵 A ] ──┐
[ 抖音电商罗盘大屏 B ] ───(被动网络嗅探)───▶ [ 油猴哨兵 B ] ──┼──▶ [ 本地总控客户端 (127.0.0.1:28888) ]
[ 抖音电商罗盘大屏 C ] ───(被动网络嗅探)───▶ [ 油猴哨兵 C ] ──┘          ├─ 数据采集与去重 (Collector)
                                                                 ├─ 多房间聚合与流速计算 (Calculator)
                                                                 ├─ 本地持久化与CSV导出 (Storage)
                                                                 └─ 弹性自适应作战大屏 (Elastic UI)
```

---

## 目录结构

```text
LiveStreamingDataMonitoring/
├── frontend/                       # 前端：油猴哨兵监听项目
│   ├── src/
│   │   ├── douyin_sentinel.user.js # 油猴脚本主代码（含拦截器、解析器与 HUD）
│   │   └── parser.js               # 核心协议解析与数据清洗模块
│   ├── tests/                      # 单元测试与真实 HAR 回放测试
│   └── README.md                   # 哨兵安装与配置指南
│
├── backend/                        # 后端：Windows 本地总控桌面端 (Node.js + Electron)
│   ├── src/
│   │   ├── collector/              # 数据采集接收服务 (HTTP / SSE)
│   │   ├── calculator/             # 多房间计算与指标聚合引擎
│   │   ├── storage/                # 本地存储与报表导出
│   │   ├── presentation/           # Electron 桌面窗口与弹性作战大屏 UI
│   │   └── index.js                # 独立服务启动入口
│   ├── tests/                      # 后端单元测试与集成测试
│   ├── package.json                # 依赖与打包配置 (electron-builder)
│   └── README.md                   # 后端运行与打包指南
│
├── compass.jinritemai.com.har      # 罗盘大屏真实抓包数据源 (用于测试与回放)
└── README.md                       # 项目主文档
```

---

## 前置环境要求

- **Node.js**: v20.0.0 或更高版本
- **浏览器**: Google Chrome 或 Microsoft Edge
- **浏览器插件**: [Tampermonkey (油猴)](https://www.tampermonkey.net/)

---

## 快速上手与运行

### 1. 运行全套自动化测试 (前端 + 后端)
```bash
# 工作目录：项目根目录
node --test frontend/tests/*.test.js backend/tests/*.test.js
```

### 2. 启动本地总控服务 (服务模式)
```bash
node backend/src/index.js
```
启动后打开浏览器访问 `http://127.0.0.1:28888` 即可查看弹性作战大屏。

### 3. 安装与自动更新前端油猴哨兵
- **首次安装**：
  - 方式一（在线安装与绑定）：在浏览器中安装 Tampermonkey 插件后，直接访问脚本在线地址：
    `https://raw.githubusercontent.com/xiaomingxinggit/LiveStreamingDataMonitoring/main/frontend/src/douyin_sentinel.user.js`
    油猴会自动弹出安装确认界面，点击“安装”即可。
  - 方式二（本地导入）：将本地 `frontend/src/douyin_sentinel.user.js` 代码内容完整复制粘贴至油猴“添加新脚本”编辑器中保存。
- **自动更新机制**：
  - 脚本已内置 `@updateURL` 与 `@downloadURL` 头部元数据。
  - 当远程仓库 `main` 分支更新且 `@version` 版本号递增后，油猴插件会按设定周期（或在油猴菜单中点击“检查脚本更新”）自动拉取并静默/提示更新至最新版，无需手动重新复制代码。

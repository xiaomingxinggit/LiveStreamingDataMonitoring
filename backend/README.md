# 抖音直播多房间监控本地总控客户端 (Backend Desktop & Server)

本项目是基于 **Node.js + Electron** 构建的 Windows 本地总控客户端软件，负责接收来自一个或多个油猴哨兵上报的实时直播大盘数据，进行多房间数据去重、指标流式计算、聚合分析、本地持久化与弹性数据大屏呈现。

---

## 核心架构与模块分工

```text
backend/
├── src/
│   ├── collector/              # 【采集接入层】
│   │   └── server.js           # 本地 HTTP/SSE 服务 (默认 127.0.0.1:28888)
│   ├── calculator/             # 【计算引擎层】
│   │   └── engine.js           # 多房间状态管理、事件去重、流速与聚合计算
│   ├── storage/                # 【持久化层】
│   │   └── store.js            # JSONL 日志持久化、快照管理、CSV 报表导出
│   ├── presentation/           # 【呈现与 UI 层】
│   │   ├── main.js             # Electron 桌面主进程、窗口与托盘管理
│   │   ├── preload.js          # Electron 预加载脚本
│   │   └── renderer/           # 弹性自适应多房间作战大屏 (HTML/CSS/JS)
│   │       └── index.html      # 动态响应 1、2、3、4、5+ 房间的网格大屏
│   └── index.js                # 无图形界面独立运行服务入口
├── tests/                      # 自动化测试套件
│   ├── calculator_engine.test.js # 计算引擎、多房间聚合、去重与超时测试
│   └── collector_server.test.js  # 本地 HTTP 接口与 CSV 导出集成测试
├── package.json
└── README.md
```

---

## 弹性多房间数据面板机制 (Elastic Dashboard)

UI 采用基于 CSS Grid 与弹性布局算法的自适应大屏系统：
- **0 个房间**：展示引导等待连接状态，指引用户开启油猴哨兵。
- **1 个房间**：自适应单卡全宽视图，突出展示核心 GMV 流速与爆款讲解商品。
- **2 个房间**：双列并排对比看板。
- **3 个房间**：三列并排看板。
- **4 个房间**：2x2 方阵作战大屏。
- **5 个及以上**：自适应响应式网格流（`auto-fit`），支持无限扩展多个直播间同时监控。
- **全局顶栏汇总**：无论接入多少个直播间，顶栏均实时计算全大盘总 GMV、总在线观众数、总成交件数与活跃房间数。

---

## 本地启动与运行指南

### 1. 前置要求
- **Node.js**: v20.0.0 或更高版本

### 2. 独立服务模式启动 (无需图形界面，可在终端直接运行)
在终端中执行：
```bash
# 工作目录：项目根目录
node backend/src/index.js
```
启动后，可在任何浏览器直接访问 `http://127.0.0.1:28888` 实时查看大屏，并支持局域网或投屏显示。

### 3. 桌面客户端模式启动 (Electron 窗口)
```bash
# 工作目录：backend 目录
cd backend
npm start
```

### 4. 运行自动化测试
```bash
# 工作目录：项目根目录
node --test backend/tests/*.test.js
```

---

## Windows 打包与分发说明

针对发给外部人员使用、目标电脑无开发环境的需求：
```bash
# 工作目录：backend 目录
npm run build:win
```
将在 `backend/dist` 目录下生成：
1. **绿色免安装便携版 (`.exe`)**：客户双击解压即可直接运行，无需安装任何依赖。
2. **NSIS 安装包 (`Setup.exe`)**：带桌面快捷方式的标准向导式安装包。

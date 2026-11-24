# LiveStreamingDataMonitoring (抖音直播实时数据监控系统)

本项目是一个专为抖音直播（电商罗盘/巨量百应大屏）打造的实时数据监控系统，采用**“前端油猴哨兵 + 本地桌面总控软件”**的前后端分离架构。

---

## 总体架构设计

```
[ 抖音电商罗盘大屏页面 ]
       │
       ▼ (被动网络嗅探: Fetch / XHR / WebSocket)
[ 前端油猴哨兵 (UserScript) ]
       │
       ▼ (GM_xmlhttpRequest 本地回传 http://127.0.0.1:28888)
[ 本地总控桌面端 (Electron) ]
       ├─ 数据接收层 (Collector)
       ├─ 指标聚合与计算引擎 (Calculator)
       ├─ 本地持久化 (Storage: SQLite)
       └─ 可视化作战大屏与告警 (Presentation UI)
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
│   │   ├── sentinel_parser.test.js # 解析器与清洗逻辑测试
│   │   └── har_replay.test.js      # 真实罗盘抓包重放测试
│   └── README.md                   # 哨兵安装与配置指南
│
├── backend/                        # 后端：Windows 桌面客户端 (规划中)
├── compass.jinritemai.com.har      # 罗盘大屏真实抓包数据源 (用于测试与回放)
└── README.md                       # 项目主文档
```

---

## 前置环境要求

- **Node.js**: v20.0.0 或更高版本（本项目基于 Node 原生测试套件 `node:test`）
- **浏览器**: Google Chrome 或 Microsoft Edge
- **浏览器插件**: [Tampermonkey (油猴)](https://www.tampermonkey.net/)

---

## 开发与测试命令

### 1. 运行前端哨兵自动化测试
测试涵盖文本清洗（中圆点替换）、分转元计算、5 大核心罗盘接口解析及真实 HAR 流量重放：

```bash
# 工作目录：项目根目录 E:\Codex\LiveStreamingDataMonitoring
node --test frontend/tests/*.test.js
```

---

## 编码与规范说明

- **中圆点处理**：所有展示文本、标题、状态描述及历史数据中的 `U+00B7`（`·`）均统一替换为普通半角空格。
- **显式度量单位**：所有可能产生歧义的指标字段均显式带有单位后缀（如 `gmv_amount_yuan`、`ad_cost_yuan`、`avg_watch_duration_seconds`）。

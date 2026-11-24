# 抖音电商罗盘大屏数据监控哨兵 (Frontend Sentinel UserScript)

该子项目是基于 **Tampermonkey (油猴)** 构建的前端数据监听与清洗哨兵。它运行在浏览器中已登录商家的抖音电商罗盘大屏页面（`https://compass.jinritemai.com/*`），通过被动嗅探拦截网络报文，自动提取直播间大盘数据、清洗并以标准结构安全回传至用户本地的 Windows 总控客户端。

---

## 核心特性

1. **零风控被动拦截**：
   - 代理劫持 `window.fetch` 与 `XMLHttpRequest`，不模拟用户点击，不发送主动探测请求，与用户正常看屏完全一致。
2. **专属罗盘大屏协议解析**：
   - **基础信息** (`live_base_info`)：直播间 ID、店铺主播昵称、开播时间、直播状态。
   - **核心指标** (`core_data`)：实时 GMV（分转元）、在线人数、成交人数、成交件数、千川消耗、停留时长及各环节转化率。
   - **讲解商品** (`product_explain_detail`)：当前讲解商品 ID、名称、主图、讲解产生销售额、库存与 5 分钟点击流速。
   - **互动弹幕** (`professional/comment`)：公屏互动消息实时流。
3. **数据清洗规范**：
   - 自动将历史与文本数据中的中圆点（`U+00B7`）替换为普通空格。
   - 明确所有金额与时长的度量单位（如 `gmv_amount_yuan`、`avg_watch_duration_seconds`）。
4. **跨域传输与弹性队列**：
   - 借助 `GM_xmlhttpRequest` 突破浏览器混合内容与 CORS 跨域策略，直接与本地 `http://127.0.0.1:28888` 通信。
   - 具备 500 条环形缓冲队列与失败自动重发机制，总控短暂重启不丢失关键事件。
5. **页面浮动状态指示栏 (HUD)**：
   - 页面右下角显示小巧半透明状态栏，展示连接状态、当前房间、捕获数与回传数，支持一键点击修改总控端口。

---

## 安装与使用指南

### 1. 前置准备
- 浏览器：Google Chrome 或 Microsoft Edge
- 扩展程序：安装 [Tampermonkey (油猴) 扩展](https://www.tampermonkey.net/)

### 2. 安装哨兵脚本
1. 打开浏览器 Tampermonkey 管理面板，点击 **“添加新脚本”**（`+` 图标）。
2. 将 [douyin_sentinel.user.js](file:///e:/Codex/LiveStreamingDataMonitoring/frontend/src/douyin_sentinel.user.js) 中的全部代码复制并粘贴到编辑器中。
3. 按 `Ctrl + S` 保存脚本。
4. 打开或刷新抖音电商罗盘实时大屏（例如 `https://compass.jinritemai.com/shop/live/live_screen/...`）。
5. 页面右下角将出现 **“电商罗盘哨兵”** 浮动指示条，显示监听就绪。

### 3. 配置本地总控地址
- 默认上报地址为 `http://127.0.0.1:28888`。
- 若本地总控修改了端口，直接点击页面右下角的浮动指示条，输入新的地址（如 `http://127.0.0.1:30000`）即可即时生效并持久保存。

---

## 自动化测试与验证

本项目内置基于真实大屏抓包数据（`compass.jinritemai.com.har`）的单元测试与回放校验套件。

### 运行测试命令
在项目根目录运行：
```bash
node --test frontend/tests/*.test.js
```

测试覆盖范围：
- 基础文本与中圆点清洗规范验证
- 分单位转元精度校验
- 5 大罗盘核心接口解析验证
- 真实 HAR 抓包流量重放回放校验（校验在线人数波动、商品讲解启停切换）
- 空数据与异常数据鲁棒性处理

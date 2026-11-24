/**
 * 本地总控服务独立启动入口 (Standalone Server Entry)
 * 可在无图形界面模式下独立运行 CollectorServer，也可供 Electron 直接嵌入调用
 */

const { CollectorServer } = require('./collector/server');

const PORT = parseInt(process.env.PORT || '28888', 10);
const HOST = process.env.HOST || '127.0.0.1';

const server = new CollectorServer({
    port: PORT,
    host: HOST
});

server.start((err, info) => {
    if (err) {
        console.error('启动总控服务异常:', err);
        process.exit(1);
    }
    console.log(`====================================================`);
    console.log(`  抖音直播多房间监控总控服务已就绪`);
    console.log(`  大屏访问地址: http://${info.host}:${info.port}`);
    console.log(`  油猴哨兵上报: http://${info.host}:${info.port}/api/stream/events`);
    console.log(`  按 Ctrl + C 可终止服务`);
    console.log(`====================================================`);
});

process.on('SIGINT', () => {
    console.log('\n正在优雅关闭服务...');
    server.stop(() => {
        console.log('服务已安全退出');
        process.exit(0);
    });
});

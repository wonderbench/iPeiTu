import { startServer, probeService } from './http.js';

const port = Number(process.env.IPEITU_PORT || 39831);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('IPEITU_PORT 必须是 1–65535 的端口号');

let server;
try {
  ({ server } = await startServer({ port }));
} catch (error) {
  if (error.code !== 'EADDRINUSE') throw error;
  // 重复启动不报错；端口被其他程序占用时明确说明，不影响那个程序。
  const running = await probeService(port);
  if (running) {
    console.log(`iPeiTu 本地图库已在运行：http://127.0.0.1:${port}/（进程 ${running.pid}）`);
    process.exit(0);
  }
  console.error(`端口 ${port} 已被其他程序占用，iPeiTu 未启动。请关闭占用该端口的程序后重试。`);
  process.exit(2);
}
console.log(`iPeiTu 本地图库已启动：http://127.0.0.1:${port}/`);
console.log('保持此窗口运行，按 Ctrl+C 停止');
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));

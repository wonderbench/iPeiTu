import { startServer } from './http.js';

const port = Number(process.env.IPEITU_PORT || 39831);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('IPEITU_PORT 必须是 1–65535 的端口号');
const { server } = await startServer({ port });
console.log(`iPeiTu 本地图库已启动：http://127.0.0.1:${port}/`);
console.log('保持此窗口运行，按 Ctrl+C 停止');
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));

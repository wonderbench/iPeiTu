import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { startServer, probeService } from './http.js';
import { CachePruner } from './cache-prune.js';
import { RotatingLog, formatLine } from './log.js';

// 命令行参数供后台启动使用：--port、--data-dir、--log；局域网模式另加 --host 0.0.0.0 与 --access-key-file。未提供时沿用环境变量与默认值。
const options = {};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 2) {
  const [key, value] = [argv[index], argv[index + 1]];
  if (!['--port', '--data-dir', '--log', '--host', '--access-key-file'].includes(key) || value === undefined) {
    throw new Error(`无法识别的参数：${key}`);
  }
  options[key.slice(2)] = value;
}

// 日志超过 5 MB 时轮转为 <名称>.1，只保留一份旧日志。
let logFile = null;
if (options.log) {
  await mkdir(path.dirname(options.log), { recursive: true });
  logFile = new RotatingLog(options.log);
  const write = (level, values) => logFile.write(formatLine(level, values));
  console.log = (...values) => write('INFO', values);
  console.warn = (...values) => write('WARN', values);
  console.error = (...values) => write('ERROR', values);
}

// 写完日志再退出，避免后台运行时丢失最后的说明。
function exit(code) {
  if (logFile) logFile.end(() => process.exit(code));
  else process.exit(code);
}

const port = Number(options.port ?? process.env.IPEITU_PORT ?? 39831);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('端口必须是 1–65535 的整数');
  exit(1);
} else {
  let server;
  let library;
  const host = options.host ?? '127.0.0.1';
  try {
    // 密钥只从文件读取，不出现在进程命令行里。
    const accessKey = options['access-key-file'] ? (await readFile(options['access-key-file'], 'utf8')).trim() : null;
    ({ server, library } = await startServer({ port, host, ...(accessKey ? { accessKey } : {}),
      ...(options['data-dir'] ? { dataDirectory: options['data-dir'] } : {}) }));
  } catch (error) {
    if (error.code !== 'EADDRINUSE') {
      console.error('iPeiTu 本地图库启动失败：', error);
      exit(1);
    } else {
      // 重复启动不报错；端口被其他程序占用时明确说明，不影响那个程序。
      const running = await probeService(port);
      if (running) {
        console.log(`iPeiTu 本地图库已在运行：http://127.0.0.1:${port}/（进程 ${running.pid}）`);
        exit(0);
      } else {
        console.error(`端口 ${port} 已被其他程序占用，iPeiTu 未启动。请关闭占用该端口的程序后重试。`);
        exit(2);
      }
    }
  }
  if (server) {
    console.log(`iPeiTu 本地图库已启动：http://127.0.0.1:${port}/`);
    if (host !== '127.0.0.1') console.log(`已开启局域网访问（监听 ${host}:${port}），其他电脑凭访问密钥连接`);
    if (!logFile) console.log('保持此窗口运行，按 Ctrl+C 停止');
    // 缓存清理在服务开始监听之后异步执行，结果与失败只记入日志，不影响服务；定时器不阻止进程退出。
    const pruner = new CachePruner(library.directory);
    pruner.start();
    server.on('close', () => pruner.stop());
    process.on('SIGINT', () => server.close(() => exit(0)));
    process.on('SIGTERM', () => server.close(() => exit(0)));
  }
}

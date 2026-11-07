import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 安装与服务脚本只在 Windows 上运行；全部使用临时目录和临时端口，不触碰真实的 WPS 配置、启动文件夹和图库。
const skip = process.platform !== 'win32';
const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

function run(script, args, env) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scripts, `${script}.ps1`), ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 120_000, env: { ...process.env, ...env },
  });
  assert.ok(!result.error, `${script} 未在时限内结束：${result.error?.message}`);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
}

async function workspace(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ipeitu-setup-'));
  const port = await freePort();
  const paths = {
    directory, port,
    state: path.join(directory, 'state'), data: path.join(directory, 'library'),
    config: path.join(directory, 'jsaddons'), startup: path.join(directory, 'startup'),
  };
  t.after(async () => {
    run('service', ['-Action', 'stop', '-Port', String(port), '-StateDirectory', paths.state], {});
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  return paths;
}

test('服务脚本：启动、重复启动、查看与停止只作用于本目录的服务', { skip }, async t => {
  const { port, state, data } = await workspace(t);
  const args = ['-Port', String(port), '-StateDirectory', state];
  const env = { IPEITU_DATA_DIR: data };
  assert.equal(run('service', ['-Action', 'status', ...args], env).status, 1, '未启动时状态为 1');
  let result = run('service', ['-Action', 'start', ...args], env);
  assert.equal(result.status, 0, result.output);
  const first = await health(port);
  assert.equal(first?.service, 'iPeiTu');
  assert.equal(first.root.toLowerCase(), root.toLowerCase());
  assert.equal(JSON.parse(await readFile(path.join(state, `service-${port}.json`), 'utf8')).pid, first.pid);
  result = run('service', ['-Action', 'start', ...args], env);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /已在运行/);
  assert.equal((await health(port)).pid, first.pid, '重复启动不另起进程');
  assert.equal(run('service', ['-Action', 'status', ...args], env).status, 0);
  result = run('service', ['-Action', 'stop', ...args], env);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /已停止/);
  assert.equal(await health(port), null);
  result = run('service', ['-Action', 'stop', ...args], env);
  assert.equal(result.status, 0);
  assert.match(result.output, /未在运行/);
});

test('端口被其他程序占用时不启动，也不影响占用端口的程序', { skip }, async t => {
  const { port, state, data } = await workspace(t);
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const args = ['-Port', String(port), '-StateDirectory', state];
  const result = run('service', ['-Action', 'start', ...args], { IPEITU_DATA_DIR: data });
  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /已被.*占用/);
  assert.equal(blocker.listening, true);
  assert.equal(run('service', ['-Action', 'status', ...args], {}).status, 2);
});

test('状态文件指向无关进程时拒绝停止，并清除过期的状态文件', { skip }, async t => {
  const { port, state } = await workspace(t);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => unrelated.kill());
  const statePath = path.join(state, `service-${port}.json`);
  await mkdir(state, { recursive: true });
  await writeFile(statePath, JSON.stringify({ version: 1, pid: unrelated.pid, port, root }));
  const result = run('service', ['-Action', 'stop', '-Port', String(port), '-StateDirectory', state], {});
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /不是本目录启动的 iPeiTu 服务，未停止/);
  assert.equal(unrelated.exitCode, null);
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0), '无关进程仍在运行');
  await assert.rejects(access(statePath), '过期的状态文件已清除');
});

test('一键安装与卸载：注册加载项、设置自动启动并启动服务；卸载后全部还原，素材图库保留', { skip }, async t => {
  const { port, state, data, config, startup } = await workspace(t);
  const common = ['-ConfigDirectory', config, '-StartupDirectory', startup, '-StateDirectory', state, '-Port', String(port)];
  const env = { IPEITU_DATA_DIR: data };
  let result = run('setup', [...common, '-SkipDependencies'], env);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /安装完成/);
  assert.match(await readFile(path.join(config, 'publish.xml'), 'utf8'), /name="iPeiTu"/);
  const shortcut = path.join(startup, 'iPeiTu 本地图库.lnk');
  await access(shortcut);
  assert.equal((await health(port))?.service, 'iPeiTu');

  result = run('setup', [...common, '-SkipDependencies'], env);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /已在运行/, '重复安装不另起服务');

  result = run('remove', common, env);
  assert.equal(result.status, 0, result.output);
  assert.equal(await health(port), null);
  await assert.rejects(access(shortcut), '自动启动已移除');
  assert.doesNotMatch(await readFile(path.join(config, 'publish.xml'), 'utf8'), /name="iPeiTu"/);
  await access(path.join(data, 'images'));
  assert.match(result.output, /素材图库保留/);
});

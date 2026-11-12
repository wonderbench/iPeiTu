import { runWpsSelfCheck } from './self-check.js';

const start = document.getElementById('startSelfCheck');
const copy = document.getElementById('copySelfCheck');
const status = document.getElementById('selfCheckStatus');
const output = document.getElementById('selfCheckOutput');
const report = document.getElementById('selfCheckReport');
const inWps = typeof globalThis.Application !== 'undefined';

start.disabled = !inWps;
status.textContent = inWps ? '准备就绪' : '请从 WPS 文字的 iPeiTu 配图功能区打开自检';

async function request(path, method) {
  const response = await fetch(path, { method });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error || `本机服务返回 ${response.status}`);
  }
  return response.json();
}

start.addEventListener('click', async () => {
  start.disabled = true;
  copy.hidden = true;
  output.hidden = true;
  status.textContent = '正在准备临时文档和图片…';
  const time = new Date();
  let version = '无法读取';
  let results = [];
  let fixture;
  let safeToClean = false;
  try {
    fixture = await request('/api/self-check', 'POST');
    ({ version, results, safeToClean } = runWpsSelfCheck(fixture));
  } catch (error) {
    results.push({ name: '启动自检', status: '失败', detail: error.message || String(error) });
  }
  if (fixture && safeToClean) {
    try {
      await request(`/api/self-check/${fixture.id}`, 'DELETE');
    } catch (error) {
      results.push({ name: '清理临时文件', status: '失败', detail: `${error.message}（${fixture.documentPath}）` });
    }
  } else if (fixture) {
    results.push({ name: '清理临时文件', status: '跳过', detail: `请先关闭测试文档，再清理 ${fixture.documentPath} 所在的临时目录` });
  }
  const counts = ['通过', '失败', '跳过'].map(label => `${results.filter(item => item.status === label).length} 项${label}`).join('，');
  report.value = [
    'iPeiTu WPS 实机自检', `时间 ${time.toLocaleString('zh-CN')}`, `WPS 版本 ${version}`, counts, '',
    ...results.map(item => `[${item.status}] ${item.name}${item.duration === undefined ? '' : `（${item.duration} ms）`}\n${item.detail}`),
  ].join('\n');
  status.textContent = counts;
  output.hidden = false;
  copy.hidden = false;
  start.disabled = false;
});

copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(report.value);
    status.textContent = '已复制报告';
  } catch {
    report.focus();
    report.select();
    status.textContent = '报告已选中，请按 Ctrl+C 复制';
  }
});

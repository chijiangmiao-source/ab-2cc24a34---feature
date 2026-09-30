'use strict';
/*
 * http-smoke.js —— 对运行中的审计服务做 HTTP 冒烟：
 *   GET /healthz 必须 200 且 status=ok
 *   GET /        必须 200 且包含审计页面关键内容
 *   GET /app.js /worker.js /core.js /style.css 必须 200 且类型正确
 *   GET /../etc/passwd 之类穿越路径必须非 200
 * 任一不通过以非零状态码退出。
 */
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8080';

async function get(urlPath) {
  const res = await fetch(BASE_URL + urlPath, { redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, type: res.headers.get('content-type') || '', text };
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('   ✓ ' + name);
  } catch (e) {
    failures++;
    console.error('   ✗ ' + name + '：' + e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function waitReady(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(BASE_URL + '/healthz');
      if (res.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('服务在 ' + BASE_URL + ' 未就绪');
}

(async () => {
  console.log('HTTP 冒烟目标：' + BASE_URL);
  await waitReady();

  await check('GET /healthz → 200 JSON status=ok', async () => {
    const r = await get('/healthz');
    assert(r.status === 200, '状态码 ' + r.status);
    assert(/application\/json/.test(r.type), 'Content-Type=' + r.type);
    const body = JSON.parse(r.text);
    assert(body.status === 'ok', '响应体 ' + r.text);
  });

  await check('GET / → 200 审计页面', async () => {
    const r = await get('/');
    assert(r.status === 200, '状态码 ' + r.status);
    assert(/text\/html/.test(r.type), 'Content-Type=' + r.type);
    assert(r.text.includes('Schreier'), '页面缺少 Schreier 关键内容');
    assert(r.text.includes('app.js'), '页面未加载 app.js');
  });

  for (const asset of ['app.js', 'worker.js', 'core.js', 'style.css']) {
    await check('GET /' + asset + ' → 200', async () => {
      const r = await get('/' + asset);
      assert(r.status === 200, '状态码 ' + r.status);
      assert(r.text.length > 0, '内容为空');
    });
  }

  await check('路径穿越请求被拒绝', async () => {
    const r = await get('/..%2f..%2fetc%2fpasswd');
    assert(r.status !== 200, '意外返回 200');
  });

  await check('未知路径 → 404 JSON', async () => {
    const r = await get('/no-such-path');
    assert(r.status === 404, '状态码 ' + r.status);
    assert(/application\/json/.test(r.type), 'Content-Type=' + r.type);
  });

  if (failures > 0) {
    console.error('\nHTTP 冒烟共 ' + failures + ' 项失败。');
    process.exit(1);
  }
  console.log('\nHTTP 冒烟全部通过。');
})().catch((e) => {
  console.error('HTTP 冒烟异常：' + e.stack);
  process.exit(1);
});

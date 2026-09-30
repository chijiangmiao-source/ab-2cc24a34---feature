'use strict';
/*
 * run-verify.js —— Compose verify 服务入口：
 *   1. 代码测试（node --test）：覆盖普通/奇偶两种模式、可导出与不可导出目标等 43 项；
 *   2. 构建检查（语法 + 静态资源 + 核心 API）；
 *   3. HTTP 冒烟（/healthz、审计页、静态资源、异常路径）。
 * 在 Compose 中于 web 服务健康后运行；全部通过以 0 退出，否则非零退出报告结果。
 */
const { spawn } = require('child_process');

const steps = [
  { name: '代码测试（node --test）', cmd: process.execPath, args: ['--test', 'tests/'] },
  { name: '构建检查', cmd: process.execPath, args: ['scripts/build-check.js'] },
  {
    name: 'HTTP 冒烟',
    cmd: process.execPath,
    args: ['verify/http-smoke.js'],
    env: { BASE_URL: process.env.BASE_URL || 'http://127.0.0.1:8080' },
  },
];

function run(step) {
  return new Promise((resolve) => {
    console.log('\n================ ' + step.name + ' ================');
    const child = spawn(step.cmd, step.args, {
      stdio: 'inherit',
      env: { ...process.env, ...(step.env || {}) },
    });
    child.on('exit', (code) => resolve(code || 0));
    child.on('error', (e) => {
      console.error(step.name + ' 启动失败：' + e.message);
      resolve(1);
    });
  });
}

(async () => {
  const results = [];
  let failed = false;
  for (const step of steps) {
    const code = await run(step);
    results.push({ name: step.name, code });
    if (code !== 0) failed = true;
  }

  console.log('\n================ verify 汇总 ================');
  for (const r of results) {
    console.log((r.code === 0 ? '  PASS  ' : '  FAIL  ') + r.name + '（exit ' + r.code + '）');
  }
  if (failed) {
    console.error('\nverify 未通过。');
    process.exit(1);
  }
  console.log('\nverify 全部通过。');
  process.exit(0);
})();

'use strict';
/*
 * build-check.js —— 构建检查（无浏览器、无打包器依赖）：
 *   1. 对全部 JS 源文件做 node --check 语法校验；
 *   2. 校验 index.html 引用的静态资源齐全、worker.js 的 importScripts 目标存在；
 *   3. 校验 public/core.js 可被 Node 加载且导出审计 API。
 * 任一不通过以非零状态码退出。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let failures = 0;

function fail(msg) {
  failures++;
  console.error('构建检查失败：' + msg);
}

function walk(dir, pred) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, pred));
    else if (pred(p)) out.push(p);
  }
  return out;
}

const jsFiles = [
  ...walk(path.join(root, 'public'), (p) => p.endsWith('.js')),
  ...walk(path.join(root, 'tests'), (p) => p.endsWith('.js')),
  ...walk(path.join(root, 'scripts'), (p) => p.endsWith('.js')),
  ...walk(path.join(root, 'verify'), (p) => p.endsWith('.js')),
  path.join(root, 'server.js'),
];

console.log('1) 语法检查（node --check）共 ' + jsFiles.length + ' 个 JS 文件…');
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log('   ✓ ' + path.relative(root, f));
  } catch (e) {
    fail(path.relative(root, f) + ' 语法错误：\n' + (e.stderr ? e.stderr.toString() : e.message));
  }
}

console.log('2) 静态资源引用完整性…');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
for (const ref of ['app.js', 'worker.js', 'style.css', 'core.js']) {
  const file = path.join(root, 'public', ref);
  if (!fs.existsSync(file)) fail('缺少静态资源 public/' + ref);
  else console.log('   ✓ public/' + ref);
}
for (const asset of ['app.js', 'style.css']) {
  if (!new RegExp(asset.replace('.', '\\.')).test(html)) {
    fail('index.html 未引用 ' + asset);
  }
}
const workerSrc = fs.readFileSync(path.join(root, 'public', 'worker.js'), 'utf8');
if (!/importScripts\(['"]core\.js['"]\)/.test(workerSrc)) {
  fail('worker.js 未通过 importScripts 加载 core.js');
} else {
  console.log('   ✓ worker.js → core.js');
}

console.log('3) 核心模块可加载且 API 完整…');
const C = require(path.join(root, 'public', 'core.js'));
for (const fn of ['audit', 'membership', 'buildChain', 'validateInput', 'expandFactorChain', 'acceptIfCurrent', 'buildParitySpace', 'solveParity', 'wordParityVector']) {
  if (typeof C[fn] !== 'function') fail('core.js 缺少导出：' + fn);
}
if (failures === 0) console.log('   ✓ 核心 API 齐全');

if (failures > 0) {
  console.error('\n构建检查共 ' + failures + ' 项失败。');
  process.exit(1);
}
console.log('\n构建检查全部通过。');

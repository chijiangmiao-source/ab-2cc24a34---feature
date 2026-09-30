'use strict';
/*
 * worker.test.js —— 在无浏览器环境下用 vm 模拟 Worker 全局，
 * 加载真实的 public/worker.js + public/core.js，验证消息协议：
 *   - 合法输入返回 audit-response 且结论正确；
 *   - 不合法输入返回 ok:false 且错误一次性回传；
 *   - 计算异常被捕获并回传，而不是抛出。
 * 旧回包代次隔离逻辑在主线程（app.js）侧，核心 acceptIfCurrent 已在 core.test.js 覆盖。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createWorker() {
  const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'core.js'), 'utf8');
  const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'worker.js'), 'utf8');
  const messages = [];
  const handlers = {};
  const sandbox = {
    console,
    Uint8Array,
    Set,
    Map,
  };
  const ctx = vm.createContext(sandbox);
  // 先建立 self，再按 worker.js 的 importScripts('core.js') 顺序加载
  sandbox.self = {
    postMessage: (m) => messages.push(m),
    set onmessage(fn) {
      handlers.onmessage = fn;
    },
    get onmessage() {
      return handlers.onmessage;
    },
  };
  sandbox.importScripts = (name) => {
    assert.equal(name, 'core.js');
    vm.runInContext(coreSrc, ctx, { filename: 'core.js' });
  };
  vm.runInContext(workerSrc, ctx, { filename: 'worker.js' });

  return {
    post(input, requestId) {
      handlers.onmessage({ data: { type: 'audit-request', requestId, input } });
    },
    messages,
  };
}

test('Worker：可导出规程往返，回包携带同一 requestId 与因子链', () => {
  const w = createWorker();
  w.post(
    {
      ports: 'A B C D',
      operations: [
        { name: 'rotate', mapping: '(A B C D)' },
        { name: 'swap_ab', mapping: '(A B)' },
      ],
      target: '(A C)(B D)',
    },
    42
  );
  assert.equal(w.messages.length, 1);
  const m = w.messages[0];
  assert.equal(m.type, 'audit-response');
  assert.equal(m.requestId, 42);
  assert.equal(m.result.ok, true);
  assert.equal(m.result.member, true);
  assert.ok(Array.isArray(m.result.factorWord));
  assert.ok(m.result.steps.length > 1);
});

test('Worker：不可导出目标回包带阻塞层与轨道证据', () => {
  const w = createWorker();
  w.post(
    {
      ports: 'A B C D',
      operations: [{ name: 'rotate', mapping: '(A B C D)' }],
      target: '(A C)',
    },
    7
  );
  const m = w.messages[0];
  assert.equal(m.requestId, 7);
  assert.equal(m.result.member, false);
  assert.equal(m.result.reason, 'blocked');
  assert.ok(m.result.evidence.orbitNames.length >= 1);
});

test('Worker：非法输入一次性回传全部错误', () => {
  const w = createWorker();
  w.post(
    {
      ports: 'A B',
      operations: [
        { name: 'dup', mapping: 'A->B' },
        { name: 'dup', mapping: 'A->X' },
      ],
      target: '',
    },
    9
  );
  const m = w.messages[0];
  assert.equal(m.result.ok, false);
  assert.ok(m.result.errors.length >= 3, '应同时包含缺失端口/重名/非法目标等多个错误');
});

test('Worker：计算异常被捕获并以错误回包返回，requestId 保留', () => {
  const w = createWorker();
  // audit 对畸形输入保持稳健；传入会触发异常的结构（如 ports 为数字导致 split 抛错已被 String 兜底，
  // 这里直接传 operations 为非数组非空对象也应稳健），若核心未来抛出，Worker 必须回传而非崩溃
  w.post({ ports: 'A B C', operations: null, target: '(A B)' }, 3);
  const m = w.messages[0];
  assert.equal(m.requestId, 3);
  assert.equal(m.result.ok, false);
  assert.ok(Array.isArray(m.result.errors));
});

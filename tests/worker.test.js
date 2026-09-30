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

test('Worker：奇偶复核可行往返——回包含规范因子链、补偶词与逐操作计数', () => {
  const w = createWorker();
  w.post(
    {
      ports: 'A B C',
      mode: 'parity',
      operations: [
        { name: 'r', mapping: '(A B C)' },
        { name: 's', mapping: '(A B)' },
      ],
      parity: [1, 1],
      target: '(A B)',
    },
    11
  );
  const m = w.messages[0];
  assert.equal(m.type, 'audit-response');
  assert.equal(m.requestId, 11);
  assert.equal(m.result.ok, true);
  assert.equal(m.result.member, true);
  assert.equal(m.result.paritySatisfied, true);
  assert.ok(m.result.correctionWord.length > 0);
  // vm 跨 realm 数组原型不同，按结构序列化比较
  assert.equal(JSON.stringify(m.result.finalParity), '[1,1]');
  const last = m.result.steps[m.result.steps.length - 1];
  assert.equal(JSON.stringify(last.parity), '[1,1]');
  assert.ok(Array.isArray(last.counts));
});

test('Worker：奇偶复核不可满足回包含代表向量、差额与独立关系基', () => {
  const w = createWorker();
  w.post(
    {
      ports: 'A B C',
      mode: 'parity',
      operations: [
        { name: 'r', mapping: '(A B C)' },
        { name: 's', mapping: '(A B)' },
      ],
      parity: [0, 0],
      target: '(A B)',
    },
    12
  );
  const m = w.messages[0];
  assert.equal(m.requestId, 12);
  assert.equal(m.result.member, true);
  assert.equal(m.result.paritySatisfied, false);
  assert.equal(m.result.reason, 'parity-infeasible');
  assert.equal(JSON.stringify(m.result.repParity), '[0,1]');
  assert.equal(JSON.stringify(m.result.parityDiff), '[0,1]');
  assert.equal(JSON.stringify(m.result.basis), '[[1,0]]');
  assert.ok(m.result.basisRelations[0].entries.length === 2);
});

test('Worker：目标不可导出时奇偶模式仍返回首个阻塞层', () => {
  const w = createWorker();
  w.post(
    {
      ports: 'A B C D',
      mode: 'parity',
      operations: [{ name: 'rotate', mapping: '(A B C D)' }],
      parity: [1],
      target: '(A B)',
    },
    13
  );
  const m = w.messages[0];
  assert.equal(m.result.member, false);
  assert.equal(m.result.reason, 'blocked');
  assert.equal(m.result.paritySatisfied, undefined);
});

test('Worker：奇偶模式未逐操作指定要求时回传 parity 作用域错误', () => {
  const w = createWorker();
  w.post(
    {
      ports: 'A B',
      mode: 'parity',
      operations: [{ name: 'x', mapping: '(A B)' }],
      parity: [],
      target: '(A B)',
    },
    14
  );
  const m = w.messages[0];
  assert.equal(m.result.ok, false);
  assert.ok(m.result.errors.some((e) => e.scope === 'parity'));
});

test('Worker：同实例先旧代次后新代次回包，主线程按 requestId 隔离（协议字段保留）', () => {
  const w = createWorker();
  // 模拟连续两个不同代次请求；Worker 均如实回包，由主线程按 id 取舍。
  w.post(
    {
      ports: 'A B C',
      mode: 'parity',
      operations: [
        { name: 'r', mapping: '(A B C)' },
        { name: 's', mapping: '(A B)' },
      ],
      parity: [0, 0],
      target: '(A B)',
    },
    21
  );
  w.post(
    {
      ports: 'A B C',
      mode: 'normal',
      operations: [
        { name: 'r', mapping: '(A B C)' },
        { name: 's', mapping: '(A B)' },
      ],
      target: '(A B)',
    },
    22
  );
  assert.equal(w.messages.length, 2);
  assert.equal(w.messages[0].requestId, 21);
  assert.equal(w.messages[0].result.paritySatisfied, false);
  assert.equal(w.messages[1].requestId, 22);
  assert.equal(w.messages[1].result.member, true);
  assert.equal(w.messages[1].result.paritySatisfied, undefined);
});

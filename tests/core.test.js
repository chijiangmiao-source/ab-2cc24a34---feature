'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../public/core.js');

// ---------- 辅助 ----------

// 循环记号 -> 内部置换，cycles 为下标数组的数组
function cyc(n, ...cycles) {
  const p = C.identity(n);
  for (const c of cycles) {
    for (let i = 0; i < c.length; i++) p[c[i]] = c[(i + 1) % c.length];
  }
  return p;
}

function auditFrom(names, ops, targetText) {
  return C.audit({
    ports: names.join(' '),
    operations: ops,
    target: targetText,
  });
}

// 枚举 n! 个置换
function allPerms(n) {
  const out = [];
  const rec = (p, used) => {
    if (p.length === n) {
      out.push(p.slice());
      return;
    }
    for (let v = 0; v < n; v++) {
      if (used[v]) continue;
      used[v] = 1;
      p.push(v);
      rec(p, used);
      p.pop();
      used[v] = 0;
    }
  };
  rec([], new Uint8Array(n));
  return out;
}

// BFS 枚举群元素（仅用于小 n 下对 Schreier–Sims 结论做独立对照）
function bruteGroup(n, gens) {
  const id = C.identity(n);
  const key = (p) => p.join(',');
  const seen = new Set([key(id)]);
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift();
    for (const g of gens) {
      for (const h of [g, C.invert(g, n)]) {
        const ng = C.compose(cur, h, n);
        const k = key(ng);
        if (!seen.has(k)) {
          seen.add(k);
          queue.push(ng);
        }
      }
    }
  }
  return seen;
}

// 对所有 n! 个目标比较 core 结论与全枚举结论
function assertMembershipAgrees(n, gens) {
  const levels = C.buildChain(
    n,
    gens,
    gens.map((_, i) => [i + 1])
  );
  const brute = bruteGroup(n, gens);
  let checked = 0;
  for (const t of allPerms(n)) {
    const r = C.membership(
      C.identity(n).map((_, i) => 'p' + i),
      gens.map((g) => ({ name: 'g', perm: g })),
      t
    );
    const expected = brute.has(t.join(','));
    assert.equal(r.member, expected, '成员结论与全枚举不一致：' + t.join(','));
    if (expected) {
      // 因子词必须可复算
      assert.ok(Array.isArray(r.factorWord) && r.factorWord.length >= 0);
      const rebuilt = C.multiplyWord(r.factorWord, gens, n);
      assert.deepEqual(rebuilt, t);
      // 逐步回放终态必须等于目标
      const steps = C.expandFactorChain(
        C.identity(n).map((_, i) => 'p' + i),
        gens.map((g) => ({ name: 'g', perm: g })),
        r.factorWord
      );
      assert.deepEqual(steps[steps.length - 1].perm, t);
    } else {
      // 不可导出必须给出首个无法归约层与轨道证据
      assert.equal(r.reason, 'blocked');
      assert.ok(r.evidence.orbit.length > 0);
      assert.ok(!r.evidence.orbit.includes(r.evidence.attemptedImage));
    }
    checked++;
  }
  return checked;
}

// ---------- 一份可导出规程 ----------

test('可导出规程：S4 中目标 (A C)(B D) 可导出且因子链可逐步回放', () => {
  const r = auditFrom(
    ['A', 'B', 'C', 'D'],
    [
      { name: 'rotate', mapping: '(A B C D)' },
      { name: 'swap_ab', mapping: '(A B)' },
    ],
    '(A C)(B D)'
  );
  assert.equal(r.ok, true);
  assert.equal(r.member, true);
  assert.ok(r.factorWord.length > 0);
  // 终态即目标
  const last = r.steps[r.steps.length - 1];
  assert.deepEqual(last.perm, cyc(4, [0, 2], [1, 3]));
  // 初始态为恒等
  assert.deepEqual(r.steps[0].perm, C.identity(4));
  // 每步排列均为双射
  for (const s of r.steps) assert.ok(C.isPermutation(s.perm, 4));
  // 链诊断覆盖全部端口层
  assert.equal(r.chainSummary.length, 4);
});

test('可导出：恒等目标（空因子链）', () => {
  const r = auditFrom(
    ['A', 'B', 'C'],
    [{ name: 'r', mapping: '(A B C)' }],
    '(A)'
  );
  assert.equal(r.ok, true);
  assert.equal(r.member, true);
  assert.deepEqual(r.factorWord, []);
  assert.equal(r.steps.length, 1);
});

// ---------- 一份不可导出目标 ----------

test('不可导出目标：C4 循环群不含对换 (A B)，给出端口层与轨道证据', () => {
  const r = auditFrom(
    ['A', 'B', 'C', 'D'],
    [{ name: 'rotate', mapping: '(A B C D)' }],
    '(A B)'
  );
  assert.equal(r.ok, true);
  assert.equal(r.member, false);
  assert.equal(r.reason, 'blocked');
  // 第 1 个基点 A 的像 B 不在其轨道 {A,B,C,D}？C4 在 A 上是传递的——
  // 真正阻塞点在稳定子下一层：剥离第 1 层后残差不能固定 B。
  assert.equal(typeof r.evidence.level, 'number');
  assert.ok(r.evidence.level >= 0);
  assert.ok(!r.evidence.orbitNames.includes(r.evidence.attemptedImageName));
  assert.equal(r.evidence.residualMapping.length, 4);
});

test('不可导出：平凡群（生成元全部恒等）目标非恒等，第 1 层即阻塞', () => {
  const r = auditFrom(
    ['A', 'B', 'C'],
    [{ name: 'id1', mapping: '(A)(B)(C)' }],
    '(A B)'
  );
  assert.equal(r.member, false);
  assert.equal(r.evidence.level, 0);
  assert.deepEqual(r.evidence.orbit, [0]);
  assert.equal(r.evidence.attemptedImage, 1);
});

test('不可导出：平凡群目标固定 A 但移动 B，首个阻塞层为第 2 层', () => {
  const r = auditFrom(
    ['A', 'B', 'C'],
    [{ name: 'id1', mapping: '(A)(B)(C)' }],
    '(B C)'
  );
  assert.equal(r.member, false);
  assert.equal(r.evidence.level, 1);
  assert.deepEqual(r.evidence.orbit, [1]);
  assert.equal(r.evidence.attemptedImage, 2);
});

// ---------- 与全枚举对照：Schreier–Sims 结论必须精确 ----------

test('精确性对照 n=3：生成元 (012) 给出 C3，与全枚举一致（3 个目标）', () => {
  assert.equal(assertMembershipAgrees(3, [cyc(3, [0, 1, 2])]), 6);
});

test('精确性对照 n=3：生成元 (012),(01) 给出 S3，与全枚举一致（6 个目标）', () => {
  assert.equal(assertMembershipAgrees(3, [cyc(3, [0, 1, 2]), cyc(3, [0, 1])]), 6);
});

test('精确性对照 n=4：生成元 (0123) 给出 C4，与全枚举一致（24 个目标）', () => {
  assert.equal(assertMembershipAgrees(4, [cyc(4, [0, 1, 2, 3])]), 24);
});

test('精确性对照 n=4：4-循环 + 对换生成 S4，与全枚举一致', () => {
  assert.equal(assertMembershipAgrees(4, [cyc(4, [0, 1, 2, 3]), cyc(4, [0, 1])]), 24);
});

test('精确性对照 n=4：Klein 四元子群与全枚举一致', () => {
  assert.equal(
    assertMembershipAgrees(4, [cyc(4, [0, 1], [2, 3]), cyc(4, [0, 2], [1, 3])]),
    24
  );
});

test('精确性对照 n=5：5-循环 + 相邻对换生成 S5，与全枚举一致（120 个目标）', () => {
  assert.equal(
    assertMembershipAgrees(5, [cyc(5, [0, 1, 2, 3, 4]), cyc(5, [0, 1])]),
    120
  );
});

test('精确性对照 n=5：两个 3-轮换生成 A5（60 阶），与全枚举一致', () => {
  const gens = [cyc(5, [0, 1, 2]), cyc(5, [2, 3, 4])];
  assert.equal(assertMembershipAgrees(5, gens), 120);
  // 群阶应为 60
  const levels = C.buildChain(5, gens, [[1], [2]]);
  let order = 1;
  for (const L of levels) {
    let s = 0;
    for (let x = 0; x < 5; x++) if (L.beta[x] != null) s++;
    order *= s;
  }
  assert.equal(order, 60);
});

test('群阶校验 n=12：生成集生成 S12，轨道指数乘积等于 12!', () => {
  const n = 12;
  const gens = [
    cyc(n, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    cyc(n, [0, 1]),
    cyc(n, [2, 3]),
    cyc(n, [4, 5]),
    cyc(n, [6, 7]),
    cyc(n, [8, 9]),
    cyc(n, [10, 11]),
    cyc(n, [5, 8]),
  ];
  const levels = C.buildChain(n, gens, gens.map((_, i) => [i + 1]));
  let order = 1;
  for (const L of levels) {
    let s = 0;
    for (let x = 0; x < n; x++) if (L.beta[x] != null) s++;
    order *= s;
  }
  let factorial = 1;
  for (let i = 2; i <= 12; i++) factorial *= i;
  assert.equal(order, factorial);
});

// ---------- 确定性：相同输入必须给出相同链与因子链 ----------

test('确定性：重复构造稳定子链与因子词完全一致', () => {
  const n = 5;
  const gens = [cyc(n, [0, 1, 2, 3, 4]), cyc(n, [0, 1])];
  const target = cyc(n, [0, 2, 4], [1, 3]);
  const mk = () =>
    C.membership(
      C.identity(n).map((_, i) => 'p' + i),
      gens.map((g) => ({ name: 'g', perm: g })),
      target
    );
  const r1 = mk();
  const r2 = mk();
  assert.deepEqual(r1.factorWord, r2.factorWord);
  assert.deepEqual(r1.chainSummary, r2.chainSummary);
  // 生成元乱序（经 validateInput 按名排序）后结论仍一致
  const a = C.audit({
    ports: 'p0 p1 p2 p3 p4',
    operations: [
      { name: 'aaa_cycle', mapping: '(p0 p1 p2 p3 p4)' },
      { name: 'bbb_swap', mapping: '(p0 p1)' },
    ],
    target: '(p0 p2 p4)(p1 p3)',
  });
  const b = C.audit({
    ports: 'p0 p1 p2 p3 p4',
    operations: [
      { name: 'bbb_swap', mapping: '(p0 p1)' },
      { name: 'aaa_cycle', mapping: '(p0 p1 p2 p3 p4)' },
    ],
    target: '(p0 p2 p4)(p1 p3)',
  });
  assert.deepEqual(a.factorWord, b.factorWord);
});

// ---------- 输入校验：错误一次性全部返回，立即撤销旧结论 ----------

test('校验：重复操作名、缺失端口、非双射、非法目标一次性返回', () => {
  const r = C.audit({
    ports: 'A B C',
    operations: [
      { name: 'op1', mapping: 'A->B, B->A' },        // 缺失 C
      { name: 'op1', mapping: 'A->B, B->B, C->A' },  // 重名 + 非双射(B 被映射两次)
      { name: 'op3', mapping: 'A->X, B->C, C->A' },  // 未知端口
    ],
    target: 'A->B, B->A, A->C',                        // 非法目标：重复源、缺 C
  });
  assert.equal(r.ok, false);
  const msgs = r.errors.map((e) => e.message).join('\n');
  assert.ok(r.errors.some((e) => /名称重复/.test(e.message)), msgs);
  assert.ok(r.errors.some((e) => /缺失端口/.test(e.message)), msgs);
  assert.ok(r.errors.some((e) => /非双射/.test(e.message)), msgs);
  assert.ok(r.errors.some((e) => /不存在的端口/.test(e.message)), msgs);
  assert.ok(r.errors.some((e) => e.scope === 'target'), msgs);
});

test('校验：端口数越界、操作数越界', () => {
  const tooFew = C.audit({ ports: 'A', operations: [{ name: 'x', mapping: '' }], target: '' });
  assert.equal(tooFew.ok, false);
  assert.ok(tooFew.errors.some((e) => /端口数量不足/.test(e.message)));

  const tooMany = C.validateInput({
    ports: Array.from({ length: 13 }, (_, i) => 'P' + i).join(' '),
    operations: [],
    target: '',
  });
  assert.equal(tooMany.ok, false);
  assert.ok(tooMany.errors.some((e) => /端口数量超限/.test(e.message)));

  const ops9 = C.validateInput({
    ports: 'A B',
    operations: Array.from({ length: 9 }, (_, i) => ({
      name: 'o' + i,
      mapping: '(A B)',
    })),
    target: '(A B)',
  });
  assert.ok(ops9.errors.some((e) => /操作数量超限/.test(e.message)));
});

test('显式映射与循环记号等价解析', () => {
  const names = ['A', 'B', 'C'];
  const idx = { A: 0, B: 1, C: 2 };
  const a = C.parsePermText('(A B C)', names, idx);
  const b = C.parsePermText('A->B, B->C, C->A', names, idx);
  const c = C.parsePermText('A B C', names, idx);
  assert.deepEqual(a.perm, [1, 2, 0]);
  assert.deepEqual(b.perm, a.perm);
  assert.deepEqual(c.perm, a.perm);
});

// ---------- 规模上限：12 端口、8 操作仍可快速完成 ----------

test('规模上限：n=12、8 个生成元（含 S12 生成集）成员判定', () => {
  const names = Array.from({ length: 12 }, (_, i) => 'P' + i);
  const ops = [
    { name: 'g_cycle', mapping: '(' + names.join(' ') + ')' },
    { name: 'g_swap', mapping: '(P0 P1)' },
    { name: 'g_p2', mapping: '(P2 P3)' },
    { name: 'g_p4', mapping: '(P4 P5)' },
    { name: 'g_p6', mapping: '(P6 P7)' },
    { name: 'g_p8', mapping: '(P8 P9)' },
    { name: 'g_p10', mapping: '(P10 P11)' },
    { name: 'g_mid', mapping: '(P5 P8)' },
  ];
  const started = Date.now();
  const r = C.audit({
    ports: names.join(' '),
    operations: ops,
    target: '(P0 P11)(P1 P10)',
  });
  assert.equal(r.ok, true);
  assert.equal(typeof r.member, 'boolean');
  assert.ok(Date.now() - started < 10000, '12 端口计算应在合理时间内结束');
  assert.equal(r.chainSummary.length, 12);
});

// ---------- 旧 Worker 回包不得覆盖新输入/新结论 ----------

test('代次防护：旧请求回包被拒绝，当前代次回包才被接受', () => {
  const stale = C.acceptIfCurrent(2, 1, { member: true });
  assert.equal(stale.accepted, false);
  const fresh = C.acceptIfCurrent(2, 2, { member: false });
  assert.equal(fresh.accepted, true);
  assert.equal(fresh.payload.member, false);
});

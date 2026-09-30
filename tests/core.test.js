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

// ---------- 执行奇偶复核（GF(2) 恒等关系空间） ----------

// 在 (置换, GF(2)^m 奇偶掩码) 扩展状态空间上 BFS：应用生成元 k（含其逆）
// 不改变掩码第 k 位之外的位。仅用于小规模下与奇偶复核结论做独立穷尽对照。
function bruteParityGroup(n, gens) {
  const id = C.identity(n);
  const seen = new Set([id.join(',') + '|0']);
  const queue = [{ p: id, mask: 0 }];
  const reachable = new Set();
  while (queue.length) {
    const cur = queue.shift();
    reachable.add(cur.p.join(',') + '|' + cur.mask);
    for (let k = 0; k < gens.length; k++) {
      for (const g of [gens[k], C.invert(gens[k], n)]) {
        const np = C.compose(cur.p, g, n);
        const nmask = cur.mask ^ (1 << k);
        const key = np.join(',') + '|' + nmask;
        if (!seen.has(key)) {
          seen.add(key);
          queue.push({ p: np, mask: nmask });
        }
      }
    }
  }
  return reachable;
}

// 对全部 n! 目标 × 2^m 奇偶要求比较引擎结论与扩展状态空间穷尽结论
function assertParityAgrees(n, gens) {
  const m = gens.length;
  const reachable = bruteParityGroup(n, gens);
  const names = C.identity(n).map((_, i) => 'p' + i);
  const ops = gens.map((g, i) => ({ name: 'g' + i, perm: g }));
  let checked = 0;
  for (const t of allPerms(n)) {
    for (let mask = 0; mask < 1 << m; mask++) {
      const desired = Array.from({ length: m }, (_, k) => (mask >> k) & 1);
      const r = C.membership(names, ops, t, desired);
      const expected = reachable.has(t.join(',') + '|' + mask);
      assert.equal(
        r.member === true && r.paritySatisfied === true,
        expected,
        '奇偶结论与扩展空间穷尽枚举不一致：target=' + t.join(',') + ' mask=' + mask
      );
      if (expected) {
        // 规范因子链：乘回为目标、奇偶恰为要求
        assert.deepEqual(C.multiplyWord(r.factorWord, gens, n), t);
        assert.deepEqual(C.wordParityVector(r.factorWord, m), desired);
        // 逐步回放终态计数奇偶与要求一致
        const steps = C.expandFactorChain(names, ops, r.factorWord);
        const last = steps[steps.length - 1];
        assert.deepEqual(last.parity, desired);
        assert.deepEqual(last.counts.map((c) => c & 1), desired);
        // 补偶恒等词乘回必为恒等
        if (r.correctionWord.length) {
          assert.deepEqual(C.multiplyWord(r.correctionWord, gens, n), C.identity(n));
        }
      } else if (r.member === true) {
        // 仅奇偶不可满足：必须返回代表向量、差额、独立关系基
        assert.equal(r.reason, 'parity-infeasible');
        assert.ok(Array.isArray(r.repParity) && r.repParity.length === m);
        assert.deepEqual(
          r.parityDiff,
          desired.map((d, k) => d ^ r.repParity[k])
        );
        for (const vec of r.basis) {
          assert.equal(vec.length, m);
          assert.ok(vec.some((b) => b === 1));
        }
      }
      checked++;
    }
  }
  return checked;
}

test('奇偶穷尽对照 n=3：C3（单 3-循环）全部目标×2 种要求一致（12 组合）', () => {
  assert.equal(assertParityAgrees(3, [cyc(3, [0, 1, 2])]), 12);
});

test('奇偶穷尽对照 n=3：S3 全部目标×4 种要求一致（24 组合）', () => {
  assert.equal(assertParityAgrees(3, [cyc(3, [0, 1, 2]), cyc(3, [0, 1])]), 24);
});

test('奇偶穷尽对照 n=4：C4 全部目标×2 种要求一致（48 组合）', () => {
  assert.equal(assertParityAgrees(4, [cyc(4, [0, 1, 2, 3])]), 48);
});

test('奇偶穷尽对照 n=4：Klein 四元群全部目标×4 种要求一致（96 组合）', () => {
  assert.equal(
    assertParityAgrees(4, [cyc(4, [0, 1], [2, 3]), cyc(4, [0, 2], [1, 3])]),
    96
  );
});

test('奇偶穷尽对照 n=4：S4 全部目标×4 种要求一致（96 组合）', () => {
  assert.equal(
    assertParityAgrees(4, [cyc(4, [0, 1, 2, 3]), cyc(4, [0, 1])]),
    96
  );
});

test('奇偶穷尽对照 n=5：两个 3-循环生成 A5，全部目标×4 种要求一致（480 组合）', () => {
  assert.equal(
    assertParityAgrees(5, [cyc(5, [0, 1, 2]), cyc(5, [2, 3, 4])]),
    480
  );
});

test('奇偶复核：S3 中对换必含奇数次对换操作，要求 [偶,偶] 不可满足并给出差额与关系基', () => {
  const r = auditParity(
    ['A', 'B', 'C'],
    [
      { name: 'r', mapping: '(A B C)' },
      { name: 's', mapping: '(A B)' },
    ],
    [0, 0],
    '(A B)'
  );
  assert.equal(r.ok, true);
  assert.equal(r.member, true);
  assert.equal(r.paritySatisfied, false);
  assert.equal(r.reason, 'parity-infeasible');
  // 代表词 (A B) 的奇偶向量为 [0,1]；与要求 [0,0] 的差额为 [0,1]
  assert.deepEqual(r.repParity, [0, 1]);
  assert.deepEqual(r.parityDiff, [0, 1]);
  // 关系空间由 r³=id（奇偶 [1,0]）张成，一维；永远无法改变 s 位
  assert.deepEqual(r.basis, [[1, 0]]);
  // 关系基展示条目按（排序后的）操作名给出
  assert.deepEqual(
    r.basisRelations[0].entries.map((e) => e.operation),
    ['r', 's']
  );
  assert.deepEqual(
    r.repParityEntries.map((e) => [e.operation, e.bit, e.desired, e.diff]),
    [
      ['r', 0, 0, 0],
      ['s', 1, 0, 1],
    ]
  );
});

test('奇偶复核：要求可行时规范因子链乘回为目标且逐操作计数奇偶相符', () => {
  const r = auditParity(
    ['A', 'B', 'C'],
    [
      { name: 'r', mapping: '(A B C)' },
      { name: 's', mapping: '(A B)' },
    ],
    [1, 1],
    '(A B)'
  );
  assert.equal(r.paritySatisfied, true);
  const gens = [cyc(3, [0, 1, 2]), cyc(3, [0, 1])];
  assert.deepEqual(C.multiplyWord(r.factorWord, gens, 3), cyc(3, [0, 1]));
  assert.deepEqual(C.wordParityVector(r.factorWord, 2), [1, 1]);
  // 补偶词非空（代表词本身奇偶为 [0,1]），且乘回为恒等
  assert.ok(r.correctionWord.length > 0);
  assert.deepEqual(C.multiplyWord(r.correctionWord, gens, 3), C.identity(3));
  // 回放逐步计数：末步 [奇,奇]，全程排列合法
  for (const st of r.steps) assert.ok(C.isPermutation(st.perm, 3));
  assert.deepEqual(r.steps[r.steps.length - 1].counts.map((c) => c & 1), [1, 1]);
});

test('奇偶复核：恒等目标要求非零奇偶时，由恒等关系词（如 g³）满足', () => {
  const r = auditParity(
    ['A', 'B', 'C'],
    [{ name: 'r', mapping: '(A B C)' }],
    [1],
    '(A)'
  );
  assert.equal(r.paritySatisfied, true);
  assert.deepEqual(C.multiplyWord(r.factorWord, [cyc(3, [0, 1, 2])], 3), C.identity(3));
  assert.deepEqual(C.wordParityVector(r.factorWord, 1), [1]);
});

test('奇偶复核：目标本身不可导出时仍给首个阻塞层，不进入奇偶判定', () => {
  const r = auditParity(
    ['A', 'B', 'C', 'D'],
    [{ name: 'rotate', mapping: '(A B C D)' }],
    [1],
    '(A B)'
  );
  assert.equal(r.member, false);
  assert.equal(r.reason, 'blocked');
  assert.equal(r.paritySatisfied, undefined);
  assert.ok(!r.evidence.orbitNames.includes(r.evidence.attemptedImageName));
});

test('奇偶复核：关系基每条乘回为恒等且奇偶向量与声明一致', () => {
  const n = 4;
  const gens = [cyc(n, [0, 1, 2, 3]), cyc(n, [0, 1])];
  const levels = C.buildChain(
    n,
    gens,
    gens.map((_, i) => [i + 1])
  );
  const sp = C.buildParitySpace(n, 2, levels);
  for (let k = 0; k < sp.basis.length; k++) {
    assert.deepEqual(C.multiplyWord(sp.basisWords[k], gens, n), C.identity(n));
    assert.deepEqual(C.wordParityVector(sp.basisWords[k], 2), sp.basis[k]);
  }
});

test('奇偶复核：确定性——相同输入给出相同因子链与关系基', () => {
  const input = {
    ports: 'A B C D',
    mode: 'parity',
    operations: [
      { name: 'a', mapping: '(A B C)' },
      { name: 'b', mapping: '(A B D)' },
    ],
    parity: [1, 0],
    target: '(B C D)',
  };
  const r1 = C.audit(input);
  const r2 = C.audit({ ...input, operations: [input.operations[1], input.operations[0]], parity: [0, 1] });
  // 生成元经按名排序后内部顺序一致；parity 随操作录入序一起重排，结论词应相同
  assert.deepEqual(r1.factorWord, r2.factorWord);
  assert.deepEqual(r1.basis, r2.basis);
});

test('奇偶校验：未逐操作指定奇偶时一次性报错，普通模式不要求奇偶', () => {
  const missing = C.audit({
    ports: 'A B',
    mode: 'parity',
    operations: [{ name: 'x', mapping: '(A B)' }],
    parity: [],
    target: '(A B)',
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.scope === 'parity' && /未指定奇偶/.test(e.message)));

  const invalidValue = C.audit({
    ports: 'A B',
    mode: 'parity',
    operations: [{ name: 'x', mapping: '(A B)' }],
    parity: ['weird'],
    target: '(A B)',
  });
  assert.ok(invalidValue.errors.some((e) => e.scope === 'parity'));

  // 普通模式传空 parity 不受影响（普通回归）
  const normal = C.audit({
    ports: 'A B',
    operations: [{ name: 'x', mapping: '(A B)' }],
    target: '(A B)',
  });
  assert.equal(normal.ok, true);
  assert.equal(normal.mode, 'normal');
  assert.equal(normal.paritySatisfied, undefined);
});

test('奇偶复核规模上限：n=12、8 操作下求解仍快速完成且结论可复算', () => {
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
    mode: 'parity',
    operations: ops,
    parity: [1, 0, 1, 0, 1, 0, 1, 0],
    target: '(P0 P11)(P1 P10)',
  });
  assert.equal(r.ok, true);
  assert.equal(r.member, true);
  assert.ok(Date.now() - started < 10000, '12 端口奇偶求解应在合理时间内结束');
  if (r.paritySatisfied) {
    // desiredParity 已随操作名排序重排，回放计数须与回传要求逐位一致
    assert.deepEqual(r.steps[r.steps.length - 1].parity, r.desiredParity);
  }
});

function auditParity(names, ops, parity, targetText) {
  return C.audit({
    ports: names.join(' '),
    mode: 'parity',
    operations: ops,
    parity,
    target: targetText,
  });
}

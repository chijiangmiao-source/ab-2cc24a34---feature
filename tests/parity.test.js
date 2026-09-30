'use strict';
/*
 * parity.test.js —— 整组奇偶复核测试。
 *
 * 独立对照方法（仅用于测试，引擎本身不做枚举）：
 *   在有限状态空间 G × GF(2)^m 上从 (id, 0) 出发，
 *   每执行一次第 k 个操作（或其逆元）置换相乘并翻转第 k 个奇偶位，BFS 可达集。
 *   则“存在满足要求 r 的规程实现目标 t”当且仅当 (t, r) 可达。
 * 对 n≤5 的若干生成集、全部 n! 个目标、全部 2^m 个要求向量与引擎结论逐一对照，
 * 并独立复算规范因子链的乘积与逐操作计数。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../public/core.js');

function cyc(n, ...cycles) {
  const p = C.identity(n);
  for (const c of cycles) {
    for (let i = 0; i < c.length; i++) p[c[i]] = c[(i + 1) % c.length];
  }
  return p;
}

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

// (置换, 奇偶向量) 有限状态空间可达集
function bruteParityReach(n, gens) {
  const m = gens.length;
  const id = C.identity(n);
  const key = (p, v) => p.join(',') + '|' + v;
  const memberSet = new Set(); // 仅置换可达（成员性独立对照）
  const seen = new Set([key(id, 0)]);
  memberSet.add(id.join(','));
  const queue = [{ p: id, v: 0 }];
  while (queue.length) {
    const cur = queue.shift();
    for (let k = 0; k < m; k++) {
      for (const g of [gens[k], C.invert(gens[k], n)]) {
        const np = C.compose(cur.p, g, n);
        const nv = cur.v ^ (1 << k);
        memberSet.add(np.join(','));
        const kk = key(np, nv);
        if (!seen.has(kk)) {
          seen.add(kk);
          queue.push({ p: np, v: nv });
        }
      }
    }
  }
  return {
    has: (p, mask) => seen.has(key(p, mask)),
    isMember: (p) => memberSet.has(p.join(',')),
  };
}

function parityAudit(names, opDefs, targetText, parity) {
  return C.audit({
    ports: names.join(' '),
    operations: opDefs,
    target: targetText,
    mode: 'parity',
    parity,
  });
}

// 对全部目标 × 全部要求向量做穷举对照，并独立复算规范链
function assertParityAgrees(n, gens, labels) {
  labels = labels || gens.map((_, i) => 'g' + i);
  const names = C.identity(n).map((_, i) => 'p' + i);
  const ops = gens.map((g, i) => ({ name: labels[i], perm: g }));
  const reach = bruteParityReach(n, gens);
  const m = gens.length;
  let checks = 0;
  for (const t of allPerms(n)) {
    const memberExpected = reach.isMember(t);
    for (let mask = 0; mask < 1 << m; mask++) {
      const required = [];
      for (let k = 0; k < m; k++) required.push((mask >> k) & 1);
      const r = C.parityMembership(names, ops, t, required);

      if (!memberExpected) {
        assert.equal(r.member, false, '成员性误判：' + t.join(','));
        assert.equal(r.reason, 'blocked', '不可导出必须仍给首个阻塞层');
        assert.ok(r.evidence.orbit.length > 0);
        checks++;
        continue;
      }
      const feasibleExpected = reach.has(t, mask);
      if (feasibleExpected) {
        assert.equal(r.reason, 'parity-derivable',
          '应为 parity-derivable：t=' + t.join(',') + ' mask=' + mask);
        assert.equal(r.paritySatisfied, true);
        // 独立复算规范链乘积
        const rebuilt = C.multiplyWord(r.factorWord, gens, n);
        assert.deepEqual(rebuilt, t, '规范链乘积不等于目标');
        // 独立逐操作计数核对
        const counts = C.factorCounts(r.factorWord, m);
        for (let k = 0; k < m; k++) {
          assert.equal(
            counts[k] & 1,
            required[k],
            '操作 ' + k + ' 奇偶不符：t=' + t.join(',') + ' mask=' + mask
          );
        }
        // 回放出的逐步计数终态一致，且每步累计计数单调正确
        const steps = C.expandFactorChain(names, ops, r.factorWord, true);
        assert.deepEqual(steps[steps.length - 1].perm, t);
        assert.deepEqual(steps[0].counts, new Array(m).fill(0));
        for (let s = 1; s < steps.length; s++) {
          let total = 0;
          for (let k = 0; k < m; k++) {
            assert.ok(steps[s].counts[k] >= steps[s - 1].counts[k]);
            total += steps[s].counts[k];
          }
          assert.equal(total, s);
        }
        // 关系基向量必须张成真实恒等奇偶空间：每个基词独立乘回确为恒等
        for (const b of r.relationBasis) {
          assert.ok(C.isIdentity(C.multiplyWord(b.word, gens, n)), '关系基词不为恒等');
        }
      } else {
        assert.equal(r.reason, 'parity-infeasible',
          '应为 parity-infeasible：t=' + t.join(',') + ' mask=' + mask);
        assert.equal(r.paritySatisfied, false);
        // 必须展示目标代表奇偶向量、所需差额与独立关系基
        assert.equal(r.representativeParity.length, m);
        assert.equal(r.parityDiff.length, m);
        assert.ok(Array.isArray(r.relationBasis));
        // 代表词仍表达目标
        assert.deepEqual(C.multiplyWord(r.representativeWord, gens, n), t);
      }
      checks++;
    }
  }
  return checks;
}

// ---------- 穷举对照 ----------

test('奇偶对照 n=3：C3（1 个 3-循环），全部目标×2 个要求', () => {
  assert.equal(assertParityAgrees(3, [cyc(3, [0, 1, 2])]), 12);
});

test('奇偶对照 n=3：S3（3-循环+对换），全部目标×4 个要求', () => {
  assert.equal(assertParityAgrees(3, [cyc(3, [0, 1, 2]), cyc(3, [0, 1])]), 24);
});

test('奇偶对照 n=4：C4，全部目标×2 个要求', () => {
  assert.equal(assertParityAgrees(4, [cyc(4, [0, 1, 2, 3])]), 48);
});

test('奇偶对照 n=4：Klein 四元群（两个对合），全部目标×4 个要求', () => {
  assert.equal(
    assertParityAgrees(4, [cyc(4, [0, 1], [2, 3]), cyc(4, [0, 2], [1, 3])]),
    96
  );
});

test('奇偶对照 n=4：S4（4-循环+对换），全部目标×4 个要求', () => {
  assert.equal(
    assertParityAgrees(4, [cyc(4, [0, 1, 2, 3]), cyc(4, [0, 1])]),
    96
  );
});

test('奇偶对照 n=4：3 个生成元（含冗余奇偶耦合），全部目标×8 个要求', () => {
  // g0 与 g1 同置换（不同名）→ 恒等关系奇偶 (1,1,0)
  assert.equal(
    assertParityAgrees(4, [cyc(4, [0, 1]), cyc(4, [0, 1]), cyc(4, [0, 1, 2, 3])], ['a', 'b', 'r']),
    192
  );
});

test('奇偶对照 n=5：A5（两个 3-循环），全部目标×4 个要求', () => {
  assert.equal(
    assertParityAgrees(5, [cyc(5, [0, 1, 2]), cyc(5, [2, 3, 4])]),
    480
  );
});

test('奇偶对照 n=5：S5（5-循环+对换），全部目标×4 个要求', () => {
  assert.equal(
    assertParityAgrees(5, [cyc(5, [0, 1, 2, 3, 4]), cyc(5, [0, 1])]),
    480
  );
});

// ---------- 语义场景 ----------

test('S3 目标 (A C) 要求 a 偶 / b 奇：规范链满足且可回放', () => {
  const r = parityAudit(
    ['A', 'B', 'C'],
    [
      { name: 'a', mapping: '(A B C)' },
      { name: 'b', mapping: '(A B)' },
    ],
    '(A C)',
    [0, 1]
  );
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'parity-derivable');
  const counts = r.parityCounts;
  assert.equal(counts[0] & 1, 0);
  assert.equal(counts[1] & 1, 1);
  // 终态即目标，且每步携带逐操作计数
  const last = r.steps[r.steps.length - 1];
  assert.deepEqual(last.perm, cyc(3, [0, 2]));
  assert.deepEqual(last.counts, counts);
  // 修正词独立乘回为恒等
  assert.ok(C.isIdentity(C.multiplyWord(r.correctionWord,
    [cyc(3, [0, 1, 2]), cyc(3, [0, 1])], 3)));
});

test('S3 目标 (A C) 要求 b 偶：不可满足，展示代表奇偶、差额、关系基', () => {
  const r = parityAudit(
    ['A', 'B', 'C'],
    [
      { name: 'a', mapping: '(A B C)' },
      { name: 'b', mapping: '(A B)' },
    ],
    '(A C)',
    [0, 0]
  );
  assert.equal(r.reason, 'parity-infeasible');
  // a 阶 3 给出奇偶关系基 (1,0)；目标代表词（由确定性链给出）奇偶为 (1,1)，
  // 要求 (0,0) 时差额 (1,1) 不在 span{(1,0)} 内
  assert.deepEqual(r.representativeParity, [1, 1]);
  assert.deepEqual(r.parityDiff, [1, 1]);
  const basisVecs = r.relationBasis.map((b) => b.parity);
  assert.deepEqual(basisVecs, [[1, 0]]);
  // 关系词必须为恒等
  for (const b of r.relationBasis) {
    assert.ok(C.isIdentity(C.multiplyWord(b.word,
      [cyc(3, [0, 1, 2]), cyc(3, [0, 1])], 3)));
  }
});

test('平凡奇偶空间（对合群 V4）要求无法补偿：关系基为空', () => {
  const r = parityAudit(
    ['A', 'B', 'C', 'D'],
    [
      { name: 'a', mapping: '(A B)(C D)' },
      { name: 'b', mapping: '(A C)(B D)' },
    ],
    '(A B)(C D)',
    [0, 1] // 要求 a 偶，但 a 非恒等
  );
  assert.equal(r.reason, 'parity-infeasible');
  assert.deepEqual(r.relationBasis, []);
  assert.deepEqual(r.representativeParity, [1, 0]);
  assert.deepEqual(r.parityDiff, [1, 1]);
});

test('恒等目标要求操作奇数次：用奇数阶关系回构（a 阶 3 → a·a·a）', () => {
  const r = parityAudit(
    ['A', 'B', 'C'],
    [{ name: 'a', mapping: '(A B C)' }],
    '(A)',
    [1]
  );
  assert.equal(r.reason, 'parity-derivable');
  assert.deepEqual(C.multiplyWord(r.factorWord, [cyc(3, [0, 1, 2])], 3), C.identity(3));
  assert.equal(r.parityCounts[0] & 1, 1);
});

test('目标本身不可导出：奇偶模式仍返回首个阻塞层，不进入奇偶判定', () => {
  const r = parityAudit(
    ['A', 'B', 'C', 'D'],
    [{ name: 'r', mapping: '(A B C D)' }],
    '(A B)',
    [1]
  );
  assert.equal(r.member, false);
  assert.equal(r.reason, 'blocked');
  assert.equal(r.mode, 'parity');
  assert.ok(!r.evidence.orbitNames.includes(r.evidence.attemptedImageName));
  assert.equal(r.relationBasis, undefined);
});

// ---------- 输入与协议 ----------

test('奇偶要求缺失或非法时一次性返回错误', () => {
  const r = C.audit({
    ports: 'A B C',
    operations: [
      { name: 'a', mapping: '(A B C)' },
      { name: 'b', mapping: '(A B)' },
    ],
    target: '(A C)',
    mode: 'parity',
    parity: ['odd', 'weird'],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.scope === 'parity'));
});

test('普通模式不带奇偶结论；mode 缺省即为普通模式', () => {
  const r = C.audit({
    ports: 'A B C',
    operations: [{ name: 'a', mapping: '(A B C)' }],
    target: '(A B C)',
  });
  assert.equal(r.mode, 'normal');
  assert.equal(r.reason, 'derivable');
  assert.equal(r.paritySatisfied, undefined);
  assert.equal(r.steps[0].counts, undefined);
});

test('确定性：奇偶复核重复运行给出完全相同的规范链', () => {
  const input = {
    ports: 'A B C D',
    operations: [
      { name: 'r', mapping: '(A B C D)' },
      { name: 's', mapping: '(A B)' },
    ],
    target: '(A C)(B D)',
    mode: 'parity',
    parity: ['odd', 'odd'],
  };
  const a = C.audit(input);
  const b = C.audit(input);
  assert.deepEqual(a.factorWord, b.factorWord);
  assert.deepEqual(a.relationBasis.map((x) => x.parity), b.relationBasis.map((x) => x.parity));
});

test('规模上限：n=12、8 操作奇偶复核在合理时间内完成并通过终校', () => {
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
    mode: 'parity',
    parity: ops.map(() => 'even'),
  });
  assert.ok(Date.now() - started < 10000);
  // S12 的恒等奇偶空间为“总次数偶”超平面：秩 m-1
  assert.equal(r.relationBasis.length, 7);
  for (let k = 0; k < 8; k++) assert.equal(r.parityCounts[k] & 1, 0);
});

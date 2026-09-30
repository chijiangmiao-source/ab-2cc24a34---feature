'use strict';
/*
 * core.js —— 光阑换位置换群审计核心（无 DOM 依赖，可在 Window / Worker / Node 下复用）
 *
 * 约定
 *   端口集合 Ω = {0,...,n-1}，按端口标识排序；稳定基点顺序为 [0,1,...,n-1]。
 *   置换用长度 n 的数组表示，p[x] = x 的像。
 *   乘法约定：(a*b)[x] = b[a[x]]，即先执行 a 再执行 b，与操作依次执行的直觉一致。
 *   生成元词（因子词）为整数编号序列：k+1 表示第 k 个生成元，-(k+1) 表示其逆元；
 *   词中因子从左到右依次执行。
 *
 * 成员判定：确定性 Schreier–Sims 稳定子链
 *   G^(0) ≥ G^(1) ≥ ... ≥ G^(n) = {id}，G^(i) 为前 i 个基点的逐点稳定子。
 *   每层保存强生成元与基点轨道的横截代表；成员结论由横截代表逐层剥离复算，
 *   并对所得因子词做独立乘回校验。不枚举操作串、不使用随机搜索、不做有限深度回放。
 */

// ---------------- 基础置换运算 ----------------

function identity(n) {
  const r = new Array(n);
  for (let i = 0; i < n; i++) r[i] = i;
  return r;
}

function isPermutation(p, n) {
  if (!Array.isArray(p) || p.length !== n) return false;
  const seen = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = p[i];
    if (!Number.isInteger(v) || v < 0 || v >= n || seen[v]) return false;
    seen[v] = 1;
  }
  return true;
}

function compose(a, b, n) {
  // a*b：先执行 a，再执行 b
  const r = new Array(n);
  for (let i = 0; i < n; i++) r[i] = b[a[i]];
  return r;
}

function invert(p, n) {
  const r = new Array(n);
  for (let i = 0; i < n; i++) r[p[i]] = i;
  return r;
}

function equalPerm(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isIdentity(p) {
  for (let i = 0; i < p.length; i++) if (p[i] !== i) return false;
  return true;
}

// ---------------- 因子词运算 ----------------

function concatWord(a, b) {
  const r = new Array(a.length + b.length);
  for (let i = 0; i < a.length; i++) r[i] = a[i];
  for (let i = 0; i < b.length; i++) r[a.length + i] = b[i];
  return r;
}

function invertWord(w) {
  const r = new Array(w.length);
  for (let i = 0; i < w.length; i++) r[w.length - 1 - i] = -w[i];
  return r;
}

// 按因子词从恒等开始依次乘回，得到词所表达的置换
function multiplyWord(word, generators, n) {
  let p = identity(n);
  for (const tok of word) {
    const g = generators[Math.abs(tok) - 1];
    p = compose(p, tok > 0 ? g : invert(g, n), n);
  }
  return p;
}

// ---------------- 输入解析与一次性全量校验 ----------------

function parsePortList(text) {
  const errors = [];
  const names = String(text == null ? '' : text)
    .split(/[\s,，;；]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (names.length < 2) errors.push('端口数量不足：至少需要 2 个稳定端口');
  if (names.length > 12) errors.push('端口数量超限：最多允许 12 个稳定端口');
  const seen = new Set();
  const dup = new Set();
  for (const nm of names) {
    if (seen.has(nm) && !dup.has(nm)) {
      dup.add(nm);
      errors.push('端口标识重复：“' + nm + '”');
    }
    seen.add(nm);
  }
  return { names: names.filter((nm, i) => names.indexOf(nm) === i), errors };
}

/*
 * 解析一段置换文本。支持：
 *   循环记号  (A B C)(D E)      —— A→B→C→A，D↔E；固定点写 (A)
 *   显式映射  A->B, B->C, C->A  —— 亦接受 → / => / : 作为分隔符
 *   无括号循环 A B C             —— 整行视为一个循环
 * 必须恰好覆盖全部端口各一次；未知端口、重复出现、缺失端口全部收集为错误。
 */
function parsePermText(text, names, indexByName) {
  const n = names.length;
  const raw = String(text == null ? '' : text).trim();
  const errors = [];
  if (!raw) return { perm: null, errors: ['置换内容为空'] };

  const normalized = raw.replace(/→/g, '->').replace(/=>/g, '->');
  const pairs = []; // [fromIdx, toIdx]
  let explicitMode = false;
  const unknown = (x) => errors.push('引用了不存在的端口：“' + x + '”');

  const addCycle = (tokens, label) => {
    const idxs = [];
    for (const tk of tokens) {
      if (!tk) continue;
      if (Object.prototype.hasOwnProperty.call(indexByName, tk)) {
        idxs.push(indexByName[tk]);
      } else {
        unknown(tk);
      }
    }
    if (idxs.length === 0) return;
    for (let i = 0; i < idxs.length; i++) {
      pairs.push([idxs[i], idxs[(i + 1) % idxs.length]]);
    }
  };

  if (normalized.includes('->') || normalized.includes(':')) {
    // 显式映射模式：必须显式给出每个端口的去向
    explicitMode = true;
    const chunks = normalized.split(/[,，;；\n\r]+/);
    for (const chunk of chunks) {
      const c = chunk.trim();
      if (!c) continue;
      const sep = c.includes('->') ? '->' : ':';
      const at = c.indexOf(sep);
      const lhs = c.slice(0, at).trim();
      const rhs = c.slice(at + sep.length).trim();
      if (!lhs || !rhs) {
        errors.push('无法解析的映射条目：“' + c + '”（应为 端口->端口）');
        continue;
      }
      const li = Object.prototype.hasOwnProperty.call(indexByName, lhs)
        ? indexByName[lhs]
        : -1;
      const ri = Object.prototype.hasOwnProperty.call(indexByName, rhs)
        ? indexByName[rhs]
        : -1;
      if (li === -1) unknown(lhs);
      if (ri === -1) unknown(rhs);
      if (li !== -1 && ri !== -1) pairs.push([li, ri]);
    }
  } else if (normalized.includes('(') || normalized.includes('（')) {
    // 循环记号模式
    const groups = normalized
      .replace(/[（]/g, '(')
      .replace(/[）]/g, ')')
      .match(/\(([^)]*)\)/g);
    if (!groups) {
      errors.push('无法解析的循环记号：“' + raw + '”');
    } else {
      const covered = groups.join('');
      const rest = normalized.replace(/\(([^)]*)\)/g, '').replace(/[()\s]/g, '');
      if (rest) errors.push('循环记号外存在无法识别的内容：“' + rest + '”');
      for (const g of groups) {
        const tokens = g
          .slice(1, -1)
          .split(/[\s,，]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        addCycle(tokens);
      }
    }
  } else {
    // 整行视为一个空格/逗号分隔的循环
    const tokens = normalized
      .split(/[\s,，]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    addCycle(tokens);
  }

  if (errors.length) return { perm: null, errors };

  // 组装并校验双射性与完整性（缺失端口）
  const perm = new Array(n).fill(-1);
  const lhsSeen = new Uint8Array(n);
  const rhsSeen = new Uint8Array(n);
  for (const [l, r] of pairs) {
    if (lhsSeen[l]) errors.push('端口 “' + names[l] + '” 的映射被重复定义（非双射）');
    if (rhsSeen[r]) errors.push('端口 “' + names[r] + '” 被多个源端口映射（非双射）');
    lhsSeen[l] = 1;
    rhsSeen[r] = 1;
    perm[l] = r;
  }
  for (let i = 0; i < n; i++) {
    if (!lhsSeen[i]) {
      if (explicitMode) {
        errors.push('缺失端口：未给出 “' + names[i] + '” 的去向');
      } else {
        // 循环记号：未出现的端口为固定点
        perm[i] = i;
        lhsSeen[i] = 1;
        rhsSeen[i] = 1;
      }
    }
  }
  if (errors.length) return { perm: null, errors };
  if (!isPermutation(perm, n)) {
    errors.push('映射不是端口集合上的双射');
    return { perm: null, errors };
  }
  return { perm, errors: [] };
}

/*
 * 全量校验：端口、操作（具名置换）、目标；奇偶复核模式下还校验每操作奇偶选择。
 * 所有错误一次性返回（重复操作名、缺失端口、非双射映射、非法目标、未指定奇偶等），
 * 调用方据此立即撤销旧结论。
 */
function validateInput(input) {
  const errors = [];
  const mode = input.mode === 'parity' ? 'parity' : 'normal';
  const { names, errors: portErrors } = parsePortList(input.ports || '');
  for (const e of portErrors) errors.push({ scope: 'ports', message: e });

  const operations = Array.isArray(input.operations) ? input.operations : [];
  if (operations.length === 0) {
    errors.push({ scope: 'operations', message: '至少需要 1 个具名置换操作' });
  }
  if (operations.length > 8) {
    errors.push({ scope: 'operations', message: '具名置换操作数量超限：最多 8 个' });
  }

  const nameSet = new Set();
  const opNameSeen = new Set();
  for (const nm of names) nameSet.add(nm);
  const indexByName = {};
  names.forEach((nm, i) => {
    indexByName[nm] = i;
  });

  const ops = [];
  operations.forEach((op, idx) => {
    const label = '操作' + (idx + 1);
    const opName = String(op.name == null ? '' : op.name).trim();
    if (!opName) {
      errors.push({ scope: 'operation', index: idx, message: label + '缺少名称' });
    } else if (opNameSeen.has(opName)) {
      errors.push({
        scope: 'operation',
        index: idx,
        message: '操作名称重复：“' + opName + '”',
      });
    }
    opNameSeen.add(opName);
    if (names.length >= 2) {
      const { perm, errors: pErr } = parsePermText(op.mapping, names, indexByName);
      for (const e of pErr) {
        errors.push({
          scope: 'operation',
          index: idx,
          message: (opName ? '操作“' + opName + '”：' : label + '：') + e,
        });
      }
      ops.push({ name: opName, perm });
    } else {
      ops.push({ name: opName, perm: null });
    }
  });

  let target = null;
  const targetText = String(input.target == null ? '' : input.target).trim();
  if (!targetText) {
    errors.push({ scope: 'target', message: '非法目标：目标置换为空' });
  } else if (names.length >= 2) {
    const { perm, errors: tErr } = parsePermText(input.target, names, indexByName);
    for (const e of tErr) {
      errors.push({ scope: 'target', message: '非法目标：' + e });
    }
    target = perm;
  }

  // 奇偶复核模式：每个已定义操作都必须指定本次规程中出现奇数次还是偶数次
  let parity = null;
  if (mode === 'parity') {
    const validParity = new Set([0, 1, 'odd', 'even']);
    parity = operations.map(() => 0);
    const rawParity = Array.isArray(input.parity) ? input.parity : [];
    operations.forEach((op, idx) => {
      if (!validParity.has(rawParity[idx])) {
        errors.push({
          scope: 'parity',
          index: idx,
          message:
            '操作“' +
            (String(op.name == null ? '' : op.name).trim() || '操作' + (idx + 1)) +
            '”未指定奇偶要求（奇数次/偶数次）',
        });
      }
    });
    if (!errors.some((e) => e.scope === 'parity')) {
      rawParity.forEach((v, idx) => {
        parity[idx] = v === 1 || v === 'odd' ? 1 : 0;
      });
    }
  }

  if (errors.length) return { ok: false, errors, names: [], operations: [], target: null };

  // 生成元按操作名排序，保证构造过程完全确定（端口标识亦已排序）
  const order = ops.map((_, i) => i).sort((a, b) =>
    ops[a].name < ops[b].name ? -1 : ops[a].name > ops[b].name ? 1 : a - b
  );
  const sortedOps = order.map((i) => ops[i]);
  const sortedParity = parity ? order.map((i) => parity[i]) : null;
  return {
    ok: true,
    errors: [],
    mode,
    names,
    operations: sortedOps,
    target,
    parity: sortedParity,
  };
}

// ---------------- 确定性 Schreier–Sims 稳定子链 ----------------

function createLevels(n) {
  const levels = [];
  for (let i = 0; i < n; i++) {
    const beta = new Array(n).fill(null);
    const word = new Array(n).fill(null);
    const inv = new Array(n).fill(null);
    beta[i] = identity(n);
    word[i] = [];
    inv[i] = identity(n);
    levels.push({ base: i, S: [], genWord: [], Skeys: new Set(), beta, word, inv });
  }
  return levels;
}

// 剥离（sift）：用各层横截代表逐层消去基点像。
// 返回 null 表示完全剥离（属于当前链）；否则返回残差及其首个无法归约的层级。
function sift(levels, n, p, word, startLevel) {
  let cur = p;
  let curWord = word.slice();
  for (let i = startLevel; i < n; i++) {
    const L = levels[i];
    const x = cur[i];
    if (x === i) continue; // 已固定该基点
    const t = L.beta[x];
    if (t == null) return { perm: cur, word: curWord, level: i };
    // 消去基点像：先执行 cur（基点 -> x），再执行 t^{-1}（x -> 基点）
    // 在本文件“先 a 后 b、(a*b)[i]=b[a[i]]”的约定下即 cur * t^{-1}
    cur = compose(cur, invert(t, n), n);
    curWord = concatWord(curWord, invertWord(L.word[x]));
  }
  return isIdentity(cur) ? null : { perm: cur, word: curWord, level: n };
}

function buildChain(n, generators, genWords) {
  const levels = createLevels(n);

  // 扩展第 i 层横截轨道直到不动点；按点下标升序 BFS，代表元选择确定。
  // S[i] 为 G^(i) 的生成元集合：包含落点在第 i 层及更深层的全部强生成元。
  function extendTransversal(i) {
    const L = levels[i];
    let added = 0;
    let changed = true;
    while (changed) {
      changed = false;
      for (let x = 0; x < n; x++) {
        if (L.beta[x] == null) continue;
        for (let gi = 0; gi < L.S.length; gi++) {
          const y = L.S[gi][x];
          if (L.beta[y] == null) {
            const rep = compose(L.beta[x], L.S[gi], n);
            L.beta[y] = rep;
            L.word[y] = concatWord(L.word[x], L.genWord[gi]);
            L.inv[y] = invert(rep, n);
            added++;
            changed = true;
          }
        }
      }
    }
    return added;
  }

  // Schreier 生成元： beta(x) * g * beta(g(x))^{-1}（固定基点 i，属于 G^(i+1)）
  function makeSchreier(i, x, gi) {
    const L = levels[i];
    const g = L.S[gi];
    const y = g[x];
    if (L.beta[x] == null || L.beta[y] == null) return null;
    const perm = compose(compose(L.beta[x], g, n), L.inv[y], n);
    if (isIdentity(perm)) return null;
    const word = concatWord(
      concatWord(L.word[x], L.genWord[gi]),
      invertWord(L.word[y])
    );
    return { perm, word };
  }

  // 剥离残差 h 的首个非固定基点为 k：h ∈ G^(startLevel)…G^(k)，
  // 因此把它加入 startLevel..k 每一层的生成元集合（低层横截扩展需要它，
  // 即使它固定该层基点——经横截代表共轭后仍会扩展轨道）。
  function insertGenerator(g, word, startLevel) {
    const residual = sift(levels, n, g, word, startLevel);
    if (!residual) return false;
    if (residual.level >= n) return false; // 固定全部基点必为恒等
    const key = residual.perm.join(',');
    // 同一残差置换在不同闭包轮次可能再次出现；只在尚未收录它的层级加入
    let added = false;
    for (let j = startLevel; j <= residual.level; j++) {
      if (levels[j].Skeys.has(key + '@' + j)) continue;
      levels[j].Skeys.add(key + '@' + j);
      levels[j].S.push(residual.perm);
      levels[j].genWord.push(residual.word.slice());
      added = true;
    }
    return added;
  }

  // 初始生成元按（已排序的）录入顺序逐一插入，从第 0 层开始剥离
  for (let gi = 0; gi < generators.length; gi++) {
    insertGenerator(generators[gi], genWords[gi], 0);
  }

  // 确定性闭包：自低层向高层反复扩展轨道并剥离全部 Schreier 生成元，
  // Schreier 生成元固定本层基点，故从下一层（稳定子）开始剥离。
  // 直到没有新点、也没有新残差强生成元为止（有限群保证终止）。
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let i = 0; i < n; i++) {
      if (extendTransversal(i) > 0) progressed = true;
      const L = levels[i];
      for (let x = 0; x < n; x++) {
        if (L.beta[x] == null) continue;
        for (let gi = 0; gi < L.S.length; gi++) {
          const sch = makeSchreier(i, x, gi);
          if (!sch) continue;
          if (insertGenerator(sch.perm, sch.word, i + 1)) progressed = true;
        }
      }
    }
  }

  return levels;
}

// ---------------- GF(2) 奇偶空间（恒等关系空间） ----------------
//
// 对群 G = <g_0,...,g_{m-1}>，记 F 为生成元（含逆元）上的自由群，φ:F→G 为字映射，
// N = ker φ 为恒等关系词集合。每个词 w ∈ N 对应 GF(2)^m 奇偶向量 par(w)：
// 第 k 位为词中第 k 个操作（其逆元记号仍记一次该操作）出现次数模 2。
// 若已有代表词 w0（φ(w0)=target，奇偶 p0），则存在奇偶向量恰为 d 的规程
//   ⇔ d + p0 ∈ { par(w) : w ∈ N }（GF(2) 加法）。
//
// 完备稳定子链下，每层每个 Schreier 生成元
//   s = β(x)·g·β(g(x))⁻¹ ∈ G^(i+1)
// 都能被更深层横截代表完全剥离为恒等：s 的 Schreier 词拼上剥离用代表逆词，
// 即得一个补偶恒等词。这些词的奇偶向量张成整个 N 的奇偶空间——
// 任一词在逐层剥离中被精确改写为 Schreier 词与代表词的乘积（Reidemeister–
// Schreier 重写），其模 2 像即这些关系的组合。全程仅做 GF(2) 线性代数，
// 不枚举群元素、不穷举操作串、不以有限深度搜索代替。

// 因子词 -> GF(2) 奇偶向量（长度 m 的 0/1 数组）；逆元记号与正元同属一个操作
function wordParityVector(word, m) {
  const v = new Array(m).fill(0);
  for (const tok of word) v[Math.abs(tok) - 1] ^= 1;
  return v;
}

function vecCopy(v) {
  return v.slice();
}
function vecXor(a, b) {
  const r = new Array(a.length);
  for (let i = 0; i < a.length; i++) r[i] = a[i] ^ b[i];
  return r;
}

/*
 * 从完备稳定子链构造恒等关系的奇偶空间。
 * 返回 { basis, basisWords }：
 *   basis[k]      —— 第 k 个独立关系的 GF(2)^m 奇偶向量（主元列严格递增的行阶梯形）
 *   basisWords[k] —— 对应的补偶恒等因子词（逐操作乘回必为恒等）
 */
function buildParitySpace(n, m, levels) {
  const rows = []; // 每个 Schreier 关系一条 { vec, word }
  for (let i = 0; i < n; i++) {
    const L = levels[i];
    for (let x = 0; x < n; x++) {
      if (L.beta[x] == null) continue;
      for (let gi = 0; gi < L.S.length; gi++) {
        const g = L.S[gi];
        const y = g[x];
        if (L.beta[y] == null) continue;
        // Schreier 置换 β(x)·g·β(y)⁻¹ 固定基点 i；其词为头段
        const perm0 = compose(compose(L.beta[x], g, n), L.inv[y], n);
        const word0 = concatWord(
          concatWord(L.word[x], L.genWord[gi]),
          invertWord(L.word[y])
        );
        // 完备链下自 i+1 层起横截剥离必到恒等；同步拼出补偶恒等词
        let perm = perm0;
        let word = word0;
        for (let j = i + 1; j < n; j++) {
          const Lj = levels[j];
          const z = perm[j];
          if (z === j) continue;
          perm = compose(perm, Lj.inv[z], n);
          word = concatWord(word, invertWord(Lj.word[z]));
        }
        if (!isIdentity(perm)) continue; // 链已完备，理论上不发生
        const vec = wordParityVector(word, m);
        if (vec.every((b) => b === 0)) continue; // 自身偶词，零向量无信息
        rows.push({ vec, word });
      }
    }
  }

  // GF(2) 高斯消元（按层/点/生成元的确定性录入顺序），保留行组合以回构关系词
  const basis = [];
  const basisWords = [];
  const pivotOf = new Map(); // 主元列 -> basis 行号
  for (const row of rows) {
    let vec = vecCopy(row.vec);
    let word = row.word.slice();
    for (;;) {
      let col = -1;
      for (let k = 0; k < m; k++) {
        if (vec[k]) {
          col = k;
          break;
        }
      }
      if (col === -1) break; // 与已有基线性相关，丢弃
      if (pivotOf.has(col)) {
        const bi = pivotOf.get(col);
        vec = vecXor(vec, basis[bi]);
        // 奇偶向量模 2 相加 <=> 两个恒等词拼接（积仍为恒等）
        word = concatWord(word, basisWords[bi]);
        continue;
      }
      pivotOf.set(col, basis.length);
      basis.push(vec);
      basisWords.push(word);
      break;
    }
  }
  return { basis, basisWords };
}

/*
 * 在奇偶空间中求解 v ∈ span(basis)（GF(2)）。
 * basis 为主元列严格递增的行阶梯形；返回系数 c（v = Σ c[k]·basis[k]），无解返回 null。
 */
function solveParity(basis, v) {
  const m = v.length;
  const cur = vecCopy(v);
  const c = new Array(basis.length).fill(0);
  for (let k = 0; k < basis.length; k++) {
    let pivot = -1;
    for (let j = 0; j < m; j++) {
      if (basis[k][j]) {
        pivot = j;
        break;
      }
    }
    if (pivot === -1) continue;
    if (cur[pivot]) {
      c[k] = 1;
      for (let j = 0; j < m; j++) cur[j] ^= basis[k][j];
    }
  }
  return cur.every((b) => b === 0) ? c : null;
}

// ---------------- 成员判定与因子链 / 不可归约证据 ----------------

function orbitPoints(level, n) {
  const pts = [];
  for (let x = 0; x < n; x++) {
    if (level.beta[x] != null) pts.push(x);
  }
  return pts;
}

function membership(names, operations, target, desiredParity) {
  const n = names.length;
  const m = operations.length;
  const parityMode = Array.isArray(desiredParity);
  const generators = operations.map((o) => o.perm);
  const genWords = generators.map((_, i) => [i + 1]);
  const levels = buildChain(n, generators, genWords);

  let cur = target;
  const layerWords = []; // 每层所用横截代表的因子词
  const layers = []; // 逐层归约回放记录
  for (let i = 0; i < n; i++) {
    const L = levels[i];
    const x = cur[i];
    if (x === i) {
      layerWords.push([]);
      layers.push({
        level: i,
        base: i,
        image: i,
        moved: false,
        orbit: orbitPoints(L, n),
      });
      continue;
    }
    const rep = L.beta[x];
    if (rep == null) {
      // 首个无法继续归约的端口层：目标像点不在该基点轨道内
      return {
        member: false,
        reason: 'blocked',
        blockedLayer: i,
        evidence: {
          level: i,
          base: i,
          attemptedImage: x,
          orbit: orbitPoints(L, n),
          residual: cur.slice(),
        },
        chainSummary: summarizeChain(levels, n),
      };
    }
    layers.push({
      level: i,
      base: i,
      image: x,
      moved: true,
      repWord: L.word[x].slice(),
      orbit: orbitPoints(L, n),
    });
    layerWords.push(L.word[x].slice());
    // cur <- cur * t^{-1}：先执行 cur，再以横截代表之逆把基点像送回基点
    cur = compose(cur, invert(rep, n), n);
  }
  // target = t_{n-1} * … * t_1 * t_0，可执行因子链按层序反转后拼接
  const repFactorWord = [];
  for (let i = n - 1; i >= 0; i--) {
    for (const tok of layerWords[i]) repFactorWord.push(tok);
  }

  if (!isIdentity(cur)) {
    // 完备链下不会到达这里；作为防御性结论返回
    return {
      member: false,
      reason: 'residual',
      blockedLayer: n - 1,
      evidence: { level: n - 1, base: n - 1, attemptedImage: -1, orbit: [], residual: cur.slice() },
      chainSummary: summarizeChain(levels, n),
    };
  }

  // 独立复算：把横截代表拼出的因子词逐操作乘回，必须恰好等于目标
  const rebuilt = multiplyWord(repFactorWord, generators, n);
  if (!equalPerm(rebuilt, target)) {
    return {
      member: false,
      reason: 'verify-mismatch',
      blockedLayer: -1,
      evidence: { level: -1, base: -1, attemptedImage: -1, orbit: [], residual: rebuilt },
      chainSummary: summarizeChain(levels, n),
    };
  }

  // 普通可导出模式：代表因子链即最终结论
  if (!parityMode) {
    return {
      member: true,
      reason: 'derivable',
      factorWord: repFactorWord,
      layers,
      chainSummary: summarizeChain(levels, n),
    };
  }

  // 奇偶复核模式：在恒等关系的 GF(2) 奇偶空间中为代表词补齐奇偶
  const repParity = wordParityVector(repFactorWord, m);
  const diff = vecXor(repParity, desiredParity);
  const space = buildParitySpace(n, m, levels);
  const coeffs = solveParity(space.basis, diff);

  const parityInfo = {
    desiredParity: desiredParity.slice(),
    repParity,
    parityDiff: diff,
    basis: space.basis.map(vecCopy),
  };

  if (coeffs === null) {
    // 目标可导出，但不存在满足整组奇偶要求的操作链
    return {
      member: true,
      paritySatisfied: false,
      reason: 'parity-infeasible',
      factorWord: repFactorWord,
      repFactorWord,
      layers,
      ...parityInfo,
      chainSummary: summarizeChain(levels, n),
    };
  }

  // 回构补偶恒等词 correction：Σ c[k]·basis[k] = diff，对应恒等词依次拼接
  const correctionWord = [];
  const usedRelations = [];
  for (let k = 0; k < coeffs.length; k++) {
    if (!coeffs[k]) continue;
    usedRelations.push({ index: k, vector: space.basis[k].slice() });
    for (const tok of space.basisWords[k]) correctionWord.push(tok);
  }

  // 独立校验一：补偶词乘回必须恰为恒等
  if (!isIdentity(multiplyWord(correctionWord, generators, n))) {
    return {
      member: false,
      reason: 'verify-mismatch',
      blockedLayer: -1,
      evidence: { level: -1, base: -1, attemptedImage: -1, orbit: [], residual: null },
      ...parityInfo,
      chainSummary: summarizeChain(levels, n),
    };
  }

  const factorWord = concatWord(repFactorWord, correctionWord);

  // 独立校验二：完整因子链乘回必须等于目标，且奇偶向量必须等于整组要求
  const finalPerm = multiplyWord(factorWord, generators, n);
  const finalParity = wordParityVector(factorWord, m);
  if (!equalPerm(finalPerm, target) || finalParity.some((b, k) => b !== desiredParity[k])) {
    return {
      member: false,
      reason: 'verify-mismatch',
      blockedLayer: -1,
      evidence: { level: -1, base: -1, attemptedImage: -1, orbit: [], residual: finalPerm },
      ...parityInfo,
      chainSummary: summarizeChain(levels, n),
    };
  }

  return {
    member: true,
    paritySatisfied: true,
    reason: 'derivable',
    factorWord,
    repFactorWord,
    correctionWord,
    usedRelations,
    finalParity,
    layers,
    ...parityInfo,
    chainSummary: summarizeChain(levels, n),
  };
}

function summarizeChain(levels, n) {
  return levels.map((L, i) => ({
    level: i,
    base: i,
    orbitSize: orbitPoints(L, n).length,
    strongGeneratorCount: L.S.length,
  }));
}

// 把因子词展开为可逐步回放的操作步骤，并给出每步后的端口排列、
// 逐操作累计出现次数与奇偶位（供整组奇偶要求逐操作核对）。
function expandFactorChain(names, operations, factorWord) {
  const n = names.length;
  const m = operations.length;
  const generators = operations.map((o) => o.perm);
  const state = identity(n);
  const counts = new Array(m).fill(0);
  const steps = [
    {
      index: 0,
      operation: null,
      operationIndex: -1,
      inverse: false,
      perm: state.slice(),
      counts: counts.slice(),
      parity: counts.map((c) => c & 1),
    },
  ];
  factorWord.forEach((tok, idx) => {
    const k = Math.abs(tok) - 1;
    const inverse = tok < 0;
    const g = inverse ? invert(generators[k], n) : generators[k];
    const next = compose(state, g, n);
    for (let i = 0; i < n; i++) state[i] = next[i];
    counts[k] += 1; // 逆操作仍计为该操作出现一次
    steps.push({
      index: idx + 1,
      operation: operations[k].name,
      operationIndex: k,
      inverse,
      perm: state.slice(),
      counts: counts.slice(),
      parity: counts.map((c) => c & 1),
    });
  });
  return steps;
}

// 供 UI 渲染：把内部置换转成 端口名 -> 端口名
function permToNames(perm, names) {
  return perm.map((v, i) => ({ from: names[i], to: v >= 0 ? names[v] : null }));
}

// 完整审计：校验 + 成员判定（含奇偶复核）。输入不合法时返回全部错误。
function audit(input) {
  const v = validateInput(input);
  if (!v.ok) return { ok: false, errors: v.errors };
  const result = membership(v.names, v.operations, v.target, v.parity);
  if (result.member) {
    result.steps = expandFactorChain(v.names, v.operations, result.factorWord);
  }
  result.ok = true;
  result.mode = v.mode;
  result.names = v.names;
  result.operationNames = v.operations.map((o) => o.name);
  if (v.mode === 'parity') {
    // 奇偶复核：逐操作标注目标奇偶，供 UI 逐操作核对
    result.desiredParity = v.parity.slice();
    if (Array.isArray(result.basis)) {
      result.basisRelations = result.basis.map((vec, i) => ({
        index: i,
        vector: vec.slice(),
        entries: v.operations.map((o, k) => ({
          operation: o.name,
          bit: vec[k],
        })),
      }));
    }
    if (Array.isArray(result.repParity)) {
      result.repParityEntries = v.operations.map((o, k) => ({
        operation: o.name,
        bit: result.repParity[k],
        desired: v.parity[k],
        diff: result.parityDiff[k],
      }));
    }
  }
  if (result.evidence) {
    result.evidence.baseName = names_v(v, result.evidence.base);
    result.evidence.attemptedImageName = names_v(v, result.evidence.attemptedImage);
    result.evidence.orbitNames = result.evidence.orbit.map((x) => v.names[x]);
    if (result.evidence.residual) {
      result.evidence.residualMapping = permToNames(result.evidence.residual, v.names);
    }
  }
  return result;
}

function names_v(v, idx) {
  return idx >= 0 && idx < v.names.length ? v.names[idx] : null;
}

// 旧 Worker 回包防护：仅当回包代次与当前请求代次一致时结果才有效
function acceptIfCurrent(currentId, messageId, payload) {
  return currentId === messageId ? { accepted: true, payload } : { accepted: false };
}

// ---------------- 跨环境导出 ----------------

const api = {
  identity,
  isPermutation,
  compose,
  invert,
  equalPerm,
  isIdentity,
  parsePortList,
  parsePermText,
  validateInput,
  buildChain,
  sift,
  membership,
  expandFactorChain,
  permToNames,
  multiplyWord,
  wordParityVector,
  buildParitySpace,
  solveParity,
  audit,
  acceptIfCurrent,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof self !== 'undefined') {
  self.ApertureCore = api;
}

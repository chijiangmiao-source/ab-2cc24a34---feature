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
 * 全量校验：端口、操作（具名置换）、目标。
 * 所有错误一次性返回（重复操作名、缺失端口、非双射映射、非法目标等），
 * 调用方据此立即撤销旧结论。
 */
function validateInput(input) {
  const errors = [];
  const { names, errors: portErrors } = parsePortList(input.ports || '');
  for (const e of portErrors) errors.push({ scope: 'ports', message: e });

  // 审计模式：'normal' 普通可导出性；'parity' 整组奇偶复核
  const mode = input.mode === 'parity' ? 'parity' : 'normal';

  const operations = Array.isArray(input.operations) ? input.operations : [];
  if (operations.length === 0) {
    errors.push({ scope: 'operations', message: '至少需要 1 个具名置换操作' });
  }
  if (operations.length > 8) {
    errors.push({ scope: 'operations', message: '具名置换操作数量超限：最多 8 个' });
  }

  // 奇偶要求与操作录入行一一对应：1 = 奇数次，0 = 偶数次；null = 未指定
  const parityRows = Array.isArray(input.parity) ? input.parity : [];
  const parityReq = new Array(operations.length).fill(null);

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

    // 仅奇偶复核模式下收集偶/奇选择；普通模式一律忽略
    if (mode === 'parity') {
      const raw = parityRows[idx] == null ? null : String(parityRows[idx]).trim().toLowerCase();
      if (raw === '1' || raw === 'odd' || raw === '奇' || raw === '奇数次') {
        parityReq[idx] = 1;
      } else if (raw === '0' || raw === 'even' || raw === '偶' || raw === '偶数次') {
        parityReq[idx] = 0;
      } else {
        errors.push({
          scope: 'parity',
          index: idx,
          message: (opName ? '操作“' + opName + '”：' : label + '：') + '奇偶要求无效（须为“偶数次”或“奇数次”）',
        });
      }
    }

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

  if (errors.length) return { ok: false, errors, names: [], operations: [], target: null, mode };

  // 生成元按操作名排序，保证构造过程完全确定（端口标识亦已排序）
  const order = ops.map((_, i) => i).sort((a, b) =>
    ops[a].name < ops[b].name ? -1 : ops[a].name > ops[b].name ? 1 : a - b
  );
  const sortedOps = order.map((i) => ops[i]);
  // 奇偶要求随操作一同按排序后的生成元顺序重排，保证生成元编号一致
  const sortedParity = mode === 'parity' ? order.map((i) => parityReq[i]) : [];
  return {
    ok: true,
    errors: [],
    names,
    operations: sortedOps,
    parity: sortedParity,
    mode,
    target,
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
  const r = siftWithWord(levels, n, p, word, startLevel);
  return isIdentity(r.perm) ? null : r;
}

// 与 sift 相同，但即使剥离到恒等也返回累计词——
// 恒等词 w（multiplyWord(w)=id）正是奇偶空间所需的恒等关系样本。
function siftWithWord(levels, n, p, word, startLevel) {
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
  return { perm: cur, word: curWord, level: n };
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

// ---------------- 成员判定与因子链 / 不可归约证据 ----------------

function orbitPoints(level, n) {
  const pts = [];
  for (let x = 0; x < n; x++) {
    if (level.beta[x] != null) pts.push(x);
  }
  return pts;
}

function membership(names, operations, target) {
  const n = names.length;
  const generators = operations.map((o) => o.perm);
  const genWords = generators.map((_, i) => [i + 1]);
  const levels = buildChain(n, generators, genWords);

  const reduced = reduceTarget(levels, n, target);
  if (reduced.blocked) return reduced.blocked;

  // 独立复算：把横截代表拼出的因子词逐操作乘回，必须恰好等于目标
  const rebuilt = multiplyWord(reduced.factorWord, generators, n);
  if (!equalPerm(rebuilt, target)) {
    return {
      member: false,
      reason: 'verify-mismatch',
      blockedLayer: -1,
      evidence: { level: -1, base: -1, attemptedImage: -1, orbit: [], residual: rebuilt },
      chainSummary: summarizeChain(levels, n),
    };
  }

  return {
    member: true,
    reason: 'derivable',
    factorWord: reduced.factorWord,
    layers: reduced.layers,
    chainSummary: summarizeChain(levels, n),
  };
}

// 目标逐层剥离：要么返回首个阻塞层证据，要么返回目标的横截代表因子词
// target = t_{n-1}·…·t_0，可执行因子链按层序反转后拼接
function reduceTarget(levels, n, target) {
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
        blocked: {
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
        },
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
  if (!isIdentity(cur)) {
    // 完备链下不会到达这里；作为防御性结论返回
    return {
      blocked: {
        member: false,
        reason: 'residual',
        blockedLayer: n - 1,
        evidence: { level: n - 1, base: n - 1, attemptedImage: -1, orbit: [], residual: cur.slice() },
        chainSummary: summarizeChain(levels, n),
      },
    };
  }
  const factorWord = [];
  for (let i = n - 1; i >= 0; i--) {
    for (const tok of layerWords[i]) factorWord.push(tok);
  }
  return { factorWord, layers, layerWords };
}

// ---------------- GF(2) 奇偶空间：恒等关系构造、求解与链路回构 ----------------

/*
 * 整组奇偶复核（不枚举群元素、不穷举操作串、不做有限深度搜索）：
 *
 * 设生成元（已按操作名排序）编号 1..m。每个因子词 w 对应一个 GF(2)^m 奇偶
 * 向量 p(w)：p_k = w 中第 k 个操作（含其逆元）出现次数 mod 2。
 * 令 K = { p(w) : multiplyWord(w) = id } 为所有“恒等词”奇偶向量构成的线性子空间。
 * 目标 t 已有横截代表词 w0（p(w0)=v），则“存在满足要求 r 的规程”当且仅当
 * 受限坐标上 v+r（GF(2) 减法即加法）落在 K 内：
 *     ∃ z∈K，使 z 与 v 之和在每个被要求的坐标上等于 r。
 *
 * K 的基不在群元素上枚举，而直接在既有确定性 Schreier–Sims 归约中构造：
 *   (A) 初始生成元词 [k] 经横截代表剥离至恒等，得到恒等词 a_k；
 *   (B) 链闭包完成后，每层 i 的每个轨道点 x 与每个强生成元 s 的 Schreier 词
 *       β(x)·s·β(s(x))⁻¹（固定基点 i）自第 i+1 层剥离至恒等，得到恒等词 b。
 * Schreier–Sims 表示定理保证：这些恒等词在自由群中的正规闭包恰为求值同态的核，
 * 故其奇偶向量张成整个 K；闭包终止时每个 Schreier 生成元都已剥离为恒等，
 * 无需枚举任何群元素或操作串。所有候选词在收录前均独立乘回验证确为恒等。
 */

// 因子词 -> GF(2)^m 奇偶向量（逆元与正元一样计为该操作出现一次）
function wordParityVector(word, m) {
  const v = new Uint8Array(m);
  for (const tok of word) v[Math.abs(tok) - 1] ^= 1;
  return v;
}

function factorCounts(word, m) {
  const c = new Array(m).fill(0);
  for (const tok of word) c[Math.abs(tok) - 1] += 1;
  return c;
}

// 收集恒等关系词（全部经 multiplyWord 独立验证为恒等才收录）
function buildIdentityRelations(levels, n, m, generators) {
  const relations = []; // [{word, parity:Uint8Array}]
  const seen = new Set();

  const offer = (word0) => {
    const word = reduceWordFreely(word0);
    if (!isIdentity(multiplyWord(word, generators, n))) return false; // 防御性校验
    const parity = wordParityVector(word, m);
    const key = Array.prototype.join.call(parity, '');
    if (seen.has(key)) return false;
    seen.add(key);
    relations.push({ word: word.slice(), parity });
    return true;
  };

  // (A) 初始生成元词自第 0 层剥离到恒等
  for (let k = 0; k < m; k++) {
    const r = siftWithWord(levels, n, generators[k], [k + 1], 0);
    if (isIdentity(r.perm)) offer(r.word);
  }

  // (B) 每层每轨道点每强生成元的 Schreier 词，自下一层剥离到恒等
  for (let i = 0; i < n; i++) {
    const L = levels[i];
    for (let x = 0; x < n; x++) {
      if (L.beta[x] == null) continue;
      for (let gi = 0; gi < L.S.length; gi++) {
        const y = L.S[gi][x];
        if (L.beta[y] == null) continue; // 闭包完成后不会发生
        const schWord = concatWord(
          concatWord(L.word[x], L.genWord[gi]),
          invertWord(L.word[y])
        );
        const r = siftWithWord(levels, n, multiplyWord(schWord, generators, n), schWord, i + 1);
        if (isIdentity(r.perm)) offer(r.word);
      }
    }
  }
  return relations;
}

/*
 * 把恒等关系奇偶向量做 GF(2) 高斯消元，得到按主元列升序的 RREF 独立基。
 * 每个基行同时保留其“关系词回构”：即若干恒等关系词的拼接（其奇偶为各词奇偶之和，
 * 其求值仍为恒等），供求解命中后回构规范因子链。
 */
function gf2RelationBasis(relations, m) {
  const basis = []; // [{pivot, row:Uint8Array, parts:[word,...]}]
  for (const rel of relations) {
    const v = rel.parity.slice();
    let parts = [rel.word];
    for (const b of basis) {
      if (v[b.pivot]) {
        for (let j = 0; j < m; j++) v[j] ^= b.row[j];
        parts = parts.concat(b.parts);
      }
    }
    let pivot = -1;
    for (let j = 0; j < m; j++) {
      if (v[j]) { pivot = j; break; }
    }
    if (pivot < 0) continue;
    // 维持 RREF：新主元列在既有行中至多只出现在新行
    for (const b of basis) {
      if (b.row[pivot]) {
        for (let j = 0; j < m; j++) b.row[j] ^= v[j];
        b.parts = b.parts.concat(parts);
      }
    }
    basis.push({ pivot, row: v, parts });
    basis.sort((a, b) => a.pivot - b.pivot);
  }
  return basis;
}

function concatWords(words) {
  let out = [];
  for (const w of words) out = concatWord(out, w);
  return out;
}

// 自由词约简：消去相邻互逆因子（…k,-k…）。
// 不改变词的求值；每对消去恰好含同一操作两次，也不改变 GF(2) 奇偶向量。
function reduceWordFreely(word) {
  const stack = [];
  for (const tok of word) {
    if (stack.length && stack[stack.length - 1] === -tok) stack.pop();
    else stack.push(tok);
  }
  return stack;
}

/*
 * 在受限坐标集 constrained 上求解：找基行系数 x，使 Σ x_j·row_j 在受限坐标上
 * 等于目标向量 desired。系数矩阵行=受限坐标、列=基变量，GF(2) 高斯消元判相容。
 * 返回 { feasible, coefficients, vector }（vector 为选中基行奇偶向量之和，全长 m）。
 */
function gf2SolveConstrained(basis, m, constrained, desired) {
  const cols = basis.length;
  // 系数矩阵（每行一个 Uint8Array 长度 cols+1，末位为右端项）
  const sys = constrained.map((coord) => {
    const row = new Uint8Array(cols + 1);
    for (let j = 0; j < cols; j++) row[j] = basis[j].row[coord];
    row[cols] = desired[coord];
    return { coord, row };
  });
  const pivotRow = new Map(); // 主元列 -> 行
  let ri = 0;
  for (let cj = 0; cj < cols; cj++) {
    let pr = -1;
    for (let r = ri; r < sys.length; r++) {
      if (sys[r].row[cj]) { pr = r; break; }
    }
    if (pr < 0) continue;
    const tmp = sys[ri];
    sys[ri] = sys[pr];
    sys[pr] = tmp;
    for (let r = 0; r < sys.length; r++) {
      if (r !== ri && sys[r].row[cj]) {
        for (let j = cj; j <= cols; j++) sys[r].row[j] ^= sys[ri].row[j];
      }
    }
    pivotRow.set(cj, ri);
    ri++;
  }
  // 相容性：无主元行的右端项必须全为 0
  for (let r = ri; r < sys.length; r++) {
    if (sys[r].row[cols]) return { feasible: false };
  }
  const coefficients = new Uint8Array(cols); // 自由变量取 0
  for (const [cj, r] of pivotRow) coefficients[cj] = sys[r].row[cols];
  const vector = new Uint8Array(m);
  for (let j = 0; j < cols; j++) {
    if (coefficients[j]) {
      for (let k = 0; k < m; k++) vector[k] ^= basis[j].row[k];
    }
  }
  return { feasible: true, coefficients, vector };
}

/*
 * 整组奇偶复核主入口。
 * required 为长度 m 的数组：0=偶数次，1=奇数次（validateInput 已保证全部指定）。
 * 目标不可导出时返回与普通模式完全一致的首个阻塞层结论。
 */
function parityMembership(names, operations, target, required) {
  const n = names.length;
  const m = operations.length;
  const generators = operations.map((o) => o.perm);
  const genWords = generators.map((_, i) => [i + 1]);
  const levels = buildChain(n, generators, genWords);

  const reduced = reduceTarget(levels, n, target);
  if (reduced.blocked) {
    reduced.blocked.mode = 'parity';
    return reduced.blocked;
  }

  const repWord = reduced.factorWord;
  const repParity = wordParityVector(repWord, m);

  // 独立复算代表词
  if (!equalPerm(multiplyWord(repWord, generators, n), target)) {
    return {
      member: false,
      mode: 'parity',
      reason: 'verify-mismatch',
      blockedLayer: -1,
      evidence: { level: -1, base: -1, attemptedImage: -1, orbit: [], residual: null },
      chainSummary: summarizeChain(levels, n),
    };
  }

  const relations = buildIdentityRelations(levels, n, m, generators);
  const basis = gf2RelationBasis(relations, m);

  const constrained = [];
  const desired = new Uint8Array(m);
  for (let k = 0; k < m; k++) {
    if (required[k] === 0 || required[k] === 1) {
      constrained.push(k);
      desired[k] = required[k];
    }
  }
  // 需要恒等关系补偿的差额：d = v + r（GF(2)）
  const diff = new Array(m).fill(null);
  for (const k of constrained) diff[k] = repParity[k] ^ desired[k];
  const diffVec = new Uint8Array(m);
  for (const k of constrained) diffVec[k] = diff[k];

  const solved = gf2SolveConstrained(basis, m, constrained, diffVec);

  const basisReport = basis.map((b) => ({
    pivot: b.pivot,
    parity: Array.from(b.row),
    word: reduceWordFreely(concatWords(b.parts)),
  }));

  const baseResult = {
    member: true,
    mode: 'parity',
    factorWord: repWord, // 目标代表（不可满足时仍展示代表链）
    layers: reduced.layers,
    chainSummary: summarizeChain(levels, n),
    representativeWord: repWord.slice(),
    representativeParity: Array.from(repParity),
    representativeCounts: factorCounts(repWord, m),
    requiredParity: required.map((v) => (v === 0 || v === 1 ? v : null)),
    parityDiff: diff,
    relationBasis: basisReport.map((b) => ({ pivot: b.pivot, parity: b.parity, word: b.word })),
    relationCount: relations.length,
  };

  if (!solved.feasible) {
    return Object.assign(baseResult, {
      reason: 'parity-infeasible',
      paritySatisfied: false,
    });
  }

  // 回构规范恒等修正词：选中的独立基关系词按主元序拼接
  const correctionParts = [];
  for (let j = 0; j < basis.length; j++) {
    if (solved.coefficients[j]) correctionParts.push(...basis[j].parts);
  }
  const correctionWord = reduceWordFreely(concatWords(correctionParts));
  // 规范因子链 = 目标代表词 · 恒等修正词（求值仍为目标，奇偶被修正到要求）
  const canonicalWord = reduceWordFreely(concatWord(repWord, correctionWord));

  // 独立终校：乘积必须仍是目标；逐操作计数模 2 必须满足全部要求
  const rebuilt = multiplyWord(canonicalWord, generators, n);
  const counts = factorCounts(canonicalWord, m);
  let productOk = equalPerm(rebuilt, target);
  let parityOk = true;
  for (const k of constrained) {
    if ((counts[k] & 1) !== required[k]) parityOk = false;
  }
  if (!productOk || !parityOk) {
    return Object.assign(baseResult, {
      reason: 'parity-verify-mismatch',
      paritySatisfied: false,
    });
  }

  return Object.assign(baseResult, {
    reason: 'parity-derivable',
    paritySatisfied: true,
    factorWord: canonicalWord,
    correctionWord,
    correctionParity: Array.from(solved.vector),
    parityCounts: counts,
    parityVerified: true,
  });
}


function summarizeChain(levels, n) {
  return levels.map((L, i) => ({
    level: i,
    base: i,
    orbitSize: orbitPoints(L, n).length,
    strongGeneratorCount: L.S.length,
  }));
}

// 把因子词展开为可逐步回放的操作步骤，并给出每步后的端口排列。
// 奇偶复核模式下每步还携带逐操作累计计数（含逆元执行），供逐操作计数核对。
function expandFactorChain(names, operations, factorWord, withCounts) {
  const n = names.length;
  const m = operations.length;
  const generators = operations.map((o) => o.perm);
  const state = identity(n);
  const counts = new Array(m).fill(0);
  const steps = [
    {
      index: 0,
      operation: null,
      operationIndex: null,
      inverse: false,
      perm: state.slice(),
      counts: withCounts ? counts.slice() : undefined,
    },
  ];
  factorWord.forEach((tok, idx) => {
    const k = Math.abs(tok) - 1;
    const inverse = tok < 0;
    const g = inverse ? invert(generators[k], n) : generators[k];
    const next = compose(state, g, n);
    for (let i = 0; i < n; i++) state[i] = next[i];
    counts[k] += 1;
    steps.push({
      index: idx + 1,
      operation: operations[k].name,
      operationIndex: k,
      inverse,
      perm: state.slice(),
      counts: withCounts ? counts.slice() : undefined,
    });
  });
  return steps;
}

// 供 UI 渲染：把内部置换转成 端口名 -> 端口名
function permToNames(perm, names) {
  return perm.map((v, i) => ({ from: names[i], to: v >= 0 ? names[v] : null }));
}

// 完整审计：校验 + 成员判定。输入不合法时返回全部错误。
function audit(input) {
  const v = validateInput(input);
  if (!v.ok) return { ok: false, errors: v.errors };

  const result =
    v.mode === 'parity'
      ? parityMembership(v.names, v.operations, v.target, v.parity)
      : membership(v.names, v.operations, v.target);

  // 可回放的因子链：普通模式的成员链；奇偶模式的目标代表链或规范因子链
  if (result.member) {
    result.steps = expandFactorChain(
      v.names,
      v.operations,
      result.factorWord,
      v.mode === 'parity'
    );
  }
  result.names = v.names;
  result.operationNames = v.operations.map((o) => o.name);
  result.mode = v.mode;
  result.ok = true;
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
  parityMembership,
  buildIdentityRelations,
  gf2RelationBasis,
  gf2SolveConstrained,
  wordParityVector,
  factorCounts,
  expandFactorChain,
  permToNames,
  multiplyWord,
  audit,
  acceptIfCurrent,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof self !== 'undefined') {
  self.ApertureCore = api;
}

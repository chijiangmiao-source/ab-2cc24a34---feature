'use strict';
/*
 * app.js —— 审计页面逻辑。
 * 两种模式：
 *   normal 普通可导出性审计（结论与回放与既有版本一致）；
 *   parity 整组奇偶复核：为每个操作指定偶/奇次数，目标可导出时再判相容性，
 *           相容则返回可逐步回放、逐操作计数可核对的规范因子链。
 * 关键点：用户在计算未结束时改写端口、操作、目标或奇偶选择（含切换模式），
 * 旧 Worker 回包不得覆盖新输入/新结论。
 * 实现：每次提交递增 requestId（代次）；回包仅在 id 匹配当前代次时应用；
 *       任何输入变更立即撤销旧结论。
 */
(function () {
  const $ = (id) => document.getElementById(id);

  let worker = null;
  let currentRequestId = 0;
  let latestResult = null;
  let replay = null;

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function currentMode() {
    const checked = document.querySelector('input[name="mode"]:checked');
    return checked ? checked.value : 'normal';
  }

  function applyMode() {
    const mode = currentMode();
    document.body.dataset.mode = mode;
    $('parity-panel').classList.toggle('hidden', mode !== 'parity');
    $('mode-hint').textContent =
      mode === 'parity'
        ? '奇偶复核：先判目标可否导出；可导出时再在恒等关系的 GF(2) 奇偶空间中求解，' +
          '返回满足每个操作偶/奇次数要求、可逐步回放且逐操作计数可核对的规范因子链。'
        : '普通模式：判定目标接线能否由允许的换位操作导出，并给出可逐步回放的操作因子链。';
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker('worker.js');
    worker.onmessage = (ev) => {
      const msg = ev.data || {};
      if (currentRequestId !== msg.requestId) {
        // 旧 Worker 回包：明确丢弃，不得触碰当前输入与结论
        console.info('丢弃过期审计回包 #' + msg.requestId + '（当前 #' + currentRequestId + '）');
        return;
      }
      latestResult = msg.result;
      renderResult(msg.result);
      setComputing(false);
    };
    worker.onerror = (e) => {
      renderError('Worker 错误：' + (e.message || '未知错误'));
      setComputing(false);
    };
    return worker;
  }

  function collectInput() {
    const rows = Array.from(document.querySelectorAll('.op-row'));
    const operations = rows.map((row) => ({
      name: row.querySelector('.op-name').value,
      mapping: row.querySelector('.op-mapping').value,
    }));
    const mode = currentMode();
    const input = {
      ports: $('ports').value,
      operations,
      target: $('target').value,
      mode,
    };
    if (mode === 'parity') {
      input.parity = rows.map((row) => row.querySelector('.op-parity').value);
    }
    return input;
  }

  function setComputing(on) {
    $('btn-audit').disabled = on;
    $('status-line').className = on ? 'status computing' : 'status';
    $('status-line').textContent = on
      ? currentMode() === 'parity'
        ? 'Schreier–Sims 链构造、成员剥离与 GF(2) 奇偶空间求解中…'
        : 'Schreier–Sims 链构造与成员剥离中…'
      : '';
  }

  // 输入一旦变更（端口/操作/目标/奇偶选择/模式），立即撤销旧结论
  function invalidate() {
    currentRequestId += 1; // 使任何在途旧回包失效
    latestResult = null;
    replay = null;
    $('result').innerHTML =
      '<p class="muted">规程已变更，旧结论已撤销。请重新发起审计。</p>';
    $('replay').classList.add('hidden');
  }

  function renderError(message) {
    latestResult = null;
    $('result').innerHTML =
      '<div class="error-box"><strong>无法发起审计：</strong>' + esc(message) + '</div>';
    $('replay').classList.add('hidden');
  }

  function renderChainTable(result) {
    let html =
      '<details class="chain-details"><summary>稳定子链诊断' +
      '（按端口标识排序的确定性 Schreier–Sims 链）</summary>';
    html +=
      '<table class="chain-table"><thead><tr><th>端口层</th><th>基点端口</th>' +
      '<th>轨道大小</th><th>强生成元数</th></tr></thead><tbody>';
    for (const row of result.chainSummary) {
      html +=
        '<tr><td>' + (row.level + 1) + '</td><td>' +
        esc(result.names[row.base]) + '</td><td>' + row.orbitSize +
        '</td><td>' + row.strongGeneratorCount + '</td></tr>';
    }
    html += '</tbody></table></details>';
    return html;
  }

  function factorBadges(result, word) {
    if (!word || !word.length) return '<span class="muted">（空词 = 恒等）</span>';
    return word
      .map((tok) => {
        const k = Math.abs(tok) - 1;
        const inv = tok < 0;
        return (
          '<span class="factor' + (inv ? ' inv' : '') + '">' +
          esc(result.operationNames[k]) + (inv ? '⁻¹' : '') + '</span>'
        );
      })
      .join('<span class="dot">·</span>');
  }

  function parityChip(v) {
    if (v === 0) return '<span class="chip even">偶 0</span>';
    if (v === 1) return '<span class="chip odd">奇 1</span>';
    return '<span class="muted">—</span>';
  }

  // 奇偶复核：要求 / 代表奇偶 / 规范链计数 对照表
  function renderParityCountTable(result, counts) {
    let html =
      '<table class="parity-table"><thead><tr><th>操作</th><th>要求奇偶</th>' +
      '<th>代表链奇偶</th><th>规范链执行次数</th><th>规范链奇偶</th><th>核对</th></tr></thead><tbody>';
    for (let k = 0; k < result.operationNames.length; k++) {
      const req = result.requiredParity[k];
      const rep = result.representativeParity[k];
      const cnt = counts ? counts[k] : null;
      const cntParity = cnt == null ? null : cnt & 1;
      const ok = cnt != null && cntParity === req;
      html +=
        '<tr><td class="opname">' + esc(result.operationNames[k]) + '</td>' +
        '<td>' + parityChip(req) + '</td>' +
        '<td>' + parityChip(rep) + '</td>' +
        '<td>' + (cnt == null ? '—' : cnt) + '</td>' +
        '<td>' + parityChip(cntParity) + '</td>' +
        '<td>' + (ok ? '<span class="okmark">✓</span>' : '<span class="badmark">✗</span>') + '</td></tr>';
    }
    html += '</tbody></table>';
    return html;
  }

  // 不可满足：代表奇偶向量、所需差额、独立恒等关系基
  function renderParityInfeasible(result) {
    let html =
      '<div class="verdict reject">✗ 目标可导出，但整组奇偶要求不可满足</div>';
    html +=
      '<p>不存在任何实现目标且同时满足全部偶/奇次数要求的操作规程' +
      '（该结论由恒等关系 GF(2) 奇偶空间线性相容性给出，非枚举或有限深度搜索）。</p>';

    html += '<table class="parity-table"><thead><tr><th>操作</th><th>要求 r</th>' +
      '<th>目标代表奇偶 v</th><th>所需差额 v⊕r</th></tr></thead><tbody>';
    for (let k = 0; k < result.operationNames.length; k++) {
      html +=
        '<tr><td class="opname">' + esc(result.operationNames[k]) + '</td>' +
        '<td>' + parityChip(result.requiredParity[k]) + '</td>' +
        '<td>' + parityChip(result.representativeParity[k]) + '</td>' +
        '<td>' + parityChip(result.parityDiff[k]) + '</td></tr>';
    }
    html += '</tbody></table>';

    html +=
      '<p class="hint">差额向量不在恒等关系奇偶子空间内（其受限坐标无法由下列独立关系基线性表出）。</p>';

    const basis = result.relationBasis || [];
    html +=
      '<details class="chain-details" open><summary>恒等关系 GF(2) 独立基（' +
      basis.length + ' 个；共收集恒等关系 ' + (result.relationCount || 0) + ' 个）</summary>';
    if (!basis.length) {
      html += '<p class="muted">关系空间为平凡子空间 {0}：唯一的恒等词是空词，无法补偿任何差额。</p>';
    } else {
      html += '<table class="basis-table"><thead><tr><th>#</th><th>关系奇偶向量</th><th>恒等关系词（求值为恒等）</th></tr></thead><tbody>';
      basis.forEach((b, i) => {
        const vec = b.parity
          .map((v, k) => '<span class="vecbit ' + (v ? 'one' : 'zero') + '">' + v + '</span>')
          .join('');
        html +=
          '<tr><td>' + (i + 1) + '</td><td class="vec">' + vec + '</td>' +
          '<td class="wordcell"><div class="factor-chain small">' +
          factorBadges(result, b.word) + '</div></td></tr>';
      });
      html += '</tbody></table>';
    }
    html += '</details>';

    html +=
      '<details class="chain-details"><summary>目标代表因子链（其奇偶向量为上表 v）</summary>' +
      '<div class="factor-chain small">' + factorBadges(result, result.representativeWord) +
      '</div></details>';

    html += renderChainTable(result);
    return html;
  }

  function renderResult(result) {
    const host = $('result');
    if (!result.ok) {
      let html =
        '<div class="error-box"><div class="verdict reject">结论已撤销 · 输入不合法</div>';
      html += '<ul class="error-list">';
      for (const e of result.errors) {
        html += '<li><span class="scope">[' + esc(e.scope) + ']</span> ' + esc(e.message) + '</li>';
      }
      html += '</ul></div>';
      host.innerHTML = html;
      $('replay').classList.add('hidden');
      return;
    }

    if (result.mode === 'parity' && result.member && result.reason === 'parity-infeasible') {
      host.innerHTML = renderParityInfeasible(result);
      $('replay').classList.add('hidden');
      return;
    }

    if (result.member) {
      if (result.mode === 'parity') {
        let html =
          '<div class="verdict pass">✓ 目标可导出且满足整组奇偶要求</div>';
        html +=
          '<p>下列<span class="b">规范因子链</span>实现目标接线，且每个操作的执行次数' +
          '（逆元执行同样计入）模 2 恰好满足指定偶/奇要求；' +
          '链由目标代表词与恒等关系奇偶空间解回构而成，并已逐操作乘回与逐操作计数终校：</p>';
        html += '<div class="factor-chain">' + factorBadges(result, result.factorWord) + '</div>';
        if (result.correctionWord && result.correctionWord.length) {
          html +=
            '<details class="chain-details"><summary>恒等修正词（求值为恒等，仅用于补偿奇偶）</summary>' +
            '<div class="factor-chain small">' + factorBadges(result, result.correctionWord) +
            '</div></details>';
        }
        html += renderParityCountTable(result, result.parityCounts);
        html += renderChainTable(result);
        host.innerHTML = html;
      } else {
        let html = '<div class="verdict pass">✓ 可导出（目标属于生成元组生成的置换群）</div>';
        html +=
          '<p>目标可由下列<span class="b">操作因子链</span>实现' +
          '（横截代表逐层复算，因子词已逐操作乘回校验）：</p>';
        html += '<div class="factor-chain">' + factorBadges(result, result.factorWord) + '</div>';
        html += renderChainTable(result);
        host.innerHTML = html;
      }
      setupReplay(result);
    } else {
      const ev = result.evidence || {};
      let html = '<div class="verdict reject">✗ 不可导出</div>';
      if (typeof ev.level !== 'number' || ev.level < 0) {
        html += '<p>内部复算失败：因子词乘回结果与目标不一致（防御性结论）。</p>';
        host.innerHTML = html + renderChainTable(result);
        $('replay').classList.add('hidden');
        return;
      }
      html +=
        '<p>在第 <span class="b">' + (ev.level + 1) +
        '</span> 个端口层（基点端口 <span class="b">' + esc(ev.baseName) +
        '</span>）无法继续归约：</p><ul class="evidence">';
      html +=
        '<li>该层稳定子作用下基点可达轨道（端口）：<span class="orbit">' +
        ev.orbitNames.map(esc).join('、') + '</span></li>';
      html +=
        '<li>当前残差中基点 <span class="b">' + esc(ev.baseName) +
        '</span> 的像为 <span class="b">' + esc(ev.attemptedImageName) +
        '</span>，不在上述轨道内 —— 横截代表无法消去该基点像，' +
        '故不存在能实现目标的任何操作串。</li>';
      html += '</ul>';
      html += renderChainTable(result);
      host.innerHTML = html;
      $('replay').classList.add('hidden');
    }
  }

  // ---------- 逐步回放 ----------

  function stopPlay() {
    if (replay && replay.timer) {
      clearTimeout(replay.timer);
      replay.timer = null;
    }
  }

  function setupReplay(result) {
    const panel = $('replay');
    panel.classList.remove('hidden');
    stopPlay();
    replay = {
      steps: result.steps,
      pos: 0,
      names: result.names,
      opNames: result.operationNames,
      mode: result.mode,
      required: result.requiredParity,
      timer: null,
    };
    renderReplay();

    $('btn-prev').onclick = () => {
      stopPlay();
      replay.pos = Math.max(0, replay.pos - 1);
      renderReplay();
    };
    $('btn-next').onclick = () => {
      stopPlay();
      replay.pos = Math.min(replay.steps.length - 1, replay.pos + 1);
      renderReplay();
    };
    $('btn-play').onclick = () => {
      if (replay.timer) {
        stopPlay();
        renderReplay();
        return;
      }
      const tick = () => {
        if (!replay) return;
        if (replay.pos >= replay.steps.length - 1) {
          stopPlay();
          renderReplay();
          return;
        }
        replay.pos += 1;
        replay.timer = setTimeout(tick, 850);
        renderReplay();
      };
      tick();
    };
    $('btn-reset').onclick = () => {
      stopPlay();
      replay.pos = 0;
      renderReplay();
    };
  }

  function renderReplay() {
    if (!replay) return;
    const { steps, pos, names } = replay;
    const step = steps[pos];
    let html = '<table class="port-table"><thead><tr><th></th>';
    for (const nm of names) html += '<th>' + esc(nm) + '</th>';
    html += '</tr></thead><tbody><tr>';
    html += '<td class="rowhead">当前接线</td>';
    for (let i = 0; i < names.length; i++) html += '<td>' + esc(names[step.perm[i]]) + '</td>';
    html += '</tr></tbody></table>';

    html += '<p class="muted">第 ' + pos + ' / ' + (steps.length - 1) + ' 步';
    if (pos > 0) {
      html +=
        '——刚执行：<span class="b">' + esc(steps[pos].operation) +
        (steps[pos].inverse ? '⁻¹' : '') + '</span>';
    } else {
      html += '（初始排列）';
    }
    html += '</p>';

    if (pos > 0) {
      const applied = [];
      for (let k = 1; k <= pos; k++) {
        applied.push(
          '<span class="factor' + (steps[k].inverse ? ' inv' : '') + '">' +
          esc(steps[k].operation) + (steps[k].inverse ? '⁻¹' : '') + '</span>'
        );
      }
      html += '<div class="factor-chain small">' + applied.join('<span class="dot">·</span>') + '</div>';
    }

    // 奇偶模式：逐操作计数可核对（截至当前步）
    if (replay.mode === 'parity' && step.counts) {
      html +=
        '<table class="parity-table replay-counts"><thead><tr><th>操作</th>' +
        '<th>截至本步执行次数</th><th>当前奇偶</th><th>要求</th><th>终态核对</th></tr></thead><tbody>';
      for (let k = 0; k < replay.opNames.length; k++) {
        const c = step.counts[k];
        const req = replay.required ? replay.required[k] : null;
        const finalOk = pos === steps.length - 1 && (c & 1) === req;
        html +=
          '<tr><td class="opname">' + esc(replay.opNames[k]) + '</td>' +
          '<td>' + c + '</td><td>' + parityChip(c & 1) + '</td>' +
          '<td>' + parityChip(req) + '</td>' +
          '<td>' + (pos === steps.length - 1
            ? (finalOk ? '<span class="okmark">✓ 满足</span>' : '<span class="badmark">✗</span>')
            : '<span class="muted">…</span>') + '</td></tr>';
      }
      html += '</tbody></table>';
    }

    $('replay-view').innerHTML = html;
    $('btn-prev').disabled = pos <= 0;
    $('btn-next').disabled = pos >= steps.length - 1;
    $('btn-play').textContent = replay.timer ? '暂停' : '播放';
  }

  // ---------- 规程编辑行 ----------

  function addOpRow(name, mapping) {
    const wrap = $('ops');
    const row = document.createElement('div');
    row.className = 'op-row';
    row.innerHTML =
      '<input class="op-name" type="text" placeholder="操作名（如 swap_ab）" value="' +
      esc(name || '') + '" />' +
      '<input class="op-mapping" type="text" placeholder="(A B)(C D) 或 A-&gt;B, B-&gt;A" />' +
      '<select class="op-parity" title="本次规程中该操作出现次数的奇偶要求">' +
      '<option value="even">偶数次</option>' +
      '<option value="odd">奇数次</option>' +
      '</select>';
    row.querySelector('.op-mapping').value = mapping || '';
    wrap.appendChild(row);
    row.querySelector('.op-name').addEventListener('input', invalidate);
    row.querySelector('.op-mapping').addEventListener('input', invalidate);
    row.querySelector('.op-parity').addEventListener('change', invalidate);
  }

  function fillExample() {
    $('ports').value = 'A B C D';
    $('ops').innerHTML = '';
    addOpRow('flip_cd', '(C D)');
    addOpRow('rotate', '(A B C D)');
    addOpRow('swap_ab', '(A B)');
    $('target').value = '(A C)(B D)';
    invalidate();
  }

  $('btn-add-op').addEventListener('click', () => {
    if (document.querySelectorAll('.op-row').length >= 8) return;
    addOpRow('', '');
    invalidate();
  });
  $('btn-remove-op').addEventListener('click', () => {
    const rows = document.querySelectorAll('.op-row');
    if (rows.length > 1) {
      rows[rows.length - 1].remove();
      invalidate();
    }
  });
  $('btn-audit').addEventListener('click', () => {
    const input = collectInput();
    currentRequestId += 1; // 新代次：所有在途旧回包将被丢弃
    latestResult = null;
    setComputing(true);
    ensureWorker().postMessage({
      type: 'audit-request',
      requestId: currentRequestId,
      input,
    });
  });
  $('btn-example').addEventListener('click', fillExample);
  $('ports').addEventListener('input', invalidate);
  $('target').addEventListener('input', invalidate);
  document.querySelectorAll('input[name="mode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      applyMode();
      invalidate();
    });
  });

  applyMode();
  fillExample();
})();

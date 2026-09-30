'use strict';
/*
 * app.js —— 审计页面逻辑。
 * 关键点：用户在计算未结束时改写规程并再次提交，旧 Worker 回包不得覆盖新输入/新结论。
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
    const parity = rows.map((row) => row.querySelector('.op-parity').value);
    return {
      mode: currentMode(),
      ports: $('ports').value,
      operations,
      parity,
      target: $('target').value,
    };
  }

  function currentMode() {
    const checked = document.querySelector('input[name="mode"]:checked');
    return checked && checked.value === 'parity' ? 'parity' : 'normal';
  }

  function applyMode() {
    const parity = currentMode() === 'parity';
    document.body.dataset.mode = parity ? 'parity' : 'normal';
    $('parity-hint').classList.toggle('hidden', !parity);
  }

  function setComputing(on) {
    $('btn-audit').disabled = on;
    $('status-line').className = on ? 'status computing' : 'status';
    $('status-line').textContent = on
      ? 'Schreier–Sims 链构造、成员剥离与 GF(2) 奇偶空间求解中…'
      : '';
  }

  // 输入一旦变更，立即撤销旧结论
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

  function factorBadges(result, word, options) {
    const opts = options || {};
    return word
      .map((tok, i) => {
        const k = Math.abs(tok) - 1;
        const inv = tok < 0;
        const cls = 'factor' + (inv ? ' inv' : '') + (opts.correction && i >= (opts.splitAt || 0) ? ' correction' : '');
        return (
          '<span class="' + cls + '">' +
          esc(result.operationNames[k]) + (inv ? '⁻¹' : '') + '</span>'
        );
      })
      .join('<span class="dot">·</span>');
  }

  function parityBitCell(bit) {
    return bit ? '<span class="parity-bit odd">奇</span>' : '<span class="parity-bit even">偶</span>';
  }

  // 奇偶诊断表：目标代表奇偶向量、整组要求、所需差额
  function parityVectorTable(result) {
    let html =
      '<table class="parity-table"><thead><tr><th>操作</th>' +
      '<th>目标代表词奇偶</th><th>整组要求</th><th>所需差额（GF(2)）</th></tr></thead><tbody>';
    result.repParityEntries.forEach((e) => {
      html +=
        '<tr><td>' + esc(e.operation) + '</td><td>' + parityBitCell(e.bit) +
        '</td><td>' + parityBitCell(e.desired) +
        '</td><td class="' + (e.diff ? 'diff-on' : '') + '">' +
        (e.diff ? '<span class="parity-bit odd">1</span>' : '<span class="parity-bit even">0</span>') +
        '</td></tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  // 独立恒等关系基
  function parityBasisTable(result) {
    if (!result.basisRelations || !result.basisRelations.length) {
      return '<p class="muted">恒等关系的奇偶空间为平凡空间（零维）：不存在任何可改变奇偶的恒等操作词。</p>';
    }
    let html =
      '<p class="muted">下列<span class="b">独立恒等关系基</span>张成可在不改变置换的前提下' +
      '调整的奇偶空间（GF(2) 高斯消元所得，主元操作严格递增）：</p>';
    html +=
      '<table class="parity-table"><thead><tr><th>关系基</th>';
    for (const e of result.basisRelations[0].entries) html += '<th>' + esc(e.operation) + '</th>';
    html += '</tr></thead><tbody>';
    result.basisRelations.forEach((rel) => {
      html += '<tr><td class="muted">r' + rel.index + '</td>';
      for (const e of rel.entries) {
        html += '<td>' + (e.bit ? '<span class="parity-bit odd">1</span>' : '<span class="muted">0</span>') + '</td>';
      }
      html += '</tr>';
    });
    html += '</tbody></table>';
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

    if (!result.member) {
      const ev = result.evidence;
      let html = '<div class="verdict reject">✗ 不可导出</div>';
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
      if (result.mode === 'parity') {
        html +=
          '<li>目标本身不可导出，奇偶复核不再进行：先消除该阻塞层，再判定整组奇偶要求。</li>';
      }
      html += '</ul>';
      html += renderChainTable(result);
      host.innerHTML = html;
      $('replay').classList.add('hidden');
      return;
    }

    if (result.mode === 'parity' && result.reason === 'parity-infeasible') {
      // 目标可导出，但仅奇偶要求不可满足
      let html =
        '<div class="verdict reject">✗ 奇偶要求不可满足（目标本身可导出）</div>';
      html +=
        '<p>目标置换存在代表操作因子链，但<span class="b">不存在</span>满足整组奇偶要求的' +
        '操作链：所需差额向量不在恒等关系的 GF(2) 奇偶空间内。</p>';
      html += '<h3>目标代表的奇偶向量与所需差额</h3>';
      html += parityVectorTable(result);
      html += '<h3>独立恒等关系基</h3>';
      html += parityBasisTable(result);
      html +=
        '<details class="chain-details"><summary>目标代表因子链（实现目标但不满足奇偶要求，仅供对照）</summary>';
      html += '<div class="factor-chain small">' + factorBadges(result, result.repFactorWord) + '</div></details>';
      html += renderChainTable(result);
      host.innerHTML = html;
      $('replay').classList.add('hidden');
      return;
    }

    // member：普通模式或奇偶满足
    let html;
    if (result.mode === 'parity') {
      html =
        '<div class="verdict pass">✓ 可导出且满足整组奇偶要求</div>';
      html +=
        '<p>下列<span class="b">规范因子链</span>实现目标且每个操作的出现次数奇偶与要求一致' +
        '（链 = 目标代表词 · GF(2) 奇偶空间解出的补偶恒等词；已逐操作乘回并复核奇偶）：</p>';
    } else {
      html = '<div class="verdict pass">✓ 可导出（目标属于生成元组生成的置换群）</div>';
      html +=
        '<p>目标可由下列<span class="b">操作因子链</span>实现' +
        '（横截代表逐层复算，因子词已逐操作乘回校验）：</p>';
    }
    html +=
      '<div class="factor-chain">' +
      factorBadges(result, result.factorWord, {
        correction: result.mode === 'parity',
        splitAt: result.mode === 'parity' ? result.repFactorWord.length : 0,
      }) +
      '</div>';
    if (result.mode === 'parity') {
      html +=
        '<p class="muted"><span class="factor legend-rep">普通底色</span>＝目标代表词；' +
        '<span class="factor correction">绿色描边</span>＝补偶恒等词（乘回为恒等，仅调整奇偶）。</p>';
      html += '<h3>奇偶复核</h3>' + parityVectorTable(result);
      if (result.usedRelations && result.usedRelations.length) {
        html +=
          '<details class="chain-details"><summary>补偶所用的独立关系（' +
          result.usedRelations.length + ' 条，GF(2) 组合）</summary>' +
          parityBasisTable(result) + '</details>';
      }
    }
    html += renderChainTable(result);
    host.innerHTML = html;
    setupReplay(result);
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
      operationNames: result.operationNames,
      desiredParity: result.mode === 'parity' ? result.desiredParity : null,
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
    const { steps, pos, names, operationNames, desiredParity } = replay;
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

    // 逐操作计数与奇偶核对（奇偶复核模式下与整组要求逐列对照）
    if (operationNames && operationNames.length) {
      html +=
        '<table class="count-table"><thead><tr><th>操作</th><th>累计次数</th>' +
        '<th>当前奇偶</th>' + (desiredParity ? '<th>要求</th><th>核对</th>' : '') +
        '</tr></thead><tbody>';
      operationNames.forEach((nm, k) => {
        const count = step.counts ? step.counts[k] : 0;
        const bit = step.parity ? step.parity[k] : 0;
        html +=
          '<tr><td>' + esc(nm) + '</td><td class="num">' + count +
          '</td><td>' + parityBitCell(bit) + '</td>';
        if (desiredParity) {
          const ok = bit === desiredParity[k];
          html +=
            '<td>' + parityBitCell(desiredParity[k]) + '</td>' +
            '<td class="' + (ok ? 'count-ok' : 'count-bad') + '">' +
            (ok ? '✓' : '≠') + '</td>';
        }
        html += '</tr>';
      });
      html += '</tbody></table>';
      if (desiredParity) {
        html +=
          '<p class="muted">末步到达时所有操作奇偶须与要求一致（补偶恒等词执行期间' +
          '接线最终保持不变，仅调整奇偶）。</p>';
      }
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
      '<select class="op-parity" title="本次规程中该操作的出现次数奇偶">' +
      '<option value="">奇偶…</option>' +
      '<option value="odd">奇数次</option>' +
      '<option value="even">偶数次</option>' +
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
      invalidate(); // 模式切换立即撤销旧结论并使在途回包失效
    });
  });

  applyMode();
  fillExample();
})();

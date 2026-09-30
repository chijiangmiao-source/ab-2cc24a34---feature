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
    return {
      ports: $('ports').value,
      operations,
      target: $('target').value,
    };
  }

  function setComputing(on) {
    $('btn-audit').disabled = on;
    $('status-line').className = on ? 'status computing' : 'status';
    $('status-line').textContent = on ? 'Schreier–Sims 链构造与成员剥离中…' : '';
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

  function factorBadges(result, word) {
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

    if (result.member) {
      let html = '<div class="verdict pass">✓ 可导出（目标属于生成元组生成的置换群）</div>';
      html +=
        '<p>目标可由下列<span class="b">操作因子链</span>实现' +
        '（横截代表逐层复算，因子词已逐操作乘回校验）：</p>';
      html += '<div class="factor-chain">' + factorBadges(result, result.factorWord) + '</div>';
      html += renderChainTable(result);
      host.innerHTML = html;
      setupReplay(result);
    } else {
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
    replay = { steps: result.steps, pos: 0, names: result.names, timer: null };
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
      '<input class="op-mapping" type="text" placeholder="(A B)(C D) 或 A-&gt;B, B-&gt;A" />';
    row.querySelector('.op-mapping').value = mapping || '';
    wrap.appendChild(row);
    row.querySelector('.op-name').addEventListener('input', invalidate);
    row.querySelector('.op-mapping').addEventListener('input', invalidate);
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

  fillExample();
})();

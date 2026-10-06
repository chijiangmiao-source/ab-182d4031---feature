/*
 * 主线程：导入/草稿/回放控制/渲染。
 * 计算全部委托给 Web Worker；runToken 保证用户取消或重新导入后，
 * 旧 Worker 的结果不会覆盖新内容。
 */
(function () {
  'use strict';

  var DRAFT_KEY = 'dirreplay.draft.v1';
  var PLAY_INTERVAL_MS = 650;

  var $ = function (s) { return document.querySelector(s); };

  var worker = null;
  var runToken = 0;
  var steps = null;
  var eventsTotal = 0;
  var idx = 0;
  var timer = null;
  var cmpA = null; // 对照起点 { step, line }
  var cmpB = null; // 对照终点 { step, line }

  // ---------- 示例轨迹 ----------

  var SAMPLES = {
    legal: {
      cores: 3,
      lines: 1,
      events: [
        { type: 'read_miss', core: 0, line: 0 },
        { type: 'deliver', msg: 1 },
        { type: 'read_miss', core: 1, line: 0 },
        { type: 'deliver', msg: 2 },
        { type: 'read_miss', core: 2, line: 0 },
        { type: 'deliver', msg: 3 },
        { type: 'write_upgrade', core: 1, line: 0, data: 7 },
        { type: 'timeout', msg: 4 },
        { type: 'deliver', msg: 4 },
        { type: 'deliver', msg: 6 },
        { type: 'ack', core: 0, line: 0, gen: 1 },
        { type: 'deliver', msg: 5 },
        { type: 'ack', core: 2, line: 0, gen: 1 },
      ],
    },
    lateAck: {
      cores: 3,
      lines: 1,
      events: [
        { type: 'read_miss', core: 0, line: 0 },
        { type: 'deliver', msg: 1 },
        { type: 'read_miss', core: 1, line: 0 },
        { type: 'deliver', msg: 2 },
        { type: 'write_upgrade', core: 1, line: 0, data: 7 },
        { type: 'deliver', msg: 3 },
        { type: 'ack', core: 0, line: 0, gen: 1 },
        { type: 'read_miss', core: 2, line: 0 },
        { type: 'deliver', msg: 4 },
        { type: 'write_upgrade', core: 2, line: 0, data: 9 },
        { type: 'deliver', msg: 5 },
        { type: 'ack', core: 1, line: 0, gen: 1 },
      ],
    },
    missingData: {
      cores: 2,
      lines: 1,
      events: [
        { type: 'read_miss', core: 0, line: 0 },
        { type: 'read_miss', core: 1, line: 0 },
      ],
    },
  };

  // ---------- 状态栏 ----------

  function setStatus(t) { $('#status').textContent = t; }

  function setStepInfo() {
    if (!steps) { $('#stepInfo').textContent = ''; return; }
    $('#stepInfo').textContent = '第 ' + idx + ' / ' + (steps.length - 1) + ' 步（事件 ' +
      Math.min(idx, eventsTotal) + ' / ' + eventsTotal + '）';
  }

  // ---------- Worker 管理 ----------

  function stopPlay() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // 取消当前运行：递增令牌使任何在途结果失效，并终止 Worker
  function cancelRun(reason) {
    runToken++;
    if (worker) { worker.terminate(); worker = null; }
    stopPlay();
    if (reason) setStatus(reason);
  }

  function runSimulation(input) {
    cancelRun();
    var token = runToken;
    setStatus('计算中…');
    steps = null;
    resetCompare(); // 新一轮回放：对照只能基于本次快照，清空上一轮选择
    worker = new Worker('worker.js');
    worker.onmessage = function (e) {
      var msg = e.data;
      if (!msg || msg.token !== token) return; // 旧结果不得覆盖新导入内容
      if (msg.type === 'error') { setStatus('计算失败：' + msg.error); return; }
      var result = msg.result;
      if (!result.ok) { setStatus('导入被拒绝：' + result.error); return; }
      steps = result.steps;
      eventsTotal = result.eventsTotal;
      idx = 0;
      renderEventList(result);
      renderStep();
      renderCompare();
      if (result.violation) {
        setStatus('回放冻结于第 ' + result.violation.step + ' 步（首次违约）');
      } else {
        setStatus('回放就绪：' + result.eventsProcessed + ' 个事件全部闭合，无违约');
      }
    };
    worker.onerror = function (err) {
      if (token !== runToken) return;
      setStatus('Worker 错误：' + (err.message || err));
    };
    worker.postMessage({ token: token, input: input });
  }

  // ---------- 导入与草稿 ----------

  function importText(text) {
    var input;
    try {
      input = JSON.parse(text);
    } catch (err) {
      setStatus('JSON 解析失败：' + err.message);
      return;
    }
    try {
      localStorage.setItem(DRAFT_KEY, text); // 本地草稿：重开页面可复查同一份逐步证据
    } catch (e) { /* 存储不可用时仅跳过持久化 */ }
    runSimulation(input);
  }

  function loadSample(name) {
    var text = JSON.stringify(SAMPLES[name], null, 2);
    $('#jsonInput').value = text;
    importText(text);
  }

  // ---------- 事件序列 ----------

  function fmtEvent(ev) {
    switch (ev.type) {
      case 'read_miss': return '读缺失 C' + ev.core + ' L' + ev.line;
      case 'write_upgrade': return '写升级 C' + ev.core + ' L' + ev.line +
        (ev.data !== undefined ? ' 数据=' + ev.data : '');
      case 'deliver': return '投递 M' + ev.msg;
      case 'timeout': return '超时重传 M' + ev.msg;
      case 'ack': return '确认 C' + ev.core + ' L' + ev.line + ' 世代' + ev.gen;
      default: return JSON.stringify(ev);
    }
  }

  function renderEventList(result) {
    var ol = $('#eventList');
    ol.innerHTML = '';
    result.steps.forEach(function (s, i) {
      if (i === 0) return; // 初始状态不占事件位
      var li = document.createElement('li');
      li.textContent = fmtEvent(s.event);
      li.dataset.step = String(i);
      if (s.violation) li.classList.add('bad');
      li.addEventListener('click', function () { stopPlay(); idx = i; renderStep(); });
      ol.appendChild(li);
    });
  }

  // ---------- 渲染 ----------

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function renderStep() {
    if (!steps) return;
    var s = steps[idx];
    setStepInfo();

    // 事件高亮
    var items = $('#eventList').children;
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', Number(items[i].dataset.step) === idx);
    }

    // 说明
    $('#note').textContent = s.note || '';

    // 违约横幅
    var box = $('#violation');
    if (s.violation) {
      var v = s.violation;
      var labels = (typeof Protocol !== 'undefined') ? Protocol.VIOLATION_LABELS : {};
      var label = labels[v.kind] || v.kind;
      box.innerHTML = '⛔ 首次违约冻结 — <b>' + esc(label) + '</b>'
        + (v.line !== null && v.line !== undefined ? '｜线 L' + esc(v.line) : '')
        + (v.core !== null && v.core !== undefined
          ? '｜核心 ' + (Array.isArray(v.core) ? v.core.map(function (c) { return 'C' + c; }).join(',') : 'C' + esc(v.core))
          : '')
        + (v.msgId !== null && v.msgId !== undefined ? '｜消息 M' + esc(v.msgId) : '')
        + '<br>' + esc(v.detail);
      box.classList.remove('hidden');
    } else {
      box.classList.add('hidden');
      box.innerHTML = '';
    }

    renderDir(s);
    renderCaches(s);
    renderInflight(s);
  }

  function renderDir(s) {
    var html = '<thead><tr><th>线</th><th>状态</th><th>拥有者</th><th>共享者</th>' +
      '<th>数据</th><th>世代</th><th>等待确认</th><th>对照</th></tr></thead><tbody>';
    s.dir.forEach(function (d) {
      var wait = d.pending
        ? 'C' + d.pending.requester + ' @世代' + d.pending.gen + ' 等 {' +
          d.pending.waitAcks.map(function (c) { return 'C' + c; }).join(',') + '}'
        : '—';
      html += '<tr class="st-' + d.state + '"><td>L' + d.line + '</td><td>' + d.state + '</td><td>' +
        (d.owner === null ? '—' : 'C' + d.owner) + '</td><td>{' +
        d.sharers.map(function (c) { return 'C' + c; }).join(',') + '}</td><td>' + d.data +
        '</td><td class="gen">g' + d.gen + '</td><td>' + wait + '</td>' +
        '<td class="cmp-cell"><button type="button" data-cmp="a" data-line="' + d.line +
        '">起点</button><button type="button" data-cmp="b" data-line="' + d.line +
        '">终点</button></td></tr>';
    });
    $('#dirTable').innerHTML = html + '</tbody>';
  }

  function renderCaches(s) {
    var nLines = s.dir.length;
    var html = '<thead><tr><th>核\\线</th>';
    for (var l = 0; l < nLines; l++) html += '<th>L' + l + '</th>';
    html += '</tr></thead><tbody>';
    s.caches.forEach(function (c) {
      html += '<tr><th>C' + c.core + '</th>';
      c.lines.forEach(function (cl) {
        var sub = 'g' + cl.lastInvGen + (cl.owedAckGen !== null ? ' ⏳待确认g' + cl.owedAckGen : '');
        html += '<td class="st-' + cl.state + '"><b>' + cl.state + '</b>' +
          (cl.data !== null ? ' d=' + cl.data : '') + '<br><small>' + sub + '</small></td>';
      });
      html += '</tr>';
    });
    $('#cacheTable').innerHTML = html + '</tbody>';
  }

  function renderInflight(s) {
    var box = $('#inflight');
    if (s.inFlight.length === 0) { box.innerHTML = '<span class="dim">（无在途消息）</span>'; return; }
    box.innerHTML = s.inFlight.map(function (m) {
      var body = m.kind === 'inv'
        ? '失效→C' + m.to + ' L' + m.line + ' g' + m.gen
        : '授权→C' + m.to + ' L' + m.line + ' ' + m.grantState + ' g' + m.gen + ' d=' + m.data;
      var dup = m.dupOf !== null ? ' <em>重传自 M' + m.dupOf + '</em>' : '';
      return '<span class="chip ' + m.kind + '">M' + m.id + ' ' + esc(body) + dup + '</span>';
    }).join(' ');
  }

  // ---------- 步骤对照 ----------

  // 清空对照选择与结果（取消、重新导入、清除草稿时调用）
  function resetCompare() {
    cmpA = null;
    cmpB = null;
    renderCompare();
  }

  function fmtCoreSet(list) {
    if (list === null || list === undefined) return '—';
    if (list.length === 0) return '∅';
    return '{' + list.map(function (c) { return 'C' + c; }).join(',') + '}';
  }

  function fmtSetChange(d) {
    var parts = [];
    d.added.forEach(function (c) { parts.push('+C' + c); });
    d.removed.forEach(function (c) { parts.push('−C' + c); });
    return parts.length ? parts.join('，') : '不变';
  }

  function fmtCmpMsg(m) {
    var body = m.kind === 'inv'
      ? '失效→C' + m.to + ' g' + m.gen
      : '授权→C' + m.to + ' ' + m.grantState + ' g' + m.gen + ' d=' + m.data;
    var dup = (m.dupOf !== null && m.dupOf !== undefined) ? '（重传自 M' + m.dupOf + '）' : '';
    return 'M' + m.id + ' ' + body + dup;
  }

  function cmpChip(kind, text) {
    return '<span class="chip ' + kind + '">' + esc(text) + '</span>';
  }

  function renderCompare() {
    var status = $('#cmpStatus');
    var result = $('#cmpResult');
    result.innerHTML = ''; // 任何情况下都不沿用上一轮对照结果
    if (!steps) {
      status.textContent = '尚未产生快照：请先导入事件记录并完成回放，再选择对照步骤。';
      return;
    }
    var sa = cmpA ? '第 ' + cmpA.step + ' 步 · L' + cmpA.line : '未选择';
    var sb = cmpB ? '第 ' + cmpB.step + ' 步 · L' + cmpB.line : '未选择';
    status.textContent = '起点：' + sa + ' ｜ 终点：' + sb +
      '（在目录表对应缓存线行点击「起点」「终点」）';
    if (!cmpA || !cmpB) return;
    if (typeof Protocol === 'undefined' || !Protocol.compareSteps) {
      result.innerHTML = '<div class="cmp-hint">⚠ 对照功能不可用：protocol.js 未加载</div>';
      return;
    }
    var r = Protocol.compareSteps(steps, cmpA, cmpB);
    if (!r.ok) {
      result.innerHTML = '<div class="cmp-hint">⚠ ' + esc(r.error) + '</div>';
      return;
    }
    var html = '';
    if (r.frozen) {
      var v = r.frozen.violation;
      var labels = Protocol.VIOLATION_LABELS || {};
      html += '<div class="cmp-frozen">⚠ 较晚步骤已冻结：对照止于第 ' + r.frozen.step +
        ' 步（首个违规）— <b>' + esc(labels[v.kind] || v.kind) + '</b>：' + esc(v.detail) + '</div>';
    }
    html += renderCmpDir(r);
    html += renderCmpMsgs(r);
    result.innerHTML = html;
  }

  function renderCmpDir(r) {
    var d = r.dir;
    function row(label, from, to, change, changed) {
      return '<tr class="' + (changed ? 'cmp-changed' : '') + '"><td>' + label + '</td><td>' +
        from + '</td><td>' + to + '</td><td>' + change + '</td></tr>';
    }
    var ownerFrom = d.owner.from === null ? '—' : 'C' + d.owner.from;
    var ownerTo = d.owner.to === null ? '—' : 'C' + d.owner.to;
    var html = '<table class="grid cmp-table"><thead><tr><th>目录项（L' + r.line + '）</th><th>第 ' +
      r.fromStep + ' 步</th><th>第 ' + r.toStep + ' 步</th><th>稳定差异</th></tr></thead><tbody>';
    html += row('状态', d.state.from, d.state.to,
      d.state.changed ? d.state.from + ' → ' + d.state.to : '不变', d.state.changed);
    html += row('世代', 'g' + d.gen.from, 'g' + d.gen.to,
      d.gen.changed ? 'g' + d.gen.from + ' → g' + d.gen.to : '不变', d.gen.changed);
    html += row('等待核心集合', fmtCoreSet(d.waitAcks.from), fmtCoreSet(d.waitAcks.to),
      fmtSetChange(d.waitAcks), d.waitAcks.changed);
    html += row('拥有者', ownerFrom, ownerTo,
      d.owner.changed ? ownerFrom + ' → ' + ownerTo : '不变', d.owner.changed);
    html += row('共享者', fmtCoreSet(d.sharers.from), fmtCoreSet(d.sharers.to),
      fmtSetChange(d.sharers), d.sharers.changed);
    return html + '</tbody></table>';
  }

  function renderCmpMsgs(r) {
    var ms = r.messages;
    function row(title, chips) {
      return '<div class="cmp-msgrow"><b>' + title + '</b> ' +
        (chips.length ? chips.join(' ') : '<span class="dim">（无）</span>') + '</div>';
    }
    var html = '<div class="cmp-msgs"><h3>区间内在途消息（L' + r.line + '，第 ' +
      r.fromStep + '→' + r.toStep + ' 步）</h3>';
    html += row('新出现：', ms.appeared.map(function (m) {
      return cmpChip(m.kind, fmtCmpMsg(m) + '（第 ' + m.since + ' 步出现）');
    }));
    html += row('已消失：', ms.disappeared.map(function (m) {
      return cmpChip(m.kind, fmtCmpMsg(m) + '（第 ' + m.lastSeen + ' 步后消失）');
    }));
    html += row('状态改变：', ms.changed.map(function (m) {
      return cmpChip(m.from.kind, 'M' + m.id + '：' + fmtCmpMsg(m.from) + ' → ' + fmtCmpMsg(m.to));
    }));
    html += row('区间内出现又消失：', ms.transient.map(function (m) {
      return cmpChip(m.kind, fmtCmpMsg(m) + '（第 ' + m.firstSeen + '→' + m.lastSeen + ' 步在途）');
    }));
    return html + '</div>';
  }

  // ---------- 回放控制 ----------

  function stepTo(i) {
    if (!steps) return;
    idx = Math.max(0, Math.min(steps.length - 1, i));
    renderStep();
  }

  function bind() {
    $('#btnImport').addEventListener('click', function () { importText($('#jsonInput').value); });
    document.querySelectorAll('[data-sample]').forEach(function (b) {
      b.addEventListener('click', function () { loadSample(b.dataset.sample); });
    });
    $('#btnClearDraft').addEventListener('click', function () {
      try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
      $('#jsonInput').value = '';
      cancelRun('本地草稿已清除');
      steps = null; $('#eventList').innerHTML = ''; renderEmptyTables(); setStepInfo();
      resetCompare();
    });
    $('#btnPrev').addEventListener('click', function () { stopPlay(); stepTo(idx - 1); });
    $('#btnNext').addEventListener('click', function () { stopPlay(); stepTo(idx + 1); });
    $('#btnReset').addEventListener('click', function () { stopPlay(); stepTo(0); });
    $('#btnPlay').addEventListener('click', function () {
      if (!steps || timer) return;
      timer = setInterval(function () {
        if (idx >= steps.length - 1) { stopPlay(); return; }
        idx++; renderStep();
      }, PLAY_INTERVAL_MS);
    });
    $('#btnPause').addEventListener('click', stopPlay);
    $('#btnCancel').addEventListener('click', function () {
      cancelRun('已取消：旧结果不会覆盖当前内容');
      steps = null; $('#eventList').innerHTML = ''; renderEmptyTables(); setStepInfo();
      resetCompare();
    });
    // 目录表内「起点 / 终点」按钮：为同一缓存线先后选择两个步骤做对照
    $('#dirTable').addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.matches || !t.matches('button[data-cmp]')) return;
      if (!steps) return;
      stopPlay();
      var sel = { step: idx, line: Number(t.getAttribute('data-line')) };
      if (t.getAttribute('data-cmp') === 'a') cmpA = sel; else cmpB = sel;
      renderCompare();
    });
    $('#btnCmpClear').addEventListener('click', function () { resetCompare(); });
  }

  function renderEmptyTables() {
    $('#dirTable').innerHTML = '';
    $('#cacheTable').innerHTML = '';
    $('#inflight').innerHTML = '';
    $('#note').textContent = '';
    $('#violation').classList.add('hidden');
  }

  // ---------- 启动 ----------

  bind();
  var draft = null;
  try { draft = localStorage.getItem(DRAFT_KEY); } catch (e) { /* ignore */ }
  if (draft) {
    $('#jsonInput').value = draft;
    importText(draft); // 重新打开本地草稿：确定性重放同一份逐步证据
  } else {
    $('#jsonInput').value = JSON.stringify(SAMPLES.legal, null, 2);
    importText($('#jsonInput').value);
  }
})();

/*
 * 目录缓存一致性重放核心（世代绑定的失效/确认协议）。
 *
 * 同一份代码运行在两个环境：
 *   - 浏览器 Web Worker（importScripts('protocol.js') 后挂到 self.Protocol）
 *   - Node.js（require，用于规则测试）
 *
 * 协议要点：
 *   - 每轮写升级让目录为该缓存线推进一个递增世代（gen），
 *     本轮所有失效请求（inv 消息）都绑定该世代；
 *   - 只有当前等待集合（waitAcks）中的同世代确认（ack）才能推进写入；
 *     迟到确认（无等待写入 / 世代不符 / 不在等待集合）在首次违约步冻结；
 *   - 超时重传只复制在途消息；重复投递只能回放既有动作（重新登记同世代
 *     待确认），不得产生新动作，否则按过期消息冻结；
 *   - 每步之后做全局一致性检查：重复独占者、目录与副本不一致。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Protocol = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const LIMITS = Object.freeze({ maxCores: 4, maxLines: 8, maxEvents: 48 });

  const VIOLATION = Object.freeze({
    LATE_ACK: 'late-ack',
    MISSING_OWNER_DATA: 'missing-owner-data',
    DUPLICATE_EXCLUSIVE: 'duplicate-exclusive',
    DIR_COPY_MISMATCH: 'directory-copy-mismatch',
    STALE_MESSAGE: 'stale-message',
    INVALID_EVENT: 'invalid-event',
  });

  const VIOLATION_LABELS = Object.freeze({
    'late-ack': '迟到确认',
    'missing-owner-data': '缺失拥有者数据',
    'duplicate-exclusive': '重复独占者',
    'directory-copy-mismatch': '目录与副本不一致',
    'stale-message': '过期消息（重复投递越界）',
    'invalid-event': '非法事件',
  });

  const EVENT_TYPES = new Set(['read_miss', 'write_upgrade', 'deliver', 'timeout', 'ack']);

  function clone(x) { return structuredClone(x); }

  function cores(list) { return list.map((c) => 'C' + c).join(','); }

  // ---------- 状态 ----------

  function createState(numCores, numLines) {
    const dir = [];
    for (let l = 0; l < numLines; l++) {
      dir.push({
        line: l,
        state: 'I',          // 目录状态：I / S / E
        owner: null,         // E 时的独占拥有者
        sharers: [],         // 共享者集合（E 时等于 [owner]）
        data: 0,             // 目录（内存）已知数据
        gen: 0,              // 当前世代：每轮失效递增
        pending: null,       // { requester, gen, waitAcks:[], writeData }
      });
    }
    const caches = [];
    for (let c = 0; c < numCores; c++) {
      const lines = [];
      for (let l = 0; l < numLines; l++) {
        lines.push({
          state: 'I',        // 副本状态：I / S / E / M
          data: null,
          lastInvGen: 0,     // 本核心已见的最新失效世代
          owedAckGen: null,  // 已收失效、尚未送达目录的确认世代
        });
      }
      caches.push({ core: c, lines });
    }
    return { dir, caches, inFlight: [], nextMsgId: 1 };
  }

  function send(state, fields) {
    const m = Object.assign({ id: state.nextMsgId++, from: 'D', dupOf: null }, fields);
    state.inFlight.push(m);
    return m;
  }

  // ---------- 输入校验 ----------

  function validateInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return '输入必须是 JSON 对象：{"cores":N,"lines":M,"events":[...]}';
    }
    const { cores: n, lines: l, events } = input;
    if (!Number.isInteger(n) || n < 1 || n > LIMITS.maxCores) {
      return `核心数须为 1..${LIMITS.maxCores} 的整数`;
    }
    if (!Number.isInteger(l) || l < 1 || l > LIMITS.maxLines) {
      return `缓存线数须为 1..${LIMITS.maxLines} 的整数`;
    }
    if (!Array.isArray(events)) return 'events 必须是数组';
    if (events.length > LIMITS.maxEvents) return `事件数 ${events.length} 超过上限 ${LIMITS.maxEvents}`;
    return null;
  }

  function validateEvent(ev, numCores, numLines) {
    if (!ev || typeof ev !== 'object' || !EVENT_TYPES.has(ev.type)) {
      return `未知事件类型（须为 ${[...EVENT_TYPES].join(' / ')}）`;
    }
    const needCoreLine = ev.type === 'read_miss' || ev.type === 'write_upgrade' || ev.type === 'ack';
    if (needCoreLine) {
      if (!Number.isInteger(ev.core) || ev.core < 0 || ev.core >= numCores) return '核心编号越界';
      if (!Number.isInteger(ev.line) || ev.line < 0 || ev.line >= numLines) return '缓存线编号越界';
    }
    if (ev.type === 'write_upgrade' && ev.data !== undefined && typeof ev.data !== 'number') {
      return '写数据 data 须为数字';
    }
    if ((ev.type === 'deliver' || ev.type === 'timeout') && !Number.isInteger(ev.msg)) {
      return '消息编号 msg 须为整数';
    }
    if (ev.type === 'ack' && !Number.isInteger(ev.gen)) return '确认世代 gen 须为整数';
    return null;
  }

  // ---------- 违约构造 ----------

  function violation(kind, line, core, msgId, detail) {
    return { kind, line, core, msgId, detail };
  }

  // ---------- 事件处理（返回 { note } 或 { note, violation }） ----------

  function ok(note) { return { note }; }
  function bad(note, v) { return { note, violation: v }; }

  function onReadMiss(state, ev) {
    const { core, line } = ev;
    const d = state.dir[line];
    const cl = state.caches[core].lines[line];
    if (cl.state !== 'I') return ok(`C${core} 在 L${line} 命中（${cl.state}），无需动作`);
    if (d.pending) {
      return bad('目录忙，读缺失无法受理', violation(
        VIOLATION.INVALID_EVENT, line, core, null,
        `L${line} 目录正等待第 ${d.pending.gen} 世代确认（等待集合 {${cores(d.pending.waitAcks)}}），读缺失无法受理`,
      ));
    }
    const inflightGrant = state.inFlight.find((m) => m.kind === 'grant' && m.to === core && m.line === line);
    if (inflightGrant) return ok(`授权消息 M${inflightGrant.id} 已在途，读缺失合并，无需重复授权`);

    if (d.state === 'I') {
      d.state = 'E'; d.owner = core; d.sharers = [core];
      const m = send(state, { kind: 'grant', to: core, line, gen: d.gen, grantState: 'E', data: d.data });
      return ok(`L${line} 目录空闲 → 授予 C${core} 独占（E），生成授权消息 M${m.id}（世代 ${d.gen}，数据=${d.data}）`);
    }
    if (d.state === 'S') {
      if (!d.sharers.includes(core)) d.sharers.push(core);
      const m = send(state, { kind: 'grant', to: core, line, gen: d.gen, grantState: 'S', data: d.data });
      return ok(`L${line} 共享态 → C${core} 加入共享集合 {${cores(d.sharers)}}，生成授权消息 M${m.id}（S，数据=${d.data}）`);
    }
    // d.state === 'E'
    const owner = d.owner;
    if (owner === core) return ok(`C${core} 已是 L${line} 独占者（授权在途），无需动作`);
    const oc = state.caches[owner].lines[line];
    if (oc.state === 'I' || oc.data === null) {
      const g = state.inFlight.find((m) => m.kind === 'grant' && m.to === owner && m.line === line);
      return bad('读缺失需要拥有者数据，但拥有者副本缺失', violation(
        VIOLATION.MISSING_OWNER_DATA, line, owner, g ? g.id : null,
        `L${line} 读缺失需要拥有者 C${owner} 的数据，但其副本为 ${oc.state}（数据=${oc.data}）`
        + (g ? `；授权消息 M${g.id} 仍在途，数据尚未到达` : ''),
      ));
    }
    d.data = oc.data; // 写回目录
    oc.state = 'S';
    d.state = 'S'; d.owner = null;
    if (!d.sharers.includes(core)) d.sharers.push(core);
    const m = send(state, { kind: 'grant', to: core, line, gen: d.gen, grantState: 'S', data: d.data });
    return ok(`拥有者 C${owner} 写回数据=${d.data} 并降级为 S；C${core} 加入共享集合 {${cores(d.sharers)}}，生成授权消息 M${m.id}`);
  }

  function onWriteUpgrade(state, ev) {
    const { core, line, data } = ev;
    const d = state.dir[line];
    const cl = state.caches[core].lines[line];
    if (d.pending) {
      return bad('目录忙，写升级无法受理', violation(
        VIOLATION.INVALID_EVENT, line, core, null,
        `L${line} 目录正等待第 ${d.pending.gen} 世代确认（等待集合 {${cores(d.pending.waitAcks)}}），写升级无法受理`,
      ));
    }
    if (cl.state === 'M') return ok(`C${core} 已持有 M，无需升级`);
    if (cl.state === 'E') {
      cl.state = 'M';
      if (data !== undefined) cl.data = data;
      return ok(`C${core} 静默升级 E→M（无其他副本，无需失效）`);
    }
    if (cl.state === 'I') {
      return bad('写升级时核心无副本', violation(
        VIOLATION.INVALID_EVENT, line, core, null,
        `写升级要求 C${core} 持有 L${line} 的 S/E 副本，实际为 I`,
      ));
    }
    // cl.state === 'S'：发起新一轮失效，世代递增
    const others = d.sharers.filter((x) => x !== core);
    d.gen += 1;
    const writeData = data !== undefined ? data : cl.data;
    if (others.length === 0) {
      cl.state = 'M'; cl.data = writeData;
      d.state = 'E'; d.owner = core; d.sharers = [core];
      return ok(`无其他共享者，写入立即闭合：C${core} 获得独占（M，世代 ${d.gen}，数据=${writeData}）`);
    }
    d.pending = { requester: core, gen: d.gen, waitAcks: others.slice(), writeData };
    const parts = [];
    for (const o of others) {
      const m = send(state, { kind: 'inv', to: o, line, gen: d.gen });
      parts.push(`M${m.id}→C${o}`);
    }
    return ok(`发起第 ${d.gen} 世代失效：${parts.join('，')}；等待确认集合 {${cores(others)}}`);
  }

  function onDeliver(state, ev) {
    const idx = state.inFlight.findIndex((m) => m.id === ev.msg);
    if (idx < 0) {
      return bad('投递的消息不存在', violation(
        VIOLATION.INVALID_EVENT, null, null, ev.msg,
        `消息 M${ev.msg} 不在在途集合（可能已投递或从未生成）`,
      ));
    }
    const m = state.inFlight.splice(idx, 1)[0];
    const cl = state.caches[m.to].lines[m.line];
    const dupTag = m.dupOf !== null ? `（M${m.dupOf} 的重传副本）` : '';

    if (m.kind === 'inv') {
      if (m.gen < cl.lastInvGen) {
        return bad('过期失效请求到达', violation(
          VIOLATION.STALE_MESSAGE, m.line, m.to, m.id,
          `失效请求 M${m.id}${dupTag}（世代 ${m.gen}）到达 C${m.to}，但核心已见世代 ${cl.lastInvGen}；重复投递只能回放既有动作`,
        ));
      }
      if (m.gen === cl.lastInvGen && cl.state === 'I') {
        cl.owedAckGen = m.gen; // 回放既有动作：重新登记同世代待确认
        return ok(`M${m.id}${dupTag} 为重复失效（世代 ${m.gen}）：回放既有动作，C${m.to} 重新登记待确认`);
      }
      if (m.gen === cl.lastInvGen && cl.state !== 'I') {
        return bad('重复失效请求越界', violation(
          VIOLATION.STALE_MESSAGE, m.line, m.to, m.id,
          `失效请求 M${m.id}${dupTag}（世代 ${m.gen}）到达 C${m.to}，但核心已在新一轮重新持有副本（${cl.state}）；重复投递不得产生新动作`,
        ));
      }
      const had = cl.state;
      cl.state = 'I'; cl.data = null;
      cl.lastInvGen = m.gen; cl.owedAckGen = m.gen;
      return ok(`C${m.to} 收到失效请求 M${m.id}${dupTag}（世代 ${m.gen}）：副本 ${had}→I，登记待确认`);
    }

    // m.kind === 'grant'
    if (m.gen < cl.lastInvGen) {
      return bad('过期数据授权到达', violation(
        VIOLATION.STALE_MESSAGE, m.line, m.to, m.id,
        `数据授权 M${m.id}${dupTag}（世代 ${m.gen}）到达 C${m.to}，但核心已见失效世代 ${cl.lastInvGen}；过期授权必须丢弃`,
      ));
    }
    const dup = cl.state !== 'I';
    cl.state = m.grantState; cl.data = m.data;
    return ok(dup
      ? `M${m.id}${dupTag} 为重复授权：回放既有动作，C${m.to} 保持 ${m.grantState}（数据=${m.data}）`
      : `C${m.to} 收到授权 M${m.id}${dupTag}：副本 → ${m.grantState}（数据=${m.data}）`);
  }

  function onTimeout(state, ev) {
    const m = state.inFlight.find((x) => x.id === ev.msg);
    if (!m) {
      return bad('重传的消息不存在', violation(
        VIOLATION.INVALID_EVENT, null, null, ev.msg,
        `消息 M${ev.msg} 不在在途集合，无法超时重传`,
      ));
    }
    const dup = Object.assign({}, m, { id: state.nextMsgId++, dupOf: m.id });
    state.inFlight.push(dup);
    return ok(`超时重传：复制 M${m.id} → M${dup.id}（${m.kind}，线 L${m.line}，世代 ${m.gen}）`);
  }

  function onAck(state, ev) {
    const { core, line, gen } = ev;
    const d = state.dir[line];
    const cl = state.caches[core].lines[line];
    if (!d.pending) {
      return bad('确认到达时目录无等待中的写入', violation(
        VIOLATION.LATE_ACK, line, core, null,
        `C${core} 对 L${line} 的确认（世代 ${gen}）到达时，目录无等待中的写入；旧确认不得释放新独占`,
      ));
    }
    if (d.pending.gen !== gen) {
      return bad('确认世代不符', violation(
        VIOLATION.LATE_ACK, line, core, null,
        `C${core} 对 L${line} 的确认世代 ${gen} 与当前等待世代 ${d.pending.gen} 不符；旧失效确认不得闭合新一轮写入`,
      ));
    }
    if (!d.pending.waitAcks.includes(core)) {
      return bad('确认者不在等待集合', violation(
        VIOLATION.LATE_ACK, line, core, null,
        `C${core} 不在 L${line} 当前等待集合 {${cores(d.pending.waitAcks)}} 中（可能重复确认或与本轮无关）`,
      ));
    }
    if (cl.owedAckGen !== gen) {
      return bad('核心未欠该世代确认', violation(
        VIOLATION.INVALID_EVENT, line, core, null,
        `C${core} 未登记世代 ${gen} 的待确认失效（当前待确认=${cl.owedAckGen}），确认来源不明`,
      ));
    }
    cl.owedAckGen = null;
    d.pending.waitAcks = d.pending.waitAcks.filter((x) => x !== core);
    if (d.pending.waitAcks.length === 0) {
      const req = d.pending.requester;
      const rcl = state.caches[req].lines[line];
      rcl.state = 'M'; rcl.data = d.pending.writeData;
      d.state = 'E'; d.owner = req; d.sharers = [req];
      const g = d.pending.gen;
      d.pending = null;
      return ok(`C${core} 的世代 ${gen} 确认接受；等待集合清空，写入闭合：C${req} 获得独占（M，世代 ${g}，数据=${rcl.data}）`);
    }
    return ok(`C${core} 的世代 ${gen} 确认接受；仍等待 {${cores(d.pending.waitAcks)}}`);
  }

  function applyEvent(state, ev) {
    switch (ev.type) {
      case 'read_miss': return onReadMiss(state, ev);
      case 'write_upgrade': return onWriteUpgrade(state, ev);
      case 'deliver': return onDeliver(state, ev);
      case 'timeout': return onTimeout(state, ev);
      case 'ack': return onAck(state, ev);
      default: return bad('未知事件', violation(VIOLATION.INVALID_EVENT, null, null, null, `未知事件类型 ${ev.type}`));
    }
  }

  // ---------- 全局一致性检查 ----------

  // 有效持有 = 缓存副本 + 将要生效的在途授权（世代不落后于核心已见失效世代）
  function effectiveHolders(state, line) {
    const holders = new Map(); // core -> 'S'|'E'|'M'
    for (const c of state.caches) {
      const cl = c.lines[line];
      if (cl.state !== 'I') holders.set(c.core, cl.state);
    }
    for (const m of state.inFlight) {
      if (m.kind === 'grant' && m.line === line) {
        const cl = state.caches[m.to].lines[line];
        if (m.gen >= cl.lastInvGen) holders.set(m.to, m.grantState);
      }
    }
    return holders;
  }

  function fmtHolders(holders) {
    return [...holders.entries()].map(([c, s]) => `C${c}:${s}`).join('，') || '（无）';
  }

  function checkConsistency(state) {
    for (const d of state.dir) {
      const line = d.line;
      const holders = effectiveHolders(state, line);
      const excl = [...holders.entries()].filter(([, s]) => s === 'E' || s === 'M');

      if (excl.length >= 2) {
        return violation(
          VIOLATION.DUPLICATE_EXCLUSIVE, line, excl.map(([c]) => c), null,
          `L${line} 出现重复独占者：${fmtHolders(new Map(excl))}；独占权限被错误释放`,
        );
      }
      if (excl.length === 1 && holders.size > 1) {
        return violation(
          VIOLATION.DIR_COPY_MISMATCH, line, excl[0][0], null,
          `L${line} 独占副本 ${fmtHolders(new Map(excl))} 与其他副本共存：${fmtHolders(holders)}`,
        );
      }
      if (d.pending) continue; // 写入进行中：目录处于过渡态，仅做独占性检查

      if (d.state === 'I' && holders.size > 0) {
        return violation(
          VIOLATION.DIR_COPY_MISMATCH, line, [...holders.keys()], null,
          `L${line} 目录为 I，但存在副本：${fmtHolders(holders)}`,
        );
      }
      if (d.state === 'S') {
        const bad = [...holders.entries()].filter(([, s]) => s !== 'S');
        const sameSet = holders.size === d.sharers.length && d.sharers.every((c) => holders.has(c));
        if (bad.length > 0 || !sameSet) {
          return violation(
            VIOLATION.DIR_COPY_MISMATCH, line, [...holders.keys()], null,
            `L${line} 目录共享者 {${cores(d.sharers)}} 与副本 ${fmtHolders(holders)} 不一致`,
          );
        }
      }
      if (d.state === 'E') {
        const okE = holders.size === 1 && holders.has(d.owner)
          && (holders.get(d.owner) === 'E' || holders.get(d.owner) === 'M');
        if (!okE) {
          return violation(
            VIOLATION.DIR_COPY_MISMATCH, line, d.owner, null,
            `L${line} 目录独占者 C${d.owner} 与副本 ${fmtHolders(holders)} 不一致`,
          );
        }
      }
    }
    return null;
  }

  // ---------- 步骤对照（同一缓存线两个已存在快照的稳定差异） ----------
  //
  // 审查员发现一次写升级迟迟未闭合时，可先后选择同一缓存线的两个步骤，
  // 直接对照两端快照，定位区间内究竟是哪条确认 / 重传 / 投递改变了写入条件：
  //   - 目录稳定差异：世代、等待核心集合、拥有者、共享者；
  //   - 在途消息：仅列出区间内新出现、消失、状态改变（含区间内出现并已消失）
  //     的消息，两端均在途且未变的消息不列出；
  //   - 若区间跨过首次违约步，对照止于该步并保留违约错误说明。
  // 该函数只读快照、不改变任何状态；Worker 与主线程均可调用。

  function cmpError(code, message) { return { ok: false, error: { code, message } }; }

  function lineWait(d) {
    if (!d.pending) return { waiting: false, requester: null, gen: null, waitAcks: [] };
    return {
      waiting: true,
      requester: d.pending.requester,
      gen: d.pending.gen,
      waitAcks: d.pending.waitAcks.slice().sort((x, y) => x - y),
    };
  }

  function setDelta(fromList, toList) {
    const from = new Set(fromList);
    return {
      added: toList.filter((c) => !from.has(c)).sort((x, y) => x - y),
      removed: fromList.filter((c) => !new Set(toList).has(c)).sort((x, y) => x - y),
    };
  }

  const MSG_SIG_KEYS = ['id', 'kind', 'from', 'to', 'line', 'gen', 'grantState', 'data', 'dupOf'];
  function msgSig(m) { return JSON.stringify(MSG_SIG_KEYS.map((k) => m[k])); }

  function compareSteps(steps, fromSel, toSel) {
    if (!Array.isArray(steps) || steps.length === 0 || !Array.isArray(steps[0].dir)) {
      return cmpError('no-snapshots',
        '当前回放尚无快照：请先导入事件并产生回放结果后，再先后选择同一缓存线的两个步骤进行对照');
    }
    if (!fromSel || typeof fromSel !== 'object' || !toSel || typeof toSel !== 'object') {
      return cmpError('bad-selector', '对照选择无效：起点与终点均须指定 {line, step}');
    }
    const numLines = steps[0].dir.length;

    for (const [tag, sel] of [['起点', fromSel], ['终点', toSel]]) {
      if (!Number.isInteger(sel.line) || sel.line < 0 || sel.line >= numLines) {
        return cmpError('line-out-of-range',
          `${tag}缓存线 L${sel.line} 越界：当前回放共有 ${numLines} 条缓存线（L0..L${numLines - 1}），请重新选择`);
      }
      if (!Number.isInteger(sel.step) || sel.step < 0 || sel.step >= steps.length) {
        return cmpError('step-out-of-range',
          `${tag}步骤 ${sel.step} 越界：当前回放仅保留第 0..${steps.length - 1} 步快照（共 ${steps.length} 个），请重新选择`
          + (steps[steps.length - 1].violation ? '；回放已于首次违约步冻结，其后不再产生快照' : ''));
      }
    }
    if (fromSel.line !== toSel.line) {
      return cmpError('different-line',
        `两个步骤必须属于同一条缓存线（起点选了 L${fromSel.line}、终点选了 L${toSel.line}）：请统一缓存线后再对照`);
    }

    let a = fromSel.step;
    let b = toSel.step;
    let swapped = false;
    if (a > b) { const t = a; a = b; b = t; swapped = true; } // 先后选择不强制方向，按步号归一
    const line = fromSel.line;

    // 区间止于（含）首个违约步，保留其错误说明
    let stop = b;
    for (let i = a + 1; i <= b; i++) {
      if (steps[i].violation) { stop = i; break; }
    }
    const stopVio = steps[stop].violation ? clone(steps[stop].violation) : null;

    // ----- 目录稳定差异 -----
    const dA = steps[a].dir[line];
    const dB = steps[stop].dir[line];
    const wA = lineWait(dA);
    const wB = lineWait(dB);
    const shA = dA.sharers.slice().sort((x, y) => x - y);
    const shB = dB.sharers.slice().sort((x, y) => x - y);
    const dirDiff = {
      gen: { from: dA.gen, to: dB.gen, changed: dA.gen !== dB.gen },
      waitAcks: Object.assign(
        {
          from: wA.waitAcks, to: wB.waitAcks,
          pendingFrom: wA.waiting, pendingTo: wB.waiting,
          requesterFrom: wA.requester, requesterTo: wB.requester,
          genFrom: wA.gen, genTo: wB.gen,
        },
        setDelta(wA.waitAcks, wB.waitAcks),
      ),
      owner: { from: dA.owner, to: dB.owner, changed: dA.owner !== dB.owner },
      sharers: Object.assign({ from: shA, to: shB }, setDelta(shA, shB)),
    };

    // ----- 在途消息差异（仅限本缓存线） -----
    const lineMsgs = (i) => steps[i].inFlight.filter((m) => m.line === line);
    const mapA = new Map(lineMsgs(a).map((m) => [m.id, m]));
    const mapB = new Map(lineMsgs(stop).map((m) => [m.id, m]));
    const track = new Map(); // id -> { born, last }
    for (let i = a; i <= stop; i++) {
      for (const m of lineMsgs(i)) {
        let t = track.get(m.id);
        if (!t) { t = { born: i, last: i }; track.set(m.id, t); }
        else t.last = i;
      }
    }

    const added = [];
    const removed = [];
    const changed = [];
    const ephemeral = [];
    const eventAt = (i) => (steps[i].event ? clone(steps[i].event) : null);
    const findMsg = (i, id) => steps[i].inFlight.find((m) => m.id === id && m.line === line) || null;

    for (const [id, t] of track) {
      const mA = mapA.get(id) || null;
      const mB = mapB.get(id) || null;
      if (mA && mB) {
        if (msgSig(mA) !== msgSig(mB)) {
          let atStep = stop;
          for (let i = a + 1; i <= stop; i++) {
            const mm = findMsg(i, id);
            if (mm && msgSig(mm) !== msgSig(mA)) { atStep = i; break; }
          }
          changed.push({ id, atStep, from: clone(mA), to: clone(mB) });
        } // 两端均在途且字段未变：稳定，不列出
      } else if (mA && !mB) {
        const goneStep = Math.min(t.last + 1, steps.length - 1);
        removed.push({ id, goneStep, event: eventAt(goneStep), msg: clone(mA) });
      } else if (!mA && mB) {
        added.push({ id, atStep: t.born, msg: clone(mB) });
      } else {
        // 起点与终点都不在途、仅区间中间出现过：区间内新出现并已消失
        const goneStep = Math.min(t.last + 1, steps.length - 1);
        ephemeral.push({ id, atStep: t.born, goneStep, bornEvent: eventAt(t.born), goneEvent: eventAt(goneStep), msg: clone(findMsg(t.born, id)) });
      }
    }
    const byId = (x, y) => x.id - y.id;
    added.sort(byId); removed.sort(byId); changed.sort(byId); ephemeral.sort(byId);

    return {
      ok: true,
      line,
      swapped,
      from: { step: a, event: eventAt(a) },
      to: { step: stop, event: eventAt(stop) },
      requestedTo: b,
      stoppedEarly: stop < b,
      violation: stopVio,
      dir: dirDiff,
      messages: { added, removed, changed, ephemeral },
    };
  }

  // ---------- 快照与主循环 ----------

  function snapshot(state, index, event, note, vio) {
    return {
      index,
      event: event ? clone(event) : null,
      note,
      violation: vio ? clone(vio) : null,
      dir: clone(state.dir),
      caches: clone(state.caches),
      inFlight: clone(state.inFlight),
    };
  }

  function simulate(input) {
    const inputError = validateInput(input);
    if (inputError) return { ok: false, error: inputError };

    const state = createState(input.cores, input.lines);
    const steps = [snapshot(state, 0, null, '初始状态：目录全 I，世代 0，无在途消息', null)];
    let frozeAt = null;

    for (let i = 0; i < input.events.length; i++) {
      const ev = input.events[i];
      const evErr = validateEvent(ev, input.cores, input.lines);
      let note; let vio = null;
      if (evErr) {
        vio = violation(VIOLATION.INVALID_EVENT, null, null, null, `事件 ${i + 1} 非法：${evErr}`);
        note = '事件校验失败';
      } else {
        const r = applyEvent(state, ev);
        note = r.note;
        vio = r.violation || checkConsistency(state);
      }
      if (vio) vio.step = i + 1;
      steps.push(snapshot(state, i + 1, ev, note, vio));
      if (vio) { frozeAt = i + 1; break; } // 首次违约步冻结
    }

    return {
      ok: true,
      steps,
      violation: frozeAt !== null ? steps[steps.length - 1].violation : null,
      eventsTotal: input.events.length,
      eventsProcessed: frozeAt !== null ? frozeAt : input.events.length,
    };
  }

  return {
    LIMITS, VIOLATION, VIOLATION_LABELS,
    createState, simulate, checkConsistency, effectiveHolders, compareSteps,
  };
});

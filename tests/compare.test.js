/*
 * 步骤对照规则测试（compareSteps）。
 * 覆盖：
 *   - 等待集合被同世代确认清空（含部分确认→闭合的写入条件变化）；
 *   - 超时重传不改变目录状态（仅新增重传副本）；
 *   - 区间内出现并已消失的重传副本（ephemeral）；
 *   - 冻结区间止于首个违规步并保留错误说明；
 *   - 越界步骤/缓存线、不同缓存线、尚无快照的可操作报错。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../app/protocol.js');

const V = P.VIOLATION;

// 合法重传闭合轨迹（步号即事件序号，第 0 步为初始状态）：
//  7 写升级 → M4 失效→C0、M5 失效→C2，等待 {C0,C2}，世代 1
//  8 超时重传 M4 → M6（dupOf=4）
//  9 投递 M4（C0 登记待确认）
// 10 投递 M6（回放既有动作）
// 11 C0 同世代确认 → 仍等 {C2}
// 12 投递 M5（C2 登记待确认）
// 13 C2 同世代确认 → 等待集合清空，写入闭合，C1 获 M
const LEGAL_TRACE = {
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
};

// 迟到确认轨迹：第 12 步（旧世代 g1 确认在 g2 等待中到达）冻结
const LATE_ACK_TRACE = {
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
};

test('对照：等待集合被同世代确认清空，写入条件闭合（世代不变、拥有者/共享者改变）', () => {
  const { steps } = P.simulate(LEGAL_TRACE);
  const r = P.compareSteps(steps, { line: 0, step: 10 }, { line: 0, step: 13 });
  assert.equal(r.ok, true);
  assert.equal(r.line, 0);

  // 世代在确认区间内保持 1（闭合写入不推进世代）
  assert.equal(r.dir.gen.from, 1);
  assert.equal(r.dir.gen.to, 1);
  assert.equal(r.dir.gen.changed, false);

  // 等待写入：进行中 → 已闭合
  assert.equal(r.dir.waitAcks.pendingFrom, true);
  assert.deepEqual(r.dir.waitAcks.from, [0, 2]);
  assert.equal(r.dir.waitAcks.pendingTo, false);
  assert.deepEqual(r.dir.waitAcks.to, []);
  assert.deepEqual(r.dir.waitAcks.removed, [0, 2]);
  assert.deepEqual(r.dir.waitAcks.added, []);

  // 拥有者：无 → 请求者 C1；共享者 {0,1,2} → {1}
  assert.deepEqual([r.dir.owner.from, r.dir.owner.to], [null, 1]);
  assert.equal(r.dir.owner.changed, true);
  assert.deepEqual(r.dir.sharers.from, [0, 1, 2]);
  assert.deepEqual(r.dir.sharers.to, [1]);
  assert.deepEqual(r.dir.sharers.removed, [0, 2]);

  // 区间内 M5 被投递（消失），无新消息、无字段改变
  const removedIds = r.messages.removed.map((x) => x.id);
  assert.deepEqual(removedIds, [5]);
  assert.equal(r.messages.removed[0].goneStep, 12);
  assert.deepEqual(r.messages.added, []);
  assert.deepEqual(r.messages.changed, []);
});

test('对照：单条同世代确认只移除对应核心，写入尚未闭合', () => {
  const { steps } = P.simulate(LEGAL_TRACE);
  const r = P.compareSteps(steps, { line: 0, step: 10 }, { line: 0, step: 11 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.dir.waitAcks.from, [0, 2]);
  assert.deepEqual(r.dir.waitAcks.to, [2]);
  assert.deepEqual(r.dir.waitAcks.removed, [0]);
  assert.equal(r.dir.waitAcks.pendingTo, true); // 仍在等待，写入未闭合
  assert.equal(r.dir.owner.changed, false);
});

test('对照：超时重传不改变目录状态，仅新增重传副本', () => {
  const r0 = P.simulate({
    cores: 2,
    lines: 1,
    events: [
      { type: 'read_miss', core: 0, line: 0 },
      { type: 'deliver', msg: 1 },
      { type: 'read_miss', core: 1, line: 0 },
      { type: 'deliver', msg: 2 },
      { type: 'write_upgrade', core: 0, line: 0 }, // 5：M3 失效→C1
      { type: 'timeout', msg: 3 },                 // 6：M4 = M3 重传副本
    ],
  });
  const r = P.compareSteps(r0.steps, { line: 0, step: 5 }, { line: 0, step: 6 });
  assert.equal(r.ok, true);

  // 目录四项稳定差异全部未变
  assert.equal(r.dir.gen.changed, false);
  assert.equal(r.dir.owner.changed, false);
  assert.deepEqual(r.dir.sharers.added, []);
  assert.deepEqual(r.dir.sharers.removed, []);
  assert.deepEqual(r.dir.waitAcks.from, [1]);
  assert.deepEqual(r.dir.waitAcks.to, [1]);
  assert.deepEqual(r.dir.waitAcks.removed, []);
  assert.equal(r.dir.waitAcks.pendingFrom, true);
  assert.equal(r.dir.waitAcks.pendingTo, true);

  // 仅出现一条新的在途消息：重传副本 M4，溯源 dupOf=3
  assert.equal(r.messages.added.length, 1);
  assert.equal(r.messages.added[0].id, 4);
  assert.equal(r.messages.added[0].atStep, 6);
  assert.equal(r.messages.added[0].msg.dupOf, 3);
  assert.deepEqual(r.messages.removed, []);
  assert.deepEqual(r.messages.changed, []);
});

test('对照：重传副本在区间内产生又被投递，列入“出现并已消失”，原消息消失单列', () => {
  const { steps } = P.simulate(LEGAL_TRACE);
  // 第 7 步在途 {M4,M5}；第 11 步在途 {M5}；M6 第 8 步产生、第 10 步投递
  const r = P.compareSteps(steps, { line: 0, step: 7 }, { line: 0, step: 11 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.messages.removed.map((x) => x.id), [4]);
  assert.deepEqual(r.messages.ephemeral.map((x) => x.id), [6]);
  const eph = r.messages.ephemeral[0];
  assert.equal(eph.atStep, 8);
  assert.equal(eph.goneStep, 10);
  assert.equal(eph.msg.dupOf, 4);
  // M5 两端均在途且未变：不列出
  assert.deepEqual(r.messages.added, []);
  assert.deepEqual(r.messages.changed, []);
});

test('对照：世代推进在差异中可见', () => {
  const { steps } = P.simulate(LEGAL_TRACE);
  const r = P.compareSteps(steps, { line: 0, step: 6 }, { line: 0, step: 7 });
  assert.equal(r.ok, true);
  assert.deepEqual([r.dir.gen.from, r.dir.gen.to], [0, 1]);
  assert.equal(r.dir.gen.changed, true);
  assert.deepEqual(r.dir.waitAcks.added, [0, 2]); // 新等待集合出现
});

test('对照：终点即冻结步时止于该步并保留违约错误说明', () => {
  const { steps } = P.simulate(LATE_ACK_TRACE);
  assert.equal(steps.length, 13); // 0..12，冻结于第 12 步
  const r = P.compareSteps(steps, { line: 0, step: 10 }, { line: 0, step: 12 });
  assert.equal(r.ok, true);
  assert.equal(r.to.step, 12);
  assert.equal(r.stoppedEarly, false);
  assert.ok(r.violation);
  assert.equal(r.violation.kind, V.LATE_ACK);
  assert.equal(r.violation.step, 12);
  assert.match(r.violation.detail, /世代/);
  // 冻结时目录仍在等待世代 2，独占未被释放
  assert.equal(r.dir.waitAcks.genTo, 2);
  assert.deepEqual(r.dir.waitAcks.to, [1]);
  assert.equal(r.dir.owner.to, null);
});

test('对照：区间内含首个违规步时截断到该步，不使用其后的状态', () => {
  const { steps } = P.simulate(LATE_ACK_TRACE);
  // 先选起点再反向选一个更早…这里用 swapped 场景：从 12 选到 10 归一为 10→12
  const r = P.compareSteps(steps, { line: 0, step: 12 }, { line: 0, step: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.swapped, true);
  assert.equal(r.from.step, 10);
  assert.equal(r.to.step, 12);
  assert.equal(r.stoppedEarly, false);
  assert.equal(r.violation.kind, V.LATE_ACK);
});

test('对照：选择冻结点之后不存在的步骤 → 越界报错且不沿用结果', () => {
  const { steps } = P.simulate(LATE_ACK_TRACE);
  const r = P.compareSteps(steps, { line: 0, step: 10 }, { line: 0, step: 13 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'step-out-of-range');
  assert.match(r.error.message, /13/);
  assert.match(r.error.message, /冻结/); // 可操作：提示已冻结
  assert.equal(r.dir, undefined);       // 失败结果不含任何旧对照数据
});

test('对照：步骤/缓存线越界给出可操作错误码', () => {
  const { steps } = P.simulate(LEGAL_TRACE);
  const r1 = P.compareSteps(steps, { line: 0, step: -1 }, { line: 0, step: 3 });
  assert.equal(r1.ok, false);
  assert.equal(r1.error.code, 'step-out-of-range');

  const r2 = P.compareSteps(steps, { line: 0, step: 0 }, { line: 0, step: 99 });
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, 'step-out-of-range');

  const r3 = P.compareSteps(steps, { line: 7, step: 0 }, { line: 7, step: 1 });
  assert.equal(r3.ok, false);
  assert.equal(r3.error.code, 'line-out-of-range');
  assert.match(r3.error.message, /L7/);
});

test('对照：两个步骤属于不同缓存线 → 拒绝并提示统一缓存线', () => {
  const r0 = P.simulate({
    cores: 1,
    lines: 2,
    events: [
      { type: 'read_miss', core: 0, line: 0 },
      { type: 'read_miss', core: 0, line: 1 },
    ],
  });
  const r = P.compareSteps(r0.steps, { line: 0, step: 1 }, { line: 1, step: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'different-line');
  assert.match(r.error.message, /L0/);
  assert.match(r.error.message, /L1/);
});

test('对照：尚无快照时给出可操作提示', () => {
  const r1 = P.compareSteps(null, { line: 0, step: 0 }, { line: 0, step: 1 });
  assert.equal(r1.ok, false);
  assert.equal(r1.error.code, 'no-snapshots');
  const r2 = P.compareSteps([], { line: 0, step: 0 }, { line: 0, step: 1 });
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, 'no-snapshots');
});

test('对照：在途消息差异只统计所选缓存线', () => {
  const r0 = P.simulate({
    cores: 2,
    lines: 2,
    events: [
      { type: 'read_miss', core: 0, line: 0 }, // M1 grant→C0 L0
      { type: 'read_miss', core: 0, line: 1 }, // M2 grant→C0 L1
      { type: 'deliver', msg: 1 },             // L0 的 M1 投递
    ],
  });
  const r = P.compareSteps(r0.steps, { line: 0, step: 1 }, { line: 0, step: 3 });
  assert.equal(r.ok, true);
  // L0：M1 区间内消失；L1 的 M2 不得出现在任何分组中
  assert.deepEqual(r.messages.removed.map((x) => x.id), [1]);
  const allIds = [...r.messages.added, ...r.messages.removed, ...r.messages.changed, ...r.messages.ephemeral]
    .map((x) => x.id);
  assert.ok(!allIds.includes(2), 'L1 的消息 M2 不得计入 L0 对照');
});

test('对照：只读快照，不修改任何步骤数据', () => {
  const r0 = P.simulate(LEGAL_TRACE);
  const before = JSON.stringify(r0.steps);
  P.compareSteps(r0.steps, { line: 0, step: 7 }, { line: 0, step: 13 });
  P.compareSteps(r0.steps, { line: 0, step: 0 }, { line: 0, step: 7 });
  assert.equal(JSON.stringify(r0.steps), before);
});

// 闸门事件中心 + 单轮止血纯逻辑（临时目录，不碰真实 state / QQ / DSH）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateEventStore, classifyGateEvent } from '../src/gate-events.js';
import { createTurnGuard } from '../src/turn-guard.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfc-gate-'));
try {
  const store = createGateEventStore({ dir, log: () => {} });
  const whitelist = store.record({ gate: 'allow', kind: 'security', event: 'not-whitelisted', reason: { code: 'NOT_ALLOWED' } });
  assert.equal(whitelist.level, 'L0', '普通白名单拒绝必须静默');

  const compat = store.record({ gate: 'qq-tool-restrict', kind: 'compat', event: 'context-denied', impactLevel: 'core' });
  assert.equal(compat.level, 'L2', '上下文压缩被拒要警示');

  const budgetActive = store.record({ gate: 'token-budget', kind: 'cost', event: 'budget-exhausted', activeTurn: true });
  assert.equal(budgetActive.level, 'L3', '回合中额度耗尽必须紧急停止');

  const warn = store.record({ gate: 'token-budget', kind: 'cost', event: 'budget-warning' });
  assert.equal(warn.level, 'L1', '80% 是轻提示');

  const leak = store.record({ gate: 'outbound', kind: 'security', event: 'sensitive-outbound', confidence: 'confirmed' });
  assert.equal(leak.level, 'L3');

  const tokenLike = store.record({
    gate: 'test', kind: 'cost', event: 'budget-warning',
    evidence: { token: 'SECRET-TOKEN', nested: { password: 'p' } },
  });
  const raw = fs.readFileSync(store.file, 'utf8');
  assert.ok(!raw.includes('SECRET-TOKEN'), '令牌不能落进事件文件');
  assert.ok(!raw.includes('"password":"p"'), '密码不能落进事件文件');
  assert.ok(tokenLike.evidence.token === '********');

  const listed = store.list({ limit: 20 });
  assert.ok(listed.events.length >= 5);
  assert.ok(listed.counts.L3 >= 2);
  assert.equal(store.list({ level: 'L0' }).events.every((x) => x.level === 'L0'), true);

  store.ack([whitelist.id]);
  assert.equal(store.list({ includeAcked: false }).events.some((x) => x.id === whitelist.id), false);
  store.ack([], true);

  // 分级函数本身：同一闸门因情境升级。
  assert.equal(classifyGateEvent({ kind: 'compat', event: 'tool-denied', repeatCount: 3, activeTurn: true }), 'L3');
  assert.equal(classifyGateEvent({ kind: 'security', event: 'not-whitelisted' }), 'L0');
  assert.equal(classifyGateEvent({ kind: 'fault', event: 'bridge-exit' }), 'L2');
  assert.equal(classifyGateEvent({ kind: 'fault', event: 'TURN_REPEATED_TOOL_ERROR', action: 'stopped' }), 'L3');
  assert.equal(classifyGateEvent({ kind: 'fault', event: 'TURN_STEPS_EXCEEDED', action: 'stopped' }), 'L3');

  // 单轮止血：步数、重复错误、预算。
  const turn = createTurnGuard({ maxSteps: 2, maxRepeatedErrors: 2 });
  turn.begin('s1', 'group:1');
  assert.equal(turn.noteStep('s1'), null);
  assert.equal(turn.noteStep('s1'), null);
  assert.equal(turn.noteStep('s1')?.code, 'TURN_STEPS_EXCEEDED');
  turn.end('s1');

  turn.begin('s2', 'group:1');
  assert.equal(turn.noteToolError('s2', 'compress', 'not allowed 1'), null);
  const repeated = turn.noteToolError('s2', 'compress', 'not allowed 2');
  assert.equal(repeated?.code, 'TURN_REPEATED_TOOL_ERROR');
  assert.equal(repeated?.evidence?.count, 2);
  turn.end('s2');

  turn.begin('s3');
  assert.equal(turn.noteBudgetExhausted('s3', [{ scope: 'qq' }])?.code, 'TURN_BUDGET_EXHAUSTED');

  // 接线契约：桥接必须真的在回合事件里接上 guard，且用 cancel-only 接口。
  const bridgeSource = fs.readFileSync(path.resolve('src/bridge.js'), 'utf8');
  const dshSource = fs.readFileSync(path.resolve('src/dsh-client.js'), 'utf8');
  assert.match(bridgeSource, /guardTurnEvent\(frame\.sessionId/, 'bridge 必须在 session/event 接 round guard');
  assert.match(bridgeSource, /api\.cancelTurn\(/, '止血必须调用 cancel-only');
  assert.match(dshSource, /async cancelTurn\(/, 'dsh-client 必须提供 cancelTurn');

  console.log('✅ 闸门事件中心/单轮止血通过');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

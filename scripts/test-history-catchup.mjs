/**
 * 上线补历史消息（socialV2.history）回归：
 *   · 纯逻辑：配置归一化、时间水位、候选过滤（水位/时间窗/重复/黑名单/上限）；
 *   · 接线：真实 bridge.js（audit-bridge-harness，VM + 夹具网关）启动 / 手动触发时
 *     真的请求历史接口、并入未读、标 history=true、按开关唤醒；
 *   · 提示词：history 唤醒原因与快照里的 history 标记。
 *
 * 不连 QQ / DSH / SnowLuma，不发任何消息。
 *
 * 运行：node scripts/test-history-catchup.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEFAULT_HISTORY_CATCHUP, buildHistoryCatchupLine, historyWatermark,
  normalizeHistoryConfig, selectMissedHistory, summarizeHistoryCatchup,
} from '../src/history-catchup.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const NOW = Date.UTC(2026, 9, 24, 2, 0, 0);

// ── 纯逻辑 ────────────────────────────────────────────────────────────────
assert.deepEqual(normalizeHistoryConfig(null), DEFAULT_HISTORY_CATCHUP, '缺省配置必须默认开启');
assert.equal(normalizeHistoryConfig({}).enabled, true, '没有配置时必须默认勾选打开');
assert.equal(normalizeHistoryConfig({ enabled: false }).enabled, false, '显式关闭必须保留');
assert.equal(normalizeHistoryConfig({ enabled: 'false' }).enabled, true, '非布尔值不能把默认开误关');
assert.deepEqual(
  normalizeHistoryConfig({ limit: -3, maxAgeMinutes: 999999, wake: 'no', includePrivate: 0 }),
  { enabled: true, limit: 1, maxAgeMinutes: 10080, wake: true, includePrivate: true },
  '坏值必须收敛且不改变布尔默认',
);

// 水位：取最近入站时间，并留 5 秒容差防止把停机前最后几秒误判成旧消息。
const watermarkState = {
  lastIncomingAt: NOW - 60_000,
  recentMessages: [
    { time: NOW - 120_000 },
    { time: NOW - 30_000, isSelf: true },
  ],
};
assert.equal(
  historyWatermark(watermarkState, { now: NOW, maxAgeMs: 12 * 3600_000 }),
  NOW - 35_000,
  '水位应取最近消息时间并减 5 秒容差',
);
// 时间窗把过旧的水位抬到 floor。
assert.equal(
  historyWatermark({ lastIncomingAt: NOW - 10 * 3600_000 }, { now: NOW, maxAgeMs: 3600_000 }),
  NOW - 3600_000,
  '超过时间窗的水位必须被 floor 截断',
);

const candidates = [
  { messageId: 'a1', time: NOW - 20 * 60_000, userId: '2001', isSelf: false },
  { messageId: 'a2', time: NOW - 10 * 60_000, userId: '2002', isSelf: true },
  { messageId: 'a3', time: NOW - 5 * 60_000, userId: '2003', isSelf: false },
  { messageId: 'old', time: NOW - 3 * 3600_000, userId: '2001', isSelf: false },
  { messageId: 'blocked', time: NOW - 2 * 60_000, userId: '9999', isSelf: false },
  { messageId: 'a1', time: NOW - 20 * 60_000, userId: '2001', isSelf: false },
  { messageId: '', time: NOW - 60_000, userId: '2001', isSelf: false },
  { messageId: 'future', time: NOW + 10 * 60_000, userId: '2001', isSelf: false },
];
const picked = selectMissedHistory(candidates, {
  watermark: NOW - 30 * 60_000,
  now: NOW,
  maxAgeMs: 12 * 3600_000,
  limit: 30,
  existingIds: ['a1'],
  blockedUsers: ['9999'],
});
assert.deepEqual(picked.map((m) => m.messageId), ['a2', 'a3'], '只保留水位后、未见过、非黑名单、非未来消息');

const capped = selectMissedHistory(
  Array.from({ length: 40 }, (_, index) => ({
    messageId: `m${index}`, time: NOW - (40 - index) * 60_000, userId: '2001', isSelf: false,
  })),
  { watermark: NOW - 24 * 3600_000, now: NOW, maxAgeMs: 24 * 3600_000, limit: 5 },
);
assert.deepEqual(capped.map((m) => m.messageId), ['m35', 'm36', 'm37', 'm38', 'm39'], '超限时保留最新 N 条且按时间升序');

assert.deepEqual(summarizeHistoryCatchup(picked), { incoming: 1, self: 1, total: 2 });
assert.match(buildHistoryCatchupLine({ incoming: 2, self: 1 }), /2 条群友\/好友消息/);
assert.match(buildHistoryCatchupLine({ incoming: 2, self: 1 }), /1 条你自己以前发过的消息/);
assert.equal(buildHistoryCatchupLine({ incoming: 0, self: 0 }), '');

// ── 桥接接线（夹具网关）────────────────────────────────────────────────────
const SELF_ID = '3760717363';
const GROUP = 'group:456';
const toSeconds = (ms) => Math.floor(ms / 1000);
const fixture = (messageId, atMs, userId, text, card = '') => ({
  time: toSeconds(atMs),
  message_id: messageId,
  user_id: Number(userId),
  sender: { user_id: Number(userId), nickname: card || `用户${userId}`, card },
  message: [{ type: 'text', data: { text } }],
});

const now = Date.now();
const history = {
  [GROUP]: [
    // 停机前已经处理过的旧消息：水位会挡住。
    fixture(9000, now - 2 * 3600_000, '2001', '很久以前'),
    // 真正错过的两条群友消息 + 一条自己以前发的消息。
    fixture(9001, now - 40 * 60_000, '2001', '你们刚才说的那个我错过了'),
    fixture(9002, now - 20 * 60_000, SELF_ID, '我上次说了一半就掉线了', '卡哇伊的小肥鱼'),
    fixture(9003, now - 5 * 60_000, '2002', '回来没'),
    // 重复 id 必须只入一次。
    fixture(9003, now - 5 * 60_000, '2002', '回来没'),
    // 黑名单的人不能借历史消息绕过。
    fixture(9004, now - 60_000, '9999', '黑名单不该出现'),
  ],
};
const savedState = {
  paused: false,
  conversations: {
    [GROUP]: {
      agentToken: 'fixture-agent-token',
      bootstrapSent: true,
      wakeConfig: {
        mode: 'diving', infinite: true,
        triggers: { atMention: true, nameMention: true, question: true, poke: true, probability: 0 },
      },
      recentMessages: [{ seq: 1, messageId: '8999', sender: '旧消息', text: '旧消息', time: now - 2 * 3600_000, isSelf: false }],
      unread: [],
      lastIncomingAt: now - 3600_000,
      lastUnreadSeq: 1,
      lastReadThroughSeq: 1,
    },
  },
};

const h = await bridgeHarness({
  config: {
    ownerQQ: '123',
    deny: { users: ['9999'], private: [], groups: [] },
    allow: { private: ['123'], groups: ['456'] },
    socialV2: { history: { enabled: true, limit: 30, maxAgeMinutes: 720, wake: true, includePrivate: true } },
  },
  files: { 'state/social-v2.json': savedState },
  history,
});
try {
  h.setMode('reserved2');
  h.setSelfIdentity('卡哇伊的小肥鱼', SELF_ID);

  // 关闭时不得请求历史接口。
  const conf = h.historyCatchUpConfig();
  assert.equal(conf.enabled, true, '夹具配置应为开启');
  h.cfg.socialV2.history.enabled = false;
  const disabled = await h.runHistoryCatchUp('test', { force: true });
  assert.equal(disabled.disabled, true, '关闭后必须直接返回，不发历史请求');
  h.cfg.socialV2.history.enabled = true;

  const result = await h.runHistoryCatchUp('test', { force: true });
  assert.equal(result.ok, true);
  assert.equal(result.incoming, 2, '应补回 2 条群友消息（重复 id 只算一次）');
  assert.equal(result.self, 1, '应补回 1 条自己以前发的消息');
  assert.equal(result.total, 3);
  const groupResult = result.results.find((item) => item.key === GROUP);
  assert.equal(groupResult?.wakeScheduled, true, '开启 wake 时应安排一次 history 唤醒');

  const st = h.getSocialV2State(GROUP);
  assert.equal(st.unread.length, 2, '只把群友消息放进未读');
  assert.deepEqual(Array.from(st.unread, (m) => m.messageId), ['9001', '9003']);
  assert.ok(st.unread.every((m) => m.history === true), '补回来的消息必须带 history=true');
  assert.ok(st.unread.every((m) => m.history === true && m.seq > 0), '历史消息必须有本地 seq，才能被 qq_mark_read 处理');
  assert.ok(st.recentMessages.some((m) => m.messageId === '9002' && m.isSelf === true), '自己的旧消息只进 recent');
  assert.equal(st.recentMessages.some((m) => m.messageId === '9002' && st.unread.includes(m)), false);
  assert.equal(st.recentMessages.some((m) => m.messageId === '9004'), false, '黑名单用户的消息不得入库');
  assert.equal(st.recentMessages.some((m) => m.messageId === '9000'), false, '水位之前的旧消息不得入库');
  // 水位推进到「本次看到的最新历史消息」（含被黑名单过滤的那条），避免下次反复拉同一段。
  assert.equal(st.lastHistoryMessageTime, Math.floor((now - 60_000) / 1000) * 1000, '水位推进到本次最新历史消息');
  assert.ok(st.pendingWakeTimer, '应有一个待发送的 history 唤醒');

  // 快照与唤醒提示必须让模型看出这是历史消息。
  const snapshot = h.buildWakeSnapshotV2(GROUP);
  assert.ok(snapshot.messages.some((m) => m.messageId === '9001' && m.history === true), '唤醒快照必须带 history 标记');
  const prompt = h.buildWakePromptV2(GROUP, 'history');
  assert.ok(prompt.includes('【上线补历史】'), 'history 唤醒原因必须有自己的提示词');
  assert.ok(prompt.includes('不要当成刚刚发生'), '提示词必须告诉模型不要当新消息');

  // 再跑一次：同一批消息不得重复灌入，也不应再次唤醒。
  const again = await h.runHistoryCatchUp('test', { force: true });
  assert.equal(again.incoming, 0, '重复检查不得二次入库');
  assert.equal(again.total, 0);
  assert.equal(again.results.find((item) => item.key === GROUP)?.wakeScheduled, false);
  assert.equal(h.getSocialV2State(GROUP).unread.length, 2);

  // 非 reserved2 模式不跑历史补看。
  h.setMode('chat');
  const skipped = await h.runHistoryCatchUp('test', { force: true });
  assert.equal(skipped.skipped, 'mode');
  h.setMode('reserved2');

  // 新会话（未完成 bootstrap）不补：避免在缺少二代协议说明时被历史消息唤醒。
  const fresh = 'group:789';
  h.cfg.allow.groups.push('789');
  const freshState = h.getSocialV2State(fresh);
  freshState.bootstrapSent = false;
  const freshResult = await h.runHistoryCatchUp('test', { force: true });
  assert.equal(freshResult.results.some((item) => item.key === fresh), false, '未 bootstrap 的会话不应请求历史');
} finally {
  await h.close();
}

// 关闭 wake：只并入未读、不安排唤醒。
const h2 = await bridgeHarness({
  config: {
    ownerQQ: '123', allow: { private: ['123'], groups: ['456'] },
    deny: { users: ['9999'], private: [], groups: [] },
    socialV2: { history: { enabled: true, limit: 30, maxAgeMinutes: 720, wake: false, includePrivate: true } },
  },
  files: { 'state/social-v2.json': savedState },
  history,
});
try {
  h2.setMode('reserved2');
  h2.setSelfIdentity('卡哇伊的小肥鱼', SELF_ID);
  const result = await h2.runHistoryCatchUp('test', { force: true });
  assert.equal(result.incoming, 2);
  assert.equal(result.results.find((item) => item.key === GROUP)?.wakeScheduled, false, '关掉 wake 后不得主动醒');
  assert.equal(h2.getSocialV2State(GROUP).pendingWakeTimer, null);
} finally {
  await h2.close();
}

// 源码级接线：VM 夹具在 `bot.on('open')` 之前就 return 了，自动触发路径只能静态钉住，
// 防止以后重构把「上线」入口删掉却仍然让手动接口测试通过。
const bridgeSource = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
assert.match(bridgeSource, /runHistoryCatchUp\('connect'\)/, '连接成功后必须触发首次补历史');
assert.match(bridgeSource, /setAccountOnline\(event\.status\.online, 'heartbeat'\)/, '心跳 online 边沿必须触发补历史');
assert.match(bridgeSource, /setAccountOnline\(sub === 'online', 'bot_status'\)/, 'bot_status 上线必须触发补历史');
assert.match(bridgeSource, /setAccountOnline\(body\.data\.online, 'get_status'\)/, 'get_status 兜底轮询也必须触发补历史');
assert.match(bridgeSource, /\/api\/socialV2\/history-catchup/, '控制台必须有手动检查接口');
assert.match(bridgeSource, /adminOnlyV2Paths[\s\S]{0,400}\/api\/socialV2\/history-catchup/, '补历史接口不得暴露给 agent token');
const example = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
assert.equal(example.socialV2?.history?.enabled, true, 'config.example.json 默认必须勾选打开');

console.log('history catch-up tests OK');

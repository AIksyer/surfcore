// 对话收尾判断接线：真实 bridge.js 的状态/提示词/收尾接口（VM 夹具，不连真 QQ）。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run, options) {
  const h = await bridgeHarness(options);
  try {
    h.setMode('reserved2');
    await run(h);
    console.log('PASS', name);
  } catch (error) {
    failures += 1;
    console.error('FAIL', name, error.message);
  } finally {
    await h.close();
  }
}

const now = Date.now();
function seedChat(h, key = 'private:123') {
  h.appendSocialV2Message(key, '主人', '诶～原来弥叭也会脸红的呀', '诶～原来弥叭也会脸红的呀', false, true, 'm1');
  h.appendSocialV2Message(key, '主人', '那咱们扯平啦，谁都不许先低头', '那咱们扯平啦，谁都不许先低头', false, true, 'm2');
  const st = h.getSocialV2State(key);
  // 模拟她刚发完「嗯嗯」：reserved2 的工具发送会记进 sentTexts / recentMessages，
  // 这里直接补一条 isSelf 的最近消息，等价于「我最后一句是收尾」。
  st.recentMessages.push({
    seq: 0, messageId: null, sender: '弥', userId: null,
    text: '嗯嗯', plain: '嗯嗯', tail: '嗯嗯', isSelf: true,
    isOwner: false, media: [], hasMedia: false, time: now - 30 * 1000,
  });
  st.lastAiReplyAt = now - 30 * 1000;
  // 模拟「这些消息已经通过唤醒快照展示给模型」；close 只确认展示过的水位。
  st.modelSeenSeqs = new Set(st.unread.map((m) => m.seq));
  return st;
}

await test('收尾接口：写结束点、保持唤醒配置、返回冷却，不发消息', async (h) => {
  const st = seedChat(h);
  const beforeWc = JSON.stringify(st.wakeConfig);
  const beforeUnread = st.unread.length;
  const r = h.closeConversationV2('private:123', {
    reason: 'natural',
    summary: '聊到扯平这件事',
    nextOpening: '问问她周末去不去看展',
  });
  assert.equal(r.ok, true);
  assert.equal(r.wakeKept, true);
  assert.equal(r.markedCount, beforeUnread);
  assert.equal(r.unreadCount, 0);
  assert.ok(r.cooldownUntil > now);
  assert.equal(st.closure.summary, '聊到扯平这件事');
  assert.equal(st.closure.nextOpening, '问问她周末去不去看展');
  assert.equal(st.closure.reason, 'natural');
  assert.equal(JSON.stringify(st.wakeConfig), beforeWc, '收尾不是潜水：wakeConfig 不能变');
  assert.equal(h.calls.sent.length, 0, '收尾不能发 QQ 消息');
  assert.ok(st.lastActionAt >= now);
});

await test('对方还在提问：收尾接口硬拒绝，状态不变', async (h) => {
  h.appendSocialV2Message('private:123', '主人', '你最近在忙什么', '你最近在忙什么', false, true, 'm3');
  const st = h.getSocialV2State('private:123');
  const before = JSON.stringify({ closure: st.closure, unread: st.unread.length });
  assert.throws(
    () => h.closeConversationV2('private:123', {}),
    (error) => error.statusCode === 409 && error.code === 'open-question' && /先.*回/.test(error.message),
  );
  assert.equal(JSON.stringify({ closure: st.closure, unread: st.unread.length }), before);
});

await test('收尾不走沉睡前观察；唤醒提示带判断块与上次结束点', async (h) => {
  seedChat(h);
  // 关键：当前是潜水配置、刚刚还有新消息 —— mark_read 会被 preSleepWaitBlockedV2 拦，
  // 但 close 不是潜水，必须直接成功（否则「发完嗯嗯想结束」永远要等 5 分钟）。
  const st = h.getSocialV2State('private:123');
  st.wakeConfig.mode = 'diving';
  st.wakeConfig.infinite = true;
  st.wakeConfig.confirmedAt = 0;
  st.preSleepWaitSatisfiedAt = 0;
  st.preSleepWaitObservedAt = 0;
  const r = h.closeConversationV2('private:123', { summary: '收在这里' });
  assert.equal(r.ok, true);
  const prompt = h.buildWakePromptV2('private:123', 'replyCheck');
  assert.match(prompt, /【对话收尾判断】先判断这段是否已经自然走到终点/);
  assert.match(prompt, /qq_close_conversation/);
  assert.match(prompt, /不用沉睡前观察/);
  assert.match(prompt, /上次这段/);
  assert.match(prompt, /收在这里/);
});

await test('冷却只压普通概率唤醒；被叫到/私聊照常醒', async (h) => {
  seedChat(h);
  h.closeConversationV2('private:123', {});
  const st = h.getSocialV2State('private:123');
  assert.equal(h.closureSuppressesWake(st.closure, 'probability'), true);
  assert.equal(h.closureSuppressesWake(st.closure, 'replyCheck'), true);
  assert.equal(h.closureSuppressesWake(st.closure, 'proactiveCheck'), true);
  assert.equal(h.closureSuppressesWake(st.closure, 'atMention'), false);
  assert.equal(h.closureSuppressesWake(st.closure, 'question'), false);
  assert.equal(h.closureSuppressesWake(st.closure, 'private'), false);
});

await test('对方再开口：私聊重开；群聊普通消息不重开、叫到才重开', async (h) => {
  seedChat(h);
  h.closeConversationV2('private:123', {});
  const st = h.getSocialV2State('private:123');
  const reopened = h.noteClosureReopenV2('private:123', st, { plain: '嗯嗯', text: '嗯嗯' });
  assert.equal(reopened, true);
  assert.ok(st.closure.reopenedAt > 0);

  h.appendSocialV2Message('group:456', '群友', '今天吃啥', '今天吃啥', false, false, 'g1');
  h.closeConversationV2('group:456', {});
  const gst = h.getSocialV2State('group:456');
  assert.equal(h.noteClosureReopenV2('group:456', gst, { plain: '今天吃啥', text: '今天吃啥' }), false);
  assert.equal(h.noteClosureReopenV2('group:456', gst, { plain: '弥在吗', text: '弥在吗', directAddress: true }), true);
});

await test('关掉开关：收尾接口 403，提示词不注入判断块', async (h) => {
  seedChat(h);
  h.cfg.socialV2.closure = { enabled: false };
  assert.throws(() => h.closeConversationV2('private:123', {}), (error) => error.statusCode === 403);
  const prompt = h.buildWakePromptV2('private:123', 'replyCheck');
  assert.doesNotMatch(prompt, /先判断这段是否已经自然走到终点/);
}, { config: { socialV2: { closure: { enabled: false } } } });

await test('收尾记录进状态接口所需的持久化字段', async (h) => {
  seedChat(h);
  h.closeConversationV2('private:123', { summary: '话题聊完', nextOpening: '下次问问看展' });
  const st = h.getSocialV2State('private:123');
  const saved = JSON.parse(JSON.stringify(st.closure));
  assert.equal(saved.summary, '话题聊完');
  assert.equal(saved.kind, 'private');
  assert.ok(saved.at > 0);
});

console.log(`\n${failures ? 'FAILED' : 'OK'}（closure wiring）`);
process.exitCode = failures ? 1 : 0;

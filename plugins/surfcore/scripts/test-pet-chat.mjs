/**
 * 桌宠对话的纯逻辑回归（不连模型、不发消息、不读用户数据）：
 *   · 语音文本截断 / 去旁白；
 *   · 模型回复清理；
 *   · 本地令牌与事件水位（插件重启后旧游标不回放、也不卡死）。
 *
 * 运行：node plugins/surfcore/scripts/test-pet-chat.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clipForVoice,
  cleanReply,
  stripStageDirections,
  buildPetMemoryEvents,
  createPetChatService,
} from '../lib/pet-chat.js';

// ── 语音文本 ────────────────────────────────────────────────────────────────
assert.equal(clipForVoice('你好呀', 120), '你好呀');
const long = '第一句话很长很长很长。第二句话也很长很长很长。第三句话更长更长更长更长。';
const clipped = clipForVoice(long, 18);
assert.ok(clipped.length <= 19, `截断后应不超过上限：${clipped.length}`);
assert.ok(clipped.endsWith('。') || clipped.endsWith('…'), `应在句号处截断：${clipped}`);
assert.equal(clipForVoice('啊'.repeat(50), 20).length <= 21, true);
assert.equal(stripStageDirections('（笑）在呀 (挥挥手) 弥叭'), '在呀 弥叭');

// ── 回复清理 ────────────────────────────────────────────────────────────────
assert.equal(cleanReply('小肥鱼：在呢'), '在呢');
assert.equal(cleanReply('“在呢”'), '在呢');
assert.equal(cleanReply('**在呢**'), '在呢');
assert.equal(cleanReply('```\n在呢\n```'), '在呢');

// ── 记忆卡事件：和 QQ / B站 同一张卡，但 platform=pet ─────────────────────
{
  const now = Date.now();
  const pair = buildPetMemoryEvents({ userText: '在干嘛呀', replyText: '在陪你呀', at: now, roleName: '小咪' });
  assert.equal(pair.length, 2, '一问一答 = 两条 inbox 事件');
  assert.equal(pair[0].platform, 'pet');
  assert.equal(pair[0].isOwner, true);
  assert.equal(pair[0].text, '在干嘛呀');
  assert.equal(pair[1].isSelf, true);
  assert.equal(pair[1].sender, '小咪');
  assert.equal(pair[1].text, '在陪你呀');
  const proactive = buildPetMemoryEvents({ replyText: '突然想跟你说句话', at: now, roleName: '小咪' });
  assert.equal(proactive.length, 1, '主动搭话只有她自己那条');
  assert.equal(proactive[0].isSelf, true);
  assert.equal(proactive[0].platform, 'pet');
}

// ── 令牌 + 事件水位 ─────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-chat-test-'));
try {
  const service = createPetChatService({
    ctx: { get: () => undefined },
    stateDir: tmp,
    pluginLog: () => {},
  });
  const token = service.token();
  assert.match(token, /^[a-f0-9]{32,80}$/, '令牌必须是随机 hex');
  assert.equal(service.token(), token, '令牌要稳定复用');

  const first = await service.poll({ since: null, waitMs: 0 });
  assert.equal(first.events.length, 0, '首次连接不重放历史事件');
  assert.equal(first.cursor, 0);

  service.emit({ type: 'proactive', text: '在吗', modality: 'text' });
  const got = await service.poll({ since: 0, waitMs: 0 });
  assert.equal(got.events.length, 1, '新事件应该被取到');
  assert.equal(got.events[0].text, '在吗');
  assert.equal(got.cursor, 1);

  // 插件重启 / 老客户端带着更大的游标来：直接回到新水位，不能死等。
  const stale = await service.poll({ since: 99, waitMs: 0 });
  assert.equal(stale.events.length, 0);
  assert.equal(stale.cursor, 1);

  // 专注模式：单一真相在 pet/focus.json；事件要能立刻唤醒长轮询。
  assert.equal(service.focusEnabled(), false);
  const focus = service.setFocus(true, 'test');
  assert.equal(focus.enabled, true);
  assert.equal(service.focusEnabled(), true);
  assert.equal(service.publicConfig().focus.enabled, true);
  assert.equal(service.status().focus.enabled, true);
  const focusEvent = await service.poll({ since: 1, waitMs: 0 });
  assert.equal(focusEvent.events.length, 1);
  assert.equal(focusEvent.events[0].type, 'focus');
  assert.equal(focusEvent.events[0].enabled, true);
  assert.equal(service.setFocus(false, 'test').enabled, false);
  assert.equal(service.focusEnabled(), false);

  // 没连模型时聊天必须给可读错误，而不是抛异常。
  const chat = await service.chat({ text: '在吗', modality: 'text' });
  assert.equal(chat.ok, false);
  assert.match(chat.error, /模型服务|就绪/);
  console.log('pet-chat tests OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

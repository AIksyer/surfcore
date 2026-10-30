// SnowLuma 断线时，主动唤醒必须在创建 DSH 会话之前被挡下（零 token）。
// 用真实 bridge.js + VM 夹具；不连 QQ / DSH。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const h = await bridgeHarness({
  config: {
    socialV2: {
      enabled: true,
      proactive: { enabled: true },
      tokenGuard: { enabled: false },
    },
  },
});
try {
  h.setMode('reserved2');
  const createdBefore = h.calls.created.length;

  // 1) WS 未连接：不创建会话、不投 prompt。
  h.setSnowlumaHealth({ connected: false, lastSendOkAt: 0, lastSendFailAt: 0, downNotified: false });
  await h.sendWakePromptV2('private:123', 'proactiveCheck');
  assert.equal(h.calls.created.length, createdBefore, '通道断开时不得创建 DSH 会话');

  // 2) 通道恢复，但有“连续发送失败暂停”：仍然不烧。
  h.setSnowlumaHealth({ connected: true, lastSendFailAt: 0, lastSendOkAt: 0, downNotified: false });
  const st = h.getSocialV2State('private:123');
  st.wakeSuspendedUntil = Date.now() + 60_000;
  await h.sendWakePromptV2('private:123', 'proactiveCheck');
  assert.equal(h.calls.created.length, createdBefore, '暂停期内不得创建 DSH 会话');

  // 3) 解除暂停后，同一路径必须真的能创建会话（证明前两条不是因为别的 guard 顺带拦住）。
  st.wakeSuspendedUntil = 0;
  await h.sendWakePromptV2('private:123', 'proactiveCheck');
  assert.ok(h.calls.created.length > createdBefore, '通道健康且未暂停时应创建会话');

  const client = fs.readFileSync(path.resolve('plugins/surfcore/lib/client.js'), 'utf8');
  assert.match(client, /SnowLuma 连接异常/, 'UI 必须显示 SnowLuma 断线原因和建议');

  console.log('✅ SnowLuma 通道闸门通过（断开/暂停均不创建 DSH 会话）');
} finally {
  await h.close();
}

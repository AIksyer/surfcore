/**
 * 出站身份闸回归（2026-10-23 用户要求：「只准自己互认，不许泄露主人和别人的信息」）。
 *
 * 为什么必须钉：
 *   · 跨平台互认会把「主人 QQ ⇄ B站 mid」「对齐表里别人的号」放进提示词；
 *     模型一旦在 B站 评论/动态里复述，就是不可撤回的公开泄露。
 *   · 这层是**确定性**的规则（已知 ID 精确匹配 + QQ/群号形态），不是提示词；
 *     但它也只有被真的接进发送路径才有效 —— 所以这里同时断言接线。
 *
 * 运行：node scripts/test-identity-guard.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findIdentityLeaks, formatIdentityLeakError, maskLeakValue,
} from '../src/identity-guard.js';
import {
  assertOutboundIdentitySafe, collectProtectedIdentities,
} from '../plugins/surfcore/tools/lib/outbound-guard.mjs';

let failures = 0;
function test(name, run) {
  try { run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
}

const IDS = ['3287064288', '37634003', '111222333'];

// ── 纯函数 ─────────────────────────────────────────────────────────────────
test('已知 ID 精确命中', () => {
  const hits = findIdentityLeaks('主人的B站是 37634003 哦', { ids: IDS });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].value, '37634003');
  assert.equal(hits[0].kind, 'known-id');
});

test('「QQ / 群号 + 数字」形态也拦（即使不在名单里）', () => {
  for (const text of ['加我 QQ：123456789', '群号 555666777', 'QQ是 987654321']) {
    assert.ok(findIdentityLeaks(text, { ids: [] }).length > 0, text);
  }
});

test('普通数字不误伤（年份/播放量/楼层）', () => {
  for (const text of ['2026 年了还在看这个', '才 123456 播放', '第 88 楼说得对', 'BV1Lpnr6wE59']) {
    assert.deepEqual(findIdentityLeaks(text, { ids: IDS }), [], text);
  }
});

test('空文本不算泄露', () => {
  assert.deepEqual(findIdentityLeaks('', { ids: IDS }), []);
  assert.deepEqual(findIdentityLeaks(null, { ids: IDS }), []);
  assert.deepEqual(findIdentityLeaks('   ', { ids: IDS }), []);
});

test('错误信息里的号码是打码的（错误本身也可能被贴进日志）', () => {
  const hits = findIdentityLeaks('主人QQ 3287064288', { ids: IDS });
  const message = formatIdentityLeakError(hits, 'B站 评论');
  assert.match(message, /B站 评论/);
  assert.match(message, /328\*\*\*\*288/, message);
  assert.ok(!message.includes('3287064288'), '错误信息里不能出现完整号码');
  assert.match(message, /只用来认自己|不许外传/);
  assert.equal(maskLeakValue('123456789'), '123****789');
  assert.equal(maskLeakValue('abc'), 'abc');
});

// ── 配置收集（临时目录，不碰真实 ~/.dsh）────────────────────────────────────
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-guard-'));
try {
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    admin: { qq: '3287064288', biliMid: '37634003', biliName: '主人' },
  }));
  fs.writeFileSync(path.join(temp, 'bili.config.json'), JSON.stringify({
    owner: { mid: '37634003', name: '主人' },
    self: { mid: '1483638708', name: '小肥鱼' },
  }));
  fs.writeFileSync(path.join(temp, 'alignments.json'), JSON.stringify({
    links: [
      { identities: { qq: { id: '111222333' }, bili: { id: '99887766' } } },
      // 她自己的映射：B站 mid 允许出现在自己的公开内容里，但 QQ 号仍然不许外传
      { identities: { qq: { id: '444555666' }, bili: { id: '1483638708' } } },
    ],
  }));

  test('受保护名单 = 主人 QQ/mid + 对齐表里别人的号；自己的 B站 mid 不拦', () => {
    const ids = collectProtectedIdentities({ surfcoreDir: temp });
    for (const wanted of ['3287064288', '37634003', '111222333', '99887766', '444555666']) {
      assert.ok(ids.includes(wanted), `缺少 ${wanted}`);
    }
    assert.ok(!ids.includes('1483638708'), '自己的 B站 mid 不该被拦（那是公开资料）');
  });

  test('assertOutboundIdentitySafe：泄露就抛，干净就放行', () => {
    assert.throws(() => assertOutboundIdentitySafe('看主人的空间 37634003', { surface: 'B站 评论', surfcoreDir: temp }), /B站 评论/);
    assert.throws(() => assertOutboundIdentitySafe('QQ 111222333', { surface: 'B站 私信', surfcoreDir: temp }), /B站 私信/);
    assert.equal(assertOutboundIdentitySafe('这视频真好看，2026 年还能看到', { surfcoreDir: temp }).ok, true);
    assert.equal(assertOutboundIdentitySafe('我的空间 space.bilibili.com/1483638708', { surfcoreDir: temp }).ok, true);
  });
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

// ── 接线：改了规则却没接进发送路径 = 白改 ────────────────────────────────────
test('B站 写操作（评论/私信/动态/分享）都接了身份闸', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const files = {
    'comment.mjs': 'B站 评论',
    'dm.mjs': 'B站 私信',
    'dynamic.mjs': 'B站 动态',
    'share-dynamic.mjs': 'B站 动态',
  };
  for (const [file, surface] of Object.entries(files)) {
    const source = fs.readFileSync(path.join(root, 'plugins', 'surfcore', 'tools', 'commands', file), 'utf8');
    assert.ok(source.includes("from '../lib/outbound-guard.mjs'"), `${file} 没有引用身份闸`);
    assert.ok(source.includes('assertOutboundIdentitySafe'), `${file} 没有调用身份闸`);
    assert.ok(source.includes(surface), `${file} 没有标明 surface=${surface}`);
  }
});

if (failures) process.exitCode = 1;
console.log(failures ? `\n${failures} 项失败` : '\nidentity guard tests OK');

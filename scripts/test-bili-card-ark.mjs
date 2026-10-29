// B站分享：默认发文本链接，不再发 QQ 卡片。
//
// 两次真机反馈把路走死：
//   1. 小程序卡片（get_mini_app_ark，appid 1109937557）→ 点开「小程序已下架」；
//   2. structmsg 新闻卡（自己拼 ARK，各种 ver 都试过）→ QQ 显示「发送者版本过低，无法展示内容」，
//      连 SnowLuma 自带的 share 段也一样。
// 结论：这个发送端发不了 structmsg 卡片，默认只能发「【B站】标题 + 链接」文本。
//
// 这里钉住（纯函数 + 注入假通道，不发网络）：
//   1. 默认模式是 text，旧 card:true / cardMode:'link' 都要收敛到 text；
//   2. text 模式发的是 text 段（含标题和链接），**不能**发 json 卡片，也不调小程序接口；
//   3. miniapp 是 opt-in，失败要退回文本；文本也失败才返回 false；
//   4. 桥接/插件接线不能被改回「卡片默认」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CARD_MODES, normalizeCardMode, httpsifyImage, buildBiliCardArk, buildBiliShareText, createBiliCardSender,
} from '../src/bili-card.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BV = 'BV1JaJo6jEqH';

// ── 1. 模式收敛 ────────────────────────────────────────────────────────────
assert.deepEqual(CARD_MODES, ['off', 'text', 'miniapp']);
assert.equal(normalizeCardMode(undefined), 'text', '没配置时默认文本链接');
assert.equal(normalizeCardMode({}), 'text');
assert.equal(normalizeCardMode({ card: true }), 'text', '旧 card:true 升级成文本链接');
assert.equal(normalizeCardMode({ card: false }), 'off');
assert.equal(normalizeCardMode({ card: false, cardMode: 'text' }), 'text', '显式 cardMode 优先');
assert.equal(normalizeCardMode({ cardMode: 'link' }), 'text', '旧中间值 link 收敛成 text');
assert.equal(normalizeCardMode({ cardMode: 'TEXT' }), 'text', '大小写不敏感');
assert.equal(normalizeCardMode({ cardMode: 'miniapp' }), 'miniapp');
assert.equal(normalizeCardMode({ cardMode: 'mini app' }), 'text', '拼错就回默认，不要静默变 off');
assert.equal(normalizeCardMode({ cardMode: 'off' }), 'off');

// ── 2. 分享文本 ────────────────────────────────────────────────────────────
assert.equal(
  buildBiliShareText({ title: ' 标题\n带换行 ', jumpUrl: `https://www.bilibili.com/video/${BV}` }),
  `【B站】标题 带换行\nhttps://www.bilibili.com/video/${BV}`,
);
assert.match(buildBiliShareText({}), /^【B站】B站视频$/);

// ── 3. https 化封面 + ARK 形状（诊断用，生产不走）──────────────────────────
assert.equal(httpsifyImage('http://i0.hdslb.com/a.jpg'), 'https://i0.hdslb.com/a.jpg');
const ark = buildBiliCardArk({
  bvid: BV,
  title: '测试 标题\n带换行',
  desc: '  描述   多空格  ',
  pic: 'http://i0.hdslb.com/cover.jpg',
  ctime: 1_700_000_000_000,
});
assert.equal(ark.app, 'com.tencent.structmsg');
assert.equal(ark.view, 'news');
assert.equal(ark.meta.news.preview, 'https://i0.hdslb.com/cover.jpg');
assert.equal(ark.meta.news.jumpUrl, `https://www.bilibili.com/video/${BV}`);
assert.equal(ark.prompt, '[分享] 测试 标题 带换行');

// ── 4. 默认文本链接：不发 json、不碰小程序接口 ─────────────────────────────
{
  const sent = [];
  let miniCalls = 0;
  const send = createBiliCardSender({
    getShare: () => ({ card: true }), // 旧配置
    requestMiniArk: async () => { miniCalls += 1; throw new Error('不该被调用'); },
    sendGroupSegments: async (id, segments) => { sent.push({ id, segments }); },
    log: () => {},
  });
  const ok = await send('group:767098733', { bvid: BV, title: '标题', pic: 'http://i0.hdslb.com/c.jpg', reason: '好看' });
  assert.equal(ok, true);
  assert.equal(miniCalls, 0, 'text 模式绝不能调 get_mini_app_ark');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, '767098733');
  assert.equal(sent[0].segments.length, 1);
  assert.equal(sent[0].segments[0].type, 'text', '默认路径必须是纯文本，不是 json 卡片');
  assert.match(sent[0].segments[0].data.text, /【B站】标题/);
  assert.match(sent[0].segments[0].data.text, new RegExp(`https://www\\.bilibili\\.com/video/${BV}`));
}

// ── 5. 关掉：一条都不发 ────────────────────────────────────────────────────
{
  let calls = 0;
  const send = createBiliCardSender({
    getShare: () => ({ card: false }),
    sendGroupSegments: async () => { calls += 1; },
  });
  assert.equal(await send('group:1', { bvid: BV, title: 't' }), false);
  assert.equal(calls, 0);
}

// ── 6. miniapp 是 opt-in：会调接口、会缓存；失败退回文本 ───────────────────
{
  const sent = [];
  let miniCalls = 0;
  const send = createBiliCardSender({
    getShare: () => ({ cardMode: 'miniapp' }),
    requestMiniArk: async () => { miniCalls += 1; return { app: 'com.tencent.miniapp_01', meta: { detail_1: {} } }; },
    sendGroupSegments: async (id, segments) => { sent.push({ id, segments }); },
    now: () => 1_700_000_000_000,
  });
  const card = { bvid: BV, title: 't', pic: 'https://i0.hdslb.com/c.jpg' };
  assert.equal(await send('group:1', card), true);
  assert.equal(await send('group:2', card), true);
  assert.equal(miniCalls, 1, '同一个 bvid 5 分钟内复用 ARK');
  assert.equal(sent[0].segments[0].data.data.app, 'com.tencent.miniapp_01');
}
{
  const sent = [];
  const logs = [];
  const send = createBiliCardSender({
    getShare: () => ({ cardMode: 'miniapp' }),
    requestMiniArk: async () => { throw new Error('小程序接口挂了'); },
    sendGroupSegments: async (id, segments) => { sent.push({ id, segments }); },
    log: (...args) => logs.push(args.join(' ')),
  });
  assert.equal(await send('group:1', { bvid: BV, title: 't', pic: 'https://i0.hdslb.com/c.jpg' }), true);
  assert.equal(sent.at(-1).segments[0].type, 'text', '小程序失败要退回文本链接');
  assert.ok(logs.some((line) => line.includes('小程序卡片失败')));
}

// ── 7. 文本也发不出去 → false（不再发第二张卡）────────────────────────────
{
  let calls = 0;
  const logs = [];
  const send = createBiliCardSender({
    getShare: () => ({ cardMode: 'text' }),
    sendGroupSegments: async () => { calls += 1; throw new Error('全挂'); },
    log: (...args) => logs.push(args.join(' ')),
  });
  assert.equal(await send('group:1', { bvid: BV, title: 't', pic: 'https://i0.hdslb.com/c.jpg' }), false);
  assert.equal(calls, 1, '失败后不要偷偷改发别的卡片');
  assert.ok(logs.some((line) => line.includes('链接文本发送失败')));
}

// ── 8. 输入校验：私聊/坏群号/坏 bvid 不发 ──────────────────────────────────
{
  let calls = 0;
  const send = createBiliCardSender({
    getShare: () => ({ cardMode: 'text' }),
    sendGroupSegments: async () => { calls += 1; },
  });
  assert.equal(await send('private:1', { bvid: BV, title: 't' }), false);
  assert.equal(await send('group:abc', { bvid: BV, title: 't' }), false);
  assert.equal(await send('group:1', { bvid: 'BV123', title: 't' }), false);
  assert.equal(calls, 0);
}

// ── 9. 缺标题：用 fetchVideoInfo 补 ────────────────────────────────────────
{
  const sent = [];
  const send = createBiliCardSender({
    getShare: () => ({ cardMode: 'text' }),
    fetchVideoInfo: async () => ({ title: '补来的标题', pic: 'http://i0.hdslb.com/x.jpg' }),
    sendGroupSegments: async (id, segments) => { sent.push(segments); },
  });
  assert.equal(await send('group:1', { bvid: BV }), true);
  assert.match(sent[0][0].data.text, /补来的标题/);
}

// ── 10. 接线：桥接用这个 sender；插件代理必须带 JSON body（PITFALLS #23）────
{
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  assert.match(bridge, /createBiliCardSender\(/, 'sendBiliCard 必须走 createBiliCardSender');
  assert.ok(!bridge.includes('biliCardCache'), '旧的 biliCardCache 已搬进 bili-card.js，不能留两份');
  assert.match(bridge, /normalizeCardMode\(/, 'config 收敛必须用同一个 normalizeCardMode');
  assert.match(bridge, /cardMode:\s*(shareCardMode|normalizeCardMode)/, 'config 收敛必须带 cardMode');
  const pluginIndex = fs.readFileSync(path.join(ROOT, 'plugins', 'surfcore', 'lib', 'index.js'), 'utf8');
  assert.match(pluginIndex, /\/api\/bili\/share-now', \{ method: 'POST', body: \{\}/, '分享代理必须带 JSON body');
}

console.log('test-bili-card-ark: 全部通过');

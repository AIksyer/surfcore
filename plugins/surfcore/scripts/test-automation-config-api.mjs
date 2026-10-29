/**
 * 设置页保存链路（额度 / 四类动态 / QQ 视频分享）端到端：
 *   GET /config → 有 limits/dynamics；
 *   POST /config → 落盘并收敛；
 *   GET /bili/automation → 快照能读到刚改的值。
 *
 * 全程临时 DSH_HOME / QQBOT_ROOT，不碰真实配置。
 * 运行：node scripts/test-automation-config-api.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-auto-api-root-'));
const tempDsh = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-auto-api-dsh-'));
const tempState = path.join(tempDsh, 'surfcore');
fs.mkdirSync(path.join(tempRoot, 'src'), { recursive: true });
fs.mkdirSync(tempState, { recursive: true });
fs.writeFileSync(path.join(tempRoot, 'src', 'bridge.js'), '// fixture\n');
fs.writeFileSync(path.join(tempRoot, 'config.json'), JSON.stringify({
  ownerQQ: '10001',
  allow: { private: ['10001'], groups: ['767098733'] },
  biliBridge: {
    enabled: true,
    share: { enabled: true, times: ['09:00'], groups: [], gapMs: 4000, card: true, cardMode: 'miniapp' },
    dynamics: { enabled: true, pollIntervalMs: 180000, groups: [] },
  },
}, null, 2));
fs.writeFileSync(path.join(tempState, 'bili.config.json'), JSON.stringify({
  owner: { mid: '20002', name: '测试B站昵称' },
  quota: { shareDaily: 4 },
  limits: { daily: 12, globalMin: 3 },
  dynamics: { gapMin: 20, kinds: { anime: { slot: 15 } } },
}, null, 2));
fs.writeFileSync(path.join(tempState, 'config.json'), JSON.stringify({ version: 1 }, null, 2));

process.env.SURFCORE_ROOT = tempRoot;
process.env.DSH_HOME = tempDsh;
process.env.USERPROFILE = tempDsh;
process.env.SURFCORE_SKIP_AUTOSTART = '1';
process.env.SURFCORE_DISABLE_CHARACTER_MIGRATION = '1';
process.env.SURFCORE_DISABLE_MEMORY_TIMER = '1';

const { apply } = await import('../lib/index.js');

const routes = [];
const effects = [];
const ctx = {
  webServer: { register(route) { routes.push(route); return () => {}; } },
  get(name) { return name === 'connection' ? { requestRejection: () => false } : null; },
  effect(fn) { effects.push(fn); return () => {}; },
  sessionController: {
    inspect: async () => ({ events: [] }),
    create: async () => ({}),
    prompt: async () => ({ accepted: true }),
  },
  settings: null,
};
apply(ctx);

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers ?? {}; },
    end(body = '') { this.body += body; },
  };
}
function fakeReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:58750', ...(body ? { 'content-type': 'application/json' } : {}) };
  if (body) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  }
  return req;
}
async function invoke(method, p, body) {
  const route = routes.find((r) => r.path === '/dsh-surfcore/api');
  const res = fakeRes();
  await route.handler(fakeReq(method, `/dsh-surfcore/api${p}`, body), res);
  return { status: res.statusCode, data: JSON.parse(res.body || '{}') };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const qqFile = path.join(tempRoot, 'config.json');
const biliFile = path.join(tempState, 'bili.config.json');

try {
  // ① GET /config：两组可编辑项要在
  const config = await invoke('GET', '/config');
  assert.equal(config.status, 200);
  assert.equal(config.data.bili.limits.daily, 12);
  assert.equal(config.data.bili.limits.replyDaily, 50, '没写的额度要有默认值');
  assert.equal(config.data.bili.dynamics.kinds.anime.slot, 15);
  assert.equal(config.data.bili.dynamics.kinds.best.slot, 8, '没写的类要有默认值');
  assert.deepEqual(config.data.qq.biliBridge.share.times, ['09:00']);
  assert.equal(config.data.qq.biliBridge.share.cardMode, 'miniapp', '卡片样式要能读回来');

  // ② POST /config：按设置页的方式整体保存 bili + qq
  const bili = readJson(biliFile);
  bili.limits = { ...bili.limits, daily: 8, taDaily: -3, minePerPerson: 2 };
  bili.dynamics = { enabled: true, gapMin: 15, kinds: { ...bili.dynamics.kinds, best: { slot: 7, minLen: 30, maxLen: 120, prefix: '【早】' } } };
  const qq = readJson(qqFile);
  qq.biliBridge.share.times = ['20:00', '8:00', '99:99'];
  qq.biliBridge.share.groups = ['767098733'];
  qq.biliBridge.share.gapMs = 1234;
  qq.biliBridge.share.cardMode = 'off';
  const saved = await invoke('POST', '/config', { bili, qq });
  assert.equal(saved.status, 200, JSON.stringify(saved.data).slice(0, 300));
  assert.equal(saved.data.saved.bili, true);
  assert.equal(saved.data.saved.qq, true);

  const diskBili = readJson(biliFile);
  assert.equal(diskBili.limits.daily, 8);
  assert.equal(diskBili.limits.taDaily, 0, '负数要收敛到 0');
  assert.equal(diskBili.limits.minePerPerson, 2);
  assert.equal(diskBili.dynamics.gapMin, 15);
  assert.equal(diskBili.dynamics.kinds.best.slot, 7);
  assert.equal(diskBili.dynamics.kinds.best.minLen, 30);
  assert.equal(diskBili.dynamics.kinds.best.prefix, '【早】');

  const diskQq = readJson(qqFile);
  assert.deepEqual(diskQq.biliBridge.share.times, ['08:00', '20:00'], '时间点要规范化/排序，非法项丢弃');
  assert.equal(diskQq.biliBridge.share.gapMs, 1234);
  assert.deepEqual(diskQq.biliBridge.share.groups, ['767098733']);
  assert.equal(diskQq.biliBridge.share.cardMode, 'off', '卡片样式要落盘');
  assert.equal(diskQq.biliBridge.share.card, false, 'card 是派生值：off 时必须是 false');

  // ③ GET /bili/automation：快照读到刚保存的值
  const snap = await invoke('GET', '/bili/automation');
  assert.equal(snap.status, 200);
  assert.equal(snap.data.limits.daily, 8);
  assert.equal(snap.data.limits.taDaily, 0);
  assert.equal(snap.data.dynamics.gapMin, 15);
  assert.equal(snap.data.dynamics.kinds.find((k) => k.key === 'best').slot, 7);
  assert.deepEqual(snap.data.qqShare.times, ['08:00', '20:00']);
  assert.equal(snap.data.qqShare.gapMs, 1234);
  assert.equal(snap.data.qqShare.cardMode, 'off', '快照要带卡片样式，UI 才能显示对不对');
  assert.equal(snap.data.qqShare.card, false);

  console.log('automation config API tests OK');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const fn of effects) {
    try {
      const dispose = fn();
      if (typeof dispose === 'function') dispose();
    } catch {}
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.rmSync(tempDsh, { recursive: true, force: true });
}
// 调度器可能还挂着 60s tick；测完主动退出（退出码反映断言结果）。
process.exit(process.exitCode ?? 0);


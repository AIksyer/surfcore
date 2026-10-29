/**
 * 对齐「称呼（label）」的端到端回归（临时目录，不碰真实配置）。
 *
 * 用户要的是：给某个人指定 QQ 号 + B站 UID + 称呼，以后 QQ / B站 都只叫这个称呼，
 * 不再出现「叫 QQ 名 / B站名」的尴尬。光测字符串不够——要确认：
 *   1. /align 的 add / update 真的把 label 落进 alignments.json；
 *   2. QQ 侧简报带称呼 + QQ 号（只能按 ID 对，不能靠会变的群昵称）；
 *   3. B站 侧简报带称呼，但**仍然不出现 QQ 号**；
 *   4. 清掉称呼后，简报回到旧格式（不残留“只叫这个”规则）。
 *
 * 运行：node scripts/test-align-label-api.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-align-root-'));
const tempDsh = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-align-dsh-'));
const tempState = path.join(tempDsh, 'surfcore');
fs.mkdirSync(path.join(tempRoot, 'src'), { recursive: true });
fs.mkdirSync(path.join(tempRoot, 'roles'), { recursive: true });
fs.mkdirSync(tempState, { recursive: true });
fs.writeFileSync(path.join(tempRoot, 'src', 'bridge.js'), '// fixture bridge placeholder\n');
fs.writeFileSync(path.join(tempRoot, 'roles', '角色.md'), '# 角色卡\n\n测试用。\n');
fs.writeFileSync(path.join(tempRoot, 'config.json'), JSON.stringify({
  ownerQQ: '10001',
  allow: { private: ['10001'], groups: ['767098733'] },
  consoleToken: 'fixture-console-token',
}, null, 2));
fs.writeFileSync(path.join(tempState, 'bili.config.json'), JSON.stringify({
  owner: { mid: '20002', name: '测试B站昵称' },
}, null, 2));
fs.writeFileSync(path.join(tempState, 'config.json'), JSON.stringify({ version: 1 }, null, 2));

process.env.SURFCORE_ROOT = tempRoot;
process.env.DSH_HOME = tempDsh;
process.env.USERPROFILE = tempDsh;
process.env.SURFCORE_SKIP_AUTOSTART = '1';
process.env.SURFCORE_DISABLE_CHARACTER_MIGRATION = '1';

const { apply } = await import('../lib/index.js');
const { QQ_ALIGNMENT_BRIEF, BILI_ALIGNMENT_FILE } = await import('../lib/paths.js');

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
const readFile = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

try {
  // 1) 手动添加：QQ 号 + B站 UID + 称呼，一次落盘。
  const added = await invoke('POST', '/align', {
    action: 'add',
    link: {
      identities: {
        qq: { id: '10001', name: '阿零', groups: ['767098733'] },
        bili: { id: '87654321', name: '零酱' },
      },
      label: '小零',
      source: 'manual',
      confidence: 1,
      verified: true,
    },
  });
  assert.equal(added.status, 200);
  assert.equal(added.data.link.label, '小零', 'add 的返回必须带称呼');

  const list = await invoke('GET', '/align');
  assert.equal(list.data.links.length, 1);
  assert.equal(list.data.links[0].label, '小零', '/align 列表必须带称呼');
  assert.equal(list.data.stats.labels, 1, '统计里要有已设称呼数量');

  const stored = readJson(path.join(tempState, 'alignments.json'));
  assert.equal(stored.links[0].label, '小零', '称呼必须落进 alignments.json');

  // 2) QQ 侧简报：带称呼、带 QQ 号（按 ID 对上），并明确“只叫这个”。
  const qqBrief = readFile(QQ_ALIGNMENT_BRIEF);
  assert.ok(qqBrief.includes('小零'), 'QQ 简报必须带称呼');
  assert.ok(qqBrief.includes('以后只叫 TA「小零」'), 'QQ 简报必须写明只用称呼');
  assert.ok(qqBrief.includes('10001'), '有称呼时 QQ 简报要带 QQ 号，别靠会变的群昵称');
  assert.ok(qqBrief.includes('优先于人格卡'), '称呼规则要高于人格卡称呼表');
  assert.ok(qqBrief.includes('绝对不要念出来'), '带号码时必须重申不要念号码');

  // 3) B站 侧简报：带称呼，但不出现 QQ 号。
  const biliBrief = readFile(BILI_ALIGNMENT_FILE);
  assert.ok(biliBrief.includes('小零'), 'B站 简报必须带称呼');
  assert.ok(biliBrief.includes('以后只叫 TA「小零」'));
  assert.ok(!biliBrief.includes('10001'), 'B站 简报不能出现 QQ 号');

  // 4) 表格里改称呼：update 只改 label，身份不动，简报立刻重建。
  const updated = await invoke('POST', '/align', { action: 'update', id: added.data.link.id, link: { label: '小零酱' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.link.label, '小零酱');
  assert.equal(updated.data.link.identities.qq.id, '10001', '改称呼不能改掉身份');
  assert.ok(readFile(QQ_ALIGNMENT_BRIEF).includes('小零酱'), '改称呼后 QQ 简报要重建');
  assert.ok(!readFile(BILI_ALIGNMENT_FILE).includes('以后只叫 TA「小零」'), '旧称呼不能残留在 B站 简报');

  // 5) 清掉称呼：回到旧格式，不再注入“只叫这个”规则。
  const cleared = await invoke('POST', '/align', { action: 'update', id: added.data.link.id, link: { label: '' } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.link.label, '');
  const qqAfterClear = readFile(QQ_ALIGNMENT_BRIEF);
  assert.ok(!qqAfterClear.includes('以后只叫'), '清掉后不能残留称呼规则');
  assert.ok(!qqAfterClear.includes('10001'), '清掉后 QQ 简报回到不带 QQ 号的旧格式');
  assert.ok(qqAfterClear.includes('按群昵称认人'), '清掉后回到按昵称认人');

  // 6) 只有 QQ、没有 B站：也能设称呼，只出现在 QQ 侧简报。
  const qqOnly = await invoke('POST', '/align', {
    action: 'add',
    link: { identities: { qq: { id: '10002', name: '阿零2' } }, label: '小二', source: 'manual', confidence: 1, verified: true },
  });
  assert.equal(qqOnly.status, 200);
  assert.equal(qqOnly.data.link.label, '小二');
  const qqBriefWithOnly = readFile(QQ_ALIGNMENT_BRIEF);
  assert.ok(qqBriefWithOnly.includes('小二'), '只有 QQ 的人也要进 QQ 简报');
  assert.ok(qqBriefWithOnly.includes('10002'), '只有 QQ 的人按 QQ 号对上');
  assert.ok(qqBriefWithOnly.includes('只在 QQ 登记'), '要明确这是“只有 QQ”的登记');
  assert.ok(!readFile(BILI_ALIGNMENT_FILE).includes('小二'), '只有 QQ 的人不能进 B站 简报');

  // 7) 只有 B站、没有 QQ：也能设称呼，只出现在 B站 侧简报。
  const biliOnly = await invoke('POST', '/align', {
    action: 'add',
    link: { identities: { bili: { id: '87654322', name: '孤鱼' } }, label: '小鱼', source: 'manual', confidence: 1, verified: true },
  });
  assert.equal(biliOnly.status, 200);
  assert.equal(biliOnly.data.link.label, '小鱼');
  const biliBriefWithOnly = readFile(BILI_ALIGNMENT_FILE);
  assert.ok(biliBriefWithOnly.includes('小鱼'), '只有 B站 的人也要进 B站 简报');
  assert.ok(biliBriefWithOnly.includes('87654322'), '只有 B站 的人按 mid 对上');
  assert.ok(biliBriefWithOnly.includes('只在 B站 登记'), '要明确这是“只有 B站”的登记');
  assert.ok(!readFile(QQ_ALIGNMENT_BRIEF).includes('小鱼'), '只有 B站 的人不能进 QQ 简报');
  assert.ok(!biliBriefWithOnly.includes('10002'), 'B站 简报仍然不能出现 QQ 号');

  // 8) 后补另一边：补齐后把同一 QQ 的单边旧记录合并成一条，旧称呼继承，不留两条互相打架。
  const upgraded = await invoke('POST', '/align', {
    action: 'add',
    link: {
      identities: { qq: { id: '10002', name: '阿零2' }, bili: { id: '99999999', name: '零酱2' } },
      source: 'manual', confidence: 1, verified: true,
    },
  });
  assert.equal(upgraded.status, 200);
  assert.equal(upgraded.data.link.label, '小二', '补齐 B站 后要继承之前的称呼');
  const mergedList = await invoke('GET', '/align');
  assert.equal(mergedList.data.links.length, 3, '三条：原双边 + 只有 B站 + 补齐后的双边');
  assert.equal(mergedList.data.links.some((l) => l.identities?.qq?.id === '10002' && !l.identities?.bili), false, '同一 QQ 的单边旧记录应被合并掉');
  assert.ok(mergedList.data.links.some((l) => l.identities?.qq?.id === '10002' && l.identities?.bili?.id === '99999999'), '补齐后的双边记录要留下');
  assert.equal(mergedList.data.stats.labels, 2);
  const mergedQqBrief = readFile(QQ_ALIGNMENT_BRIEF);
  assert.ok(mergedQqBrief.includes('99999999'), '补齐后走跨平台的 B站 mid 行');
  assert.ok(mergedQqBrief.includes('以后只叫 TA「小二」'), '补齐后称呼仍在');
  assert.ok(!mergedQqBrief.includes('只在 QQ 登记'), '补齐后不应再有“只在 QQ 登记”的小节');
  assert.ok(!readFile(BILI_ALIGNMENT_FILE).includes('10002'), 'B站 简报仍然不能出现 QQ 号');

  console.log('align label API tests OK');
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
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tempDsh, { recursive: true, force: true }); } catch {}
}
process.exit(process.exitCode ?? 0);

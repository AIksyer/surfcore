// 语音包（无 package.json、无 release）也能被「检查更新」查到：
// 有 .installed-meta.json 时按远端 main 的 commit 比对；没有时按版本号比对并说明。
// 2026-10-29：改为**本地 stub fetch**，不再依赖真实 GitHub（未认证 60/h 会被测试打满）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { inspectComponent, writeInstalledMeta } from '../lib/updates.js';

const REMOTE_SHA = '1ad2042aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/commits/main')) return new Response(JSON.stringify({ sha: REMOTE_SHA }), { status: 200 });
  if (u.includes('/contents/package.json')) {
    const content = Buffer.from(JSON.stringify({ version: '0.1.1' }), 'utf8').toString('base64');
    return new Response(JSON.stringify({ content }), { status: 200 });
  }
  return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-upd-voice-'));
try {
  const dir = path.join(tmp, 'voice-local');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '0.1.0' }));

  // 1) 有 meta（sha 故意写错）→ 应可查，且提示有新提交
  writeInstalledMeta(dir, { version: '0.1.0', sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
  const withMeta = await inspectComponent({
    id: 'surfvoice-local', name: '语音包（本地）', dir, kind: 'auto', versionRepo: 'Mieksido/surfvoicelocal',
  }, { fetch: true });
  console.log('withMeta:', JSON.stringify({ available: withMeta.available, status: withMeta.status, reason: withMeta.reason, update: withMeta.updateAvailable }));
  assert.equal(withMeta.available, true, '有 meta 时应可查');
  assert.equal(withMeta.updateAvailable, true, 'sha 不一致应提示有更新');
  assert.equal(withMeta.status, 'update', '状态应为 update');

  // 2) 没有 meta → 仍可查（按版本号比对），不应报"读不到 package.json"
  fs.rmSync(path.join(dir, '.installed-meta.json'), { force: true });
  const noMeta = await inspectComponent({
    id: 'surfvoice-local', name: '语音包（本地）', dir, kind: 'auto', versionRepo: 'Mieksido/surfvoicelocal',
  }, { fetch: true });
  console.log('noMeta:', JSON.stringify({ available: noMeta.available, status: noMeta.status, reason: noMeta.reason }));
  assert.equal(noMeta.available, true, '没有 meta 也应可查');
  assert.ok(!String(noMeta.reason).includes('package.json'), '不应再报读不到 package.json');
  assert.ok(['update', 'latest', 'unknown', 'blocked'].includes(noMeta.status), `状态应是三态之一（0.7.5 起含 blocked）：${noMeta.status}`);

  // 3) 目录里什么都没有 → 明确"还没装"
  const empty = path.join(tmp, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  const none = await inspectComponent({
    id: 'surfvoice-cloud', name: '语音包（云端）', dir: empty, kind: 'auto', versionRepo: 'Mieksido/surfvoicecloud',
  }, { fetch: true });
  console.log('empty:', JSON.stringify({ available: none.available, reason: none.reason }));
  assert.equal(none.available, false, '空目录应不可查');
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('✅ test-updates-voice 通过');

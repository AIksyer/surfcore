// 版本号通道的"能弹窗 + 能直接更新"回归：
//   · 没有 remote / 不是 git 仓库时，结果要进 pending（否则永远不弹更新提示）；
//   · apply() 对 version 通道要下载 zip 覆盖，而不是走 git fast-forward。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUpdatesService } from '../lib/updates.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfc-zip-upd-'));
const stateDir = path.join(dir, 'state');
fs.mkdirSync(stateDir, { recursive: true });
const pkgDir = path.join(dir, 'pkg');
fs.mkdirSync(pkgDir, { recursive: true });
fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ version: '0.4.6' }));
// 0.7.5 起无安装证据的目录会 blocked，不进 pending；这个用例要测“有证据的新版”。
fs.writeFileSync(path.join(pkgDir, '.installed-meta.json'), JSON.stringify({ version: '0.4.6' }));

const realFetch = global.fetch;
global.fetch = async (url) => {
  const text = String(url);
  if (text.includes('/releases/latest')) return { ok: true, json: async () => ({ tag_name: 'v0.4.8', html_url: 'https://example.test/v0.4.8' }) };
  return { ok: false, json: async () => ({}) };
};

const svc = createUpdatesService({
  stateDir,
  components: () => [{ id: 'surfcore', name: 'SurfCore 本体', dir: pkgDir, kind: 'git', branch: 'main', versionRepo: 'Mieksido/surfcore' }],
  pluginLog: () => {},
});

await svc.check({ fetch: true });
const st = svc.status();
const row = (st.results ?? []).find((x) => x.id === 'surfcore');
assert.ok(row, '应该有 surfcore 这一行结果');
assert.equal(row.available, true, '没有 remote 也要能查（降级到版本号）');
assert.equal(row.latestVersion, '0.4.8');
assert.equal(row.updateAvailable, true);
assert.equal(st.pending.length, 1, '有新版时必须进 pending（决定是否弹窗）');
assert.equal(st.showPrompt, true, 'showPrompt 必须为 true');

// dismiss 之后不该再提示；换版本后重新提示
svc.dismiss();
assert.equal(svc.status().pending.length, 0, 'dismiss 后不再提示');
global.fetch = async (url) => {
  const text = String(url);
  if (text.includes('/releases/latest')) return { ok: true, json: async () => ({ tag_name: 'v0.5.0', html_url: 'https://example.test/v0.5.0' }) };
  return { ok: false, json: async () => ({}) };
};
await svc.check({ fetch: true });
assert.equal(svc.status().pending.length, 1, '远端再前进时应重新提示');

global.fetch = realFetch;
fs.rmSync(dir, { recursive: true, force: true });
console.log('✅ 版本号通道弹窗/更新判定通过');

// 版本号检查（不依赖 git）：zip 安装 / 开发副本也能知道"最新是多少"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectComponent, inspectVersionComponent } from '../lib/updates.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfc-upd-ver-'));
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.4.6' }));
// 0.7.5 起：没有安装证据的目录会被 blocked（不能自动覆盖）；这个用例要测
// “有证据 + 有新版 → 给下载地址”，所以补一份安装记录。
fs.writeFileSync(path.join(dir, '.installed-meta.json'), JSON.stringify({ version: '0.4.6' }));

const realFetch = global.fetch;

// 1) 远端更新 → 应该报有更新，并带下载地址
global.fetch = async (url) => {
  if (String(url).includes('/releases/latest')) {
    return { ok: true, json: async () => ({ tag_name: 'v0.4.7', html_url: 'https://example.test/v0.4.7' }) };
  }
  return { ok: false, json: async () => ({}) };
};
{
  const r = await inspectVersionComponent({ id: 'surfcore', name: '本体', dir, versionRepo: 'Mieksido/surfcore' }, { fetch: true });
  assert.equal(r.available, true);
  assert.equal(r.installedVersion, '0.4.6');
  assert.equal(r.latestVersion, '0.4.7');
  assert.equal(r.updateAvailable, true);
  assert.ok(r.downloadUrl);
}

// 2) 已是最新 → 不报更新
global.fetch = async () => ({ ok: true, json: async () => ({ tag_name: 'v0.4.6', html_url: 'https://example.test/v0.4.6' }) });
{
  const r = await inspectVersionComponent({ id: 'surfcore', name: '本体', dir, versionRepo: 'Mieksido/surfcore' }, { fetch: true });
  assert.equal(r.updateAvailable, false);
}

// 3) release 拿不到时退到 tags 接口
global.fetch = async (url) => {
  if (String(url).includes('/releases/latest')) return { ok: false, json: async () => ({}) };
  if (String(url).includes('/tags')) return { ok: true, json: async () => [{ name: 'v0.5.0' }] };
  return { ok: false, json: async () => ({}) };
};
{
  const r = await inspectVersionComponent({ id: 'surfcore', name: '本体', dir, versionRepo: 'Mieksido/surfcore' }, { fetch: true });
  assert.equal(r.latestVersion, '0.5.0');
  assert.equal(r.updateAvailable, true);
}

// 3b) Release 落后于 tag（只打了 tag 没发 Release）→ 取较高的 tag
global.fetch = async (url) => {
  if (String(url).includes('/releases/latest')) return { ok: true, json: async () => ({ tag_name: 'v0.4.8', html_url: 'https://example.test/048' }) };
  if (String(url).includes('/tags')) return { ok: true, json: async () => [{ name: 'v0.5.3' }, { name: 'v0.5.2' }] };
  return { ok: false, json: async () => ({}) };
};
{
  const r = await inspectVersionComponent({ id: 'surfcore', name: '本体', dir, versionRepo: 'Mieksido/surfcore' }, { fetch: true });
  assert.equal(r.latestVersion, '0.5.3', 'Release 落后时应取 tag 的较高版本');
  assert.equal(r.updateAvailable, true);
}

// 3c) 本地比发布版新 → 标 ahead，不报"有更新"
{
  const newer = fs.mkdtempSync(path.join(os.tmpdir(), 'sfc-upd-ahead-'));
  fs.writeFileSync(path.join(newer, 'package.json'), JSON.stringify({ version: '0.6.0' }));
  global.fetch = async (url) => {
    if (String(url).includes('/releases/latest')) return { ok: true, json: async () => ({ tag_name: 'v0.5.3', html_url: 'x' }) };
    if (String(url).includes('/tags')) return { ok: true, json: async () => [{ name: 'v0.5.3' }] };
    return { ok: false, json: async () => ({}) };
  };
  const r = await inspectVersionComponent({ id: 'surfcore', name: '本体', dir: newer, versionRepo: 'Mieksido/surfcore' }, { fetch: true });
  assert.equal(r.updateAvailable, false);
  assert.equal(r.ahead, true, '本地领先应标 ahead');
  fs.rmSync(newer, { recursive: true, force: true });
}

// 4) 没有 versionRepo → 明确说不可查，而不是崩
{
  const r = await inspectVersionComponent({ id: 'x', name: 'x', dir }, { fetch: true });
  assert.equal(r.available, false);
}

// 5) git 目录没有 remote 时，inspectComponent 要回退到版本号检查（不是直接报"没有 origin remote"）
global.fetch = async () => ({ ok: true, json: async () => ({ tag_name: 'v9.9.9', html_url: 'https://example.test/9' }) });
{
  const r = await inspectComponent({ id: 'surfcore', name: '本体', dir, kind: 'git', branch: 'main', versionRepo: 'Mieksido/surfcore' }, { fetch: true });
  assert.equal(r.available, true);
  assert.equal(r.latestVersion, '9.9.9');
  assert.equal(r.updateAvailable, true);
  assert.ok(r.gitReason, '应保留 git 侧的失败原因');
}

global.fetch = realFetch;
fs.rmSync(dir, { recursive: true, force: true });
console.log('✅ 版本号更新检查通过');

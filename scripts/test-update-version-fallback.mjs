// 回归：检查更新必须给出三种明确结果（有更新 / 已是最新 / 查不到），
// 且没有安装记录时按版本号判断，不得直接说"最新"（2026-10-29 事故）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REMOTE_SHA = '1ad2042aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

let seq = 0;
function stubFetch({ sha = REMOTE_SHA, version = '0.7.0', mode = 'ok', seen = [] } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers ?? {} });
    const u = String(url);
    if (mode === 'down') throw new Error('network down');
    if (mode === 'ratelimit' && u.includes('api.github.com')) {
      return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403 });
    }
    if (u.includes('/commits/main')) {
      if (!sha) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ sha }), { status: 200 });
    }
    if (u.includes('/contents/package.json')) {
      if (!version) return new Response('{}', { status: 404 });
      const content = Buffer.from(JSON.stringify({ name: 'surfcore', version }), 'utf8').toString('base64');
      return new Response(JSON.stringify({ content, encoding: 'base64' }), { status: 200 });
    }
    if (u.includes('releases/latest') || u.includes('/releases') || u.includes('/tags')) {
      return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    }
    return new Response('{}', { status: 200 });
  };
  return () => { globalThis.fetch = real; };
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-upd-'));
let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label} ${extra}`); }
};

function makeInstall(name, version) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'surfcore', version }));
  return dir;
}

try {
  const { inspectVersionComponent, inspectGitComponent } = await import('../plugins/surfcore/lib/updates.js');

  // 用例 1：老安装（无 meta），本地 0.6.22，远端 0.7.0 → 有更新
  {
    const dir = makeInstall('old-install', '0.6.22');
    const repo = `Mieksido/t1-${seq += 1}`;
    const restore = stubFetch({ version: '0.7.0' });
    try {
      const r = await inspectVersionComponent({ versionRepo: repo, dir });
      ok(r.status === 'update', '无提交记录 + 远端更高 → status=update', JSON.stringify(r));
      ok(r.updateAvailable === true, 'updateAvailable=true');
      ok(r.latestVersion === '0.7.0', '目标版本显示 0.7.0 而不是提交号', String(r.latestVersion));
      ok(r.code === 'new-version', 'code=new-version', String(r.code));
    } finally { restore(); }
  }

  // 用例 2：无 meta、版本相同 → 已是最新（按版本号判断，并说明没有提交记录）
  {
    const dir = makeInstall('same-version', '0.7.0');
    const repo = `Mieksido/t2-${seq += 1}`;
    const restore = stubFetch({ version: '0.7.0' });
    try {
      const r = await inspectVersionComponent({ versionRepo: repo, dir });
      ok(r.status === 'latest', '版本相同 → status=latest', JSON.stringify(r));
      ok(r.code === 'UPDATE_NO_COMMIT_RECORD', '说明是按版本号判断的', String(r.code));
      ok(typeof r.hint === 'string' && r.hint.length > 0, '带 hint');
    } finally { restore(); }
  }

  // 用例 3：远端版本号取不到 → 查不到（不能当最新）
  {
    const dir = makeInstall('no-remote-version', '0.6.22');
    const repo = `Mieksido/t3-${seq += 1}`;
    const restore = stubFetch({ version: '' });
    try {
      const r = await inspectVersionComponent({ versionRepo: repo, dir });
      ok(r.status === 'unknown', '取不到远端版本号 → status=unknown', JSON.stringify(r));
      ok(r.updateAvailable === false, 'unknown 时不算有更新');
      ok(r.code === 'UPDATE_NO_REMOTE_VERSION', 'code 说明原因', String(r.code));
      ok(typeof r.hint === 'string' && r.hint.length > 0, '带下一步建议');
    } finally { restore(); }
  }

  // 用例 4：远端完全连不上（断网/限流）→ 查不到
  {
    const dir = makeInstall('offline', '0.6.22');
    const repo = `Mieksido/t4-${seq += 1}`;
    const restore = stubFetch({ sha: '', version: '', mode: 'down' });
    try {
      const r = await inspectVersionComponent({ versionRepo: repo, dir });
      ok(r.status === 'unknown', '断网 → status=unknown', JSON.stringify(r));
      ok(r.updateAvailable === false, '断网时不算有更新');
      ok(typeof r.hint === 'string' && r.hint.length > 0, '带下一步建议');
    } finally { restore(); }
  }

  // 用例 5：有提交记录且一致 → 已是最新
  {
    const dir = makeInstall('with-meta', '0.7.0');
    fs.writeFileSync(path.join(dir, '.installed-meta.json'), JSON.stringify({ version: '0.7.0', sha: REMOTE_SHA }));
    const repo = `Mieksido/t5-${seq += 1}`;
    const restore = stubFetch();
    try {
      const r = await inspectVersionComponent({ versionRepo: repo, dir });
      ok(r.status === 'latest', '提交一致 → status=latest');
      ok(r.code === 'up-to-date', 'code=up-to-date', String(r.code));
    } finally { restore(); }
  }

  // 用例 6：本机没有 git → 明确 unknown(no-git)，不能报"不是 git 仓库"
  {
    const dir = makeInstall('no-git', '0.6.22');
    const savedPath = process.env.PATH;
    const savedPath2 = process.env.Path;
    process.env.PATH = '';
    process.env.Path = '';
    try {
      const r = await inspectGitComponent({ id: 'surfcore', dir, kind: 'git' });
      ok(r.status === 'unknown', '没有 git → status=unknown', JSON.stringify(r));
      ok(r.code === 'no-git', 'code=no-git（不是 not-a-repo）', String(r.code));
      ok(!String(r.reason).includes('不是 git 仓库'), '文案不再误导成"不是 git 仓库"', String(r.reason));
    } finally {
      process.env.PATH = savedPath;
      if (savedPath2 !== undefined) process.env.Path = savedPath2;
    }
  }
  // 用例 6.5：可选 token → 请求带 Authorization；不带 token → 不带（匿名 60 次/小时）
  {
    const { setGitHubToken } = await import('../plugins/surfcore/lib/updates.js');
    const dir = makeInstall('token-case', '0.6.22');
    const repo = `Mieksido/t65-${seq += 1}`;
    const seen = [];

    setGitHubToken('ghp_testtoken123');
    let restore = stubFetch({ seen });
    try {
      await inspectVersionComponent({ versionRepo: repo, dir });
      const withAuth = seen.filter((x) => x.url.includes('api.github.com'));
      ok(withAuth.length > 0, 'token：确实请求了 api.github.com');
      ok(withAuth.every((x) => String(x.headers.Authorization ?? '') === 'Bearer ghp_testtoken123'),
        'token：每个 API 请求都带 Authorization', JSON.stringify(withAuth.map((x) => x.headers)));
    } finally { restore(); }

    seen.length = 0;
    setGitHubToken('');
    restore = stubFetch({ seen });
    try {
      await inspectVersionComponent({ versionRepo: repo, dir });
      const noAuth = seen.filter((x) => x.url.includes('api.github.com'));
      ok(noAuth.every((x) => !x.headers.Authorization), '无 token：不带 Authorization 头');
    } finally { restore(); }
  }

  // 用例 7：复刻事故现场——无 git、无 .installed-meta、本地 0.6.22、远端 0.7.0
  // 期望：inspectComponent 降级后按版本号判断 → status=update（不能是 latest）
  {
    const dir = makeInstall('incident-device', '0.6.22');
    const repo = `Mieksido/t7-${seq += 1}`;
    const savedPath = process.env.PATH;
    const savedPath2 = process.env.Path;
    process.env.PATH = '';
    process.env.Path = '';
    const restore = stubFetch({ version: '0.7.0' });
    try {
      const { inspectComponent } = await import('../plugins/surfcore/lib/updates.js');
      const r = await inspectComponent({ id: 'surfcore', name: 'SurfCore 本体', kind: 'git', dir, versionRepo: repo });
      ok(r.status === 'update', '事故现场 → status=update', JSON.stringify(r));
      ok(r.updateAvailable === true, '事故现场 → updateAvailable=true');
      ok(r.latestVersion === '0.7.0', '事故现场 → 目标版本 0.7.0');
      ok(String(r.gitReason ?? '').includes('git'), '保留 git 缺失说明', String(r.gitReason));
    } finally {
      restore();
      process.env.PATH = savedPath;
      if (savedPath2 !== undefined) process.env.Path = savedPath2;
    }
  }

} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n✅ test-update-version-fallback 通过');

// 云端语音包的凭据边界（纯离线：本地夹具目录，不下载、不启动任何语音服务）。
//
// 背景（2026-10-29）：voice-cloud / voice-local 的 `config.toml` 里长期放着开发机的
// 火山 AppID + AccessKey。仓库里只该有 `config.example.toml`，安装时会复制成
// `config.toml`；只要 example 里忘了清、或有人把开发目录打成 zip 发出去，
// **所有装包的用户都会用开发者的额度计费**。
//
// 这条测试钉四件事：
//   1. stripCloudCredentials 只清 cloud_app_id / cloud_access_key，其它配置/注释/CRLF 原样；
//   2. ensurePackConfig 新装清空凭据；重装（用户自己的 config.toml）原样保留；
//      「包里直接带了 config.toml 和密钥」这种 zip 也要清；
//   3. 真跑一次 install()（本地夹具目录、测试专用 id，不碰真实包）：装完没有凭据，
//      force 重装保住用户自己填的；
//   4. 云端包没配置时 list() 报 needsCloudConfig，start() 给可照做的提示
//      （而不是起一个 401 的服务）。
//
// 注意：安装/重装用的是测试 id `voice-cloud-fixture`。真实 id 会被 packDir() 的
// "已装到别处" 兜底认领到本机 `state/voice-packs/voice-cloud` —— 测试绝不能写那里。
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const {
  createVoicePacks, stripCloudCredentials, ensurePackConfig,
} = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'voice-packs.js')).href);

let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
};

// 临时目录里的文件刚写完就被 Windows Defender/索引器短暂占住 → EBUSY/EPERM，
// 或者目录项还没刷出来 → ENOENT。这是环境抖动，不是产品行为；重试一小会儿再判失败。
async function readTextRetry(file, { tries = 40, delayMs = 50 } = {}) {
  for (let i = 0; ; i += 1) {
    try { return await fsp.readFile(file, 'utf8'); }
    catch (error) {
      const code = String(error?.code || '');
      if (i >= tries || !/EBUSY|EPERM|EACCES|ENOENT/.test(code)) throw error;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

const EXAMPLE = `# 模板：真实密钥不入库
[server]
host = "127.0.0.1"
port = 8767
token = ""

[engine]
primary = "cloud"
cloud_app_id = "3773727341"
cloud_access_key = "0f74ZUsecretsecret"
cloud_resource = "seed-icl-2.0"
# 旧写法：cloud_access_key = "别把注释里的也当成真的"
`;

console.log('## 1. stripCloudCredentials 只动那两个键');
{
  const out = stripCloudCredentials(EXAMPLE);
  ok(out.includes('cloud_app_id = ""'), 'cloud_app_id 被清空');
  ok(out.includes('cloud_access_key = ""'), 'cloud_access_key 被清空');
  ok(out.includes('cloud_resource = "seed-icl-2.0"'), 'cloud_resource 原样保留（换别的会 403）');
  ok(out.includes('port = 8767') && out.includes('primary = "cloud"'), '其它配置原样保留');
  ok(out.includes('# 旧写法：cloud_access_key = "别把注释里的也当成真的"'), '注释行不被误伤');
  ok(!out.includes('3773727341') && !out.includes('0f74ZU'), '输出里不再有真实凭据');

  const crlf = EXAMPLE.split('\n').join('\r\n');
  const outCrlf = stripCloudCredentials(crlf);
  ok(outCrlf.includes('cloud_app_id = ""\r\n'), 'CRLF 文件改完仍是 CRLF（不吃掉 \\r）');
  ok((outCrlf.match(/\r\n/g) || []).length === (crlf.match(/\r\n/g) || []).length, 'CRLF 行数不变');

  const already = 'cloud_app_id = ""\ncloud_access_key = ""\n';
  ok(stripCloudCredentials(already) === already, '已经是空值时不产生改动');
}

console.log('## 2. ensurePackConfig：新装清凭据 / 重装保留用户配置');
const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'surfcore-voicecred-'));
try {
  {
    const dir = path.join(base, 'only-example');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'config.example.toml'), EXAMPLE, 'utf8');
    const r = await ensurePackConfig(dir);
    const text = await fsp.readFile(path.join(dir, 'config.toml'), 'utf8');
    ok(r.created === true && r.sanitized === true, '只有 example → 复制并清凭据');
    ok(!text.includes('0f74ZU') && text.includes('cloud_access_key = ""'), '新装配置里没有凭据');
  }
  {
    const dir = path.join(base, 'own-config');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'config.example.toml'), EXAMPLE, 'utf8');
    const own = 'cloud_app_id = "1234567890"\ncloud_access_key = "AKuser"\ncloud_resource = "seed-icl-2.0"\n';
    await fsp.writeFile(path.join(dir, 'config.toml'), own, 'utf8');
    const r = await ensurePackConfig(dir, { hadOwnConfig: true });
    const text = await fsp.readFile(path.join(dir, 'config.toml'), 'utf8');
    ok(r.sanitized === false && text === own, '重装时用户自己填的凭据原样保留');
  }
  {
    // 泄漏向量：有人把开发目录整个打成 zip，包里直接带 config.toml + 真 key。
    const dir = path.join(base, 'zip-with-config');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'config.toml'), EXAMPLE, 'utf8');
    const r = await ensurePackConfig(dir);
    const text = await fsp.readFile(path.join(dir, 'config.toml'), 'utf8');
    ok(r.sanitized === true && !text.includes('0f74ZU'), '包装里自带 config.toml + key → 也清空');
  }
  {
    const dir = path.join(base, 'nothing');
    await fsp.mkdir(dir, { recursive: true });
    await assert.rejects(() => ensurePackConfig(dir), /包里没有 config\.toml/);
    ok(true, '既没有 config.toml 也没有 example → 报原来那句可读错误');
  }

  console.log('## 3. install() 的接线：装完没有凭据，force 重装保住用户填的');
  const fixture = path.join(base, 'fixture-pack');
  await fsp.mkdir(path.join(fixture, 'voicepack'), { recursive: true });
  await fsp.writeFile(path.join(fixture, 'config.example.toml'), EXAMPLE, 'utf8');
  await fsp.writeFile(path.join(fixture, 'run.bat'), '@echo off\r\n', 'utf8');
  await fsp.writeFile(path.join(fixture, 'voicepack', 'keep.txt'), 'x', 'utf8');

  const cfg = {
    voicePacks: {
      dir: path.join(base, 'packs'),
      manifests: [{
        id: 'voice-cloud-fixture',
        name: '凭据边界夹具',
        url: fixture,
        port: 39876, // 别碰真实的 8765/8767
        postInstall: [],
        verifyDirs: [],
        repo: '',
      }],
    },
  };
  const vp = createVoicePacks(cfg);
  const wait = async (id, timeoutMs = 20000) => {
    const t0 = Date.now();
    for (;;) {
      const list = await vp.list();
      const p = (list.packs || []).find((x) => x.id === id);
      if (p?.install?.phase === '失败') return { failed: p.install.error || '安装失败' };
      if (p?.install?.phase === '完成' || (p?.installed && !p?.install)) return { ok: true, pack: p };
      if (Date.now() - t0 > timeoutMs) return { failed: '等待安装完成超时' };
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const packDir = path.join(base, 'packs', 'voice-cloud-fixture');
  const started = await vp.install('voice-cloud-fixture');
  ok(started?.ok === true, 'install() 已启动');
  const first = await wait('voice-cloud-fixture');
  ok(first.ok === true, `安装完成${first.ok ? '' : '：' + first.failed}`);
  {
    const text = await readTextRetry(path.join(packDir, 'config.toml'));
    ok(!text.includes('0f74ZU') && !text.includes('3773727341'), '装完的 config.toml 里没有任何预置凭据');
    ok(text.includes('cloud_resource = "seed-icl-2.0"'), 'cloud_resource 没被清掉');
  }

  console.log('## 4. 云端包：没配置时 list()/start() 都要指路');
  const base2 = path.join(base, 'cloud-state');
  const cloudDir = path.join(base2, 'packs', 'voice-cloud');
  await fsp.mkdir(path.join(cloudDir, 'voices', 'age12-cloud'), { recursive: true });
  await fsp.writeFile(path.join(cloudDir, 'config.toml'), stripCloudCredentials(EXAMPLE), 'utf8');
  await fsp.writeFile(path.join(cloudDir, 'voices', 'age12-cloud', 'voice.json'), '{"speaker":""}\n', 'utf8');
  const vp2 = createVoicePacks({
    voicePacks: {
      dir: path.join(base2, 'packs'),
      manifests: [{ id: 'voice-cloud', url: fixture, port: 39876, postInstall: [], verifyDirs: [], repo: '' }],
    },
  });
  {
    const list = await vp2.list();
    const p = (list.packs || []).find((x) => x.id === 'voice-cloud');
    ok(p?.needsCloudConfig === true, 'list() 报 needsCloudConfig=true（UI 要指路）');
  }
  await assert.rejects(() => vp2.start('voice-cloud'), /云端包还没填密钥/);
  ok(true, '没填密钥时 start() 拒绝启动，并给出要填哪三项');
  {
    await vp2.cloudConfig('voice-cloud', { appId: '1234567890', accessKey: 'AKuser', speaker: 'S_test' });
    const list = await vp2.list();
    const p = (list.packs || []).find((x) => x.id === 'voice-cloud');
    ok(p?.needsCloudConfig === false, '填完三项后 needsCloudConfig 变 false');
  }
  if (process.platform === 'win32') {
    // 凭据齐了才会走到"Python 环境没装好"这一步：证明前面的闸只拦凭据。
    await assert.rejects(() => vp2.start('voice-cloud'), /Python 环境还没装好/);
    ok(true, '凭据齐全后不再被凭据闸拦（改为报 Python 环境缺失）');
  }

  console.log('## 5. 重装（force）必须保住用户自己填的凭据');
  {
    await fsp.writeFile(path.join(packDir, 'config.toml'), 'cloud_app_id = "1234567890"\ncloud_access_key = "AKuser"\ncloud_resource = "seed-icl-2.0"\n', 'utf8');
    const again = await vp.install('voice-cloud-fixture', { force: true });
    ok(again?.ok === true, 'force 重装已启动');
    const second = await wait('voice-cloud-fixture');
    ok(second.ok === true, `重装完成${second.ok ? '' : '：' + second.failed}`);
    const text = await readTextRetry(path.join(packDir, 'config.toml'));
    ok(text.includes('cloud_app_id = "1234567890"'), '重装后 AppID 还在（不是每次都要重填）');
    ok(text.includes('cloud_access_key = "AKuser"'), '重装后 Access Key 还在');
  }
} finally {
  await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
}

console.log(failures === 0 ? '\n✅ 云端凭据边界回归通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);

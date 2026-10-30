// 离线语音包导入：校验、复制、配置保留、回滚边界（临时目录，不碰真实包）。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVoicePacks } from '../src/voice-packs.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'surfcore-import-'));
const packsDir = path.join(tmp, 'packs');
await fs.mkdir(packsDir, { recursive: true });

const cfg = {
  voicePacks: {
    dir: packsDir,
    manifests: [
      { id: 'voice-local', port: 18799 },
      { id: 'voice-cloud', port: 18798 },
    ],
  },
};
const vp = createVoicePacks(cfg);

async function write(file, content = '') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function makePack(id, { manifest = true, config } = {}) {
  const src = path.join(tmp, 'source', `${id}-${Math.random().toString(36).slice(2)}`, id);
  const isLocal = id === 'voice-local';
  const primary = isLocal ? 'gsv' : 'cloud';
  const example = config || `[server]\nhost = "127.0.0.1"\nport = ${isLocal ? 8765 : 8767}\ntoken = ""\n\n[engine]\nprimary = "${primary}"\nfallbacks = []\ncloud_app_id = "dev-app"\ncloud_access_key = "dev-secret"\n`;
  await write(path.join(src, 'voxd', '__init__.py'), '');
  await write(path.join(src, 'models', 'marker.txt'), 'model');
  await write(path.join(src, 'voices', 'marker.txt'), 'voice');
  await write(path.join(src, 'config.example.toml'), example);
  await write(path.join(src, '.venv', 'Scripts', 'python.exe'), '');
  await write(path.join(src, '.venv', 'pyvenv.cfg'), 'home = C:\\old\\python313\nversion = 3.13.7\n');
  await write(path.join(src, 'runtime', 'python313', 'python.exe'), '');
  if (isLocal) {
    await write(path.join(src, '.venv-gsv', 'Scripts', 'python.exe'), '');
    await write(path.join(src, '.venv-gsv', 'pyvenv.cfg'), 'home = C:\\old\\python312\nversion = 3.12.15\n');
    await write(path.join(src, 'runtime', 'python312', 'python.exe'), '');
    await write(path.join(src, 'vendor', 'GPT-SoVITS', 'code', 'marker.py'), '');
    await write(path.join(src, 'logs', 'gsv', 'tts_infer.yaml'), 'custom:\n  version: v2\n');
    await write(path.join(src, 'models', 'age12', 'age12-e8.ckpt'), 'ckpt-fixture');
    await write(path.join(src, 'models', 'age12', 'age12_e8_s184.pth'), 'pth-fixture');
  } else {
    await write(path.join(src, 'voices', 'age12-cloud', 'voice.json'), '{"engine":"cloud","speaker":""}');
  }
  if (manifest) {
    const m = {
      kind: 'surfcore-voice-offline',
      pack: id,
      version: '1.0.0',
      voice: { id: isLocal ? 'loli12-gsv' : 'age12-cloud' },
    };
    if (isLocal) m.voice.weights = {
      t2s: { path: 'models/age12/age12-e8.ckpt', sha256: sha256('ckpt-fixture') },
      vits: { path: 'models/age12/age12_e8_s184.pth', sha256: sha256('pth-fixture') },
    };
    await fs.writeFile(path.join(src, 'offline-manifest.json'), JSON.stringify(m, null, 2));
  }
  return src;
}

async function waitImport(id) {
  for (let i = 0; i < 120; i += 1) {
    const r = await vp.list();
    const im = r.packs.find((p) => p.id === id)?.import;
    if (im && (im.phase === '完成' || im.phase === '失败')) return im;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('导入超时');
}

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, String(e?.stack || e)]); }
};

await test('合法本地包：inspect 通过且 manifest 校验', async () => {
  const src = await makePack('voice-local');
  const info = await vp.inspectImport('voice-local', src);
  assert.equal(info.id, 'voice-local');
  assert.equal(info.verified, true);
  assert.ok(info.sizeBytes > 0);
});

await test('包不完整：列出缺失文件', async () => {
  const src = await makePack('voice-local');
  await fs.rm(path.join(src, '.venv-gsv', 'Scripts', 'python.exe'));
  await assert.rejects(
    () => vp.inspectImport('voice-local', src),
    (e) => e.code === 'IMPORT_PACK_INCOMPLETE' && e.missing.includes('.venv-gsv/Scripts/python.exe'),
  );
});

await test('包类型不匹配：拒绝', async () => {
  const src = await makePack('voice-cloud');
  await assert.rejects(
    () => vp.inspectImport('voice-local', src),
    (e) => e.code === 'IMPORT_PACK_TYPE_MISMATCH',
  );
});

await test('manifest 哈希不匹配：拒绝', async () => {
  const src = await makePack('voice-local');
  const m = JSON.parse(await fs.readFile(path.join(src, 'offline-manifest.json'), 'utf8'));
  m.voice.weights.t2s.sha256 = '0'.repeat(64);
  await fs.writeFile(path.join(src, 'offline-manifest.json'), JSON.stringify(m));
  await assert.rejects(
    () => vp.inspectImport('voice-local', src),
    (e) => e.code === 'IMPORT_MANIFEST_HASH_MISMATCH',
  );
});

await test('无 manifest：默认拒绝，确认后允许', async () => {
  const src = await makePack('voice-local', { manifest: false });
  const info = await vp.inspectImport('voice-local', src);
  assert.equal(info.verified, false);
  await assert.rejects(() => vp.startImport('voice-local', { sourceDir: src }), (e) => e.code === 'IMPORT_UNVERIFIED');
  const started = await vp.startImport('voice-local', { sourceDir: src, allowUnverified: true });
  assert.equal(started.ok, true);
  const im = await waitImport('voice-local');
  assert.equal(im.phase, '完成');
  assert.equal(im.result.verified, false);
});

await test('复制导入：源目录保留，pyvenv 改写，凭据清空', async () => {
  const src = await makePack('voice-local');
  await vp.startImport('voice-local', { sourceDir: src });
  const im = await waitImport('voice-local');
  assert.equal(im.phase, '完成');
  assert.ok(await fs.stat(src));
  const target = path.join(packsDir, 'voice-local');
  assert.ok((await fs.stat(path.join(target, 'config.toml'))).isFile());
  const cfgText = await fs.readFile(path.join(target, 'config.toml'), 'utf8');
  assert.ok(!cfgText.includes('dev-secret'));
  const py = await fs.readFile(path.join(target, '.venv', 'pyvenv.cfg'), 'utf8');
  assert.ok(py.includes(`home = ${target.replaceAll('\\', '/')}`));
  assert.equal(await vp.inspectImport('voice-local', src).then((x) => x.ok), true);
});

await test('已有 config.toml：逐字节保留，并留下旧包备份', async () => {
  const target = path.join(packsDir, 'voice-local');
  await fs.rm(target, { recursive: true, force: true });
  const old = '[server]\nport = 8765\ntoken = "user-token"\n[engine]\nprimary = "gsv"\n';
  await write(path.join(target, 'config.toml'), old);
  const src = await makePack('voice-local');
  await vp.startImport('voice-local', { sourceDir: src });
  const im = await waitImport('voice-local');
  assert.equal(im.phase, '完成');
  assert.equal(await fs.readFile(path.join(target, 'config.toml'), 'utf8'), old);
  assert.ok(im.result.backupDir && await fs.stat(im.result.backupDir));
});

await test('pyvenv 缺失：失败且不切换旧包', async () => {
  const target = path.join(packsDir, 'voice-local');
  await fs.rm(target, { recursive: true, force: true });
  await write(path.join(target, 'config.toml'), '[server]\nport = 8765\n[engine]\nprimary = "gsv"\n');
  const before = await fs.readFile(path.join(target, 'config.toml'), 'utf8');
  const src = await makePack('voice-local');
  await fs.rm(path.join(src, '.venv', 'pyvenv.cfg'));
  await vp.startImport('voice-local', { sourceDir: src });
  const im = await waitImport('voice-local');
  assert.equal(im.phase, '失败');
  assert.equal(im.code, 'IMPORT_ENV_MISSING');
  assert.equal(await fs.readFile(path.join(target, 'config.toml'), 'utf8'), before);
});

await test('旧 config.toml 格式错误：拒绝且不覆盖', async () => {
  const target = path.join(packsDir, 'voice-local');
  await fs.rm(target, { recursive: true, force: true });
  const broken = 'this is not toml\n';
  await write(path.join(target, 'config.toml'), broken);
  const src = await makePack('voice-local');
  await assert.rejects(
    () => vp.startImport('voice-local', { sourceDir: src }),
    (e) => e.code === 'IMPORT_CONFIG_INVALID' && Boolean(e.hint),
  );
  assert.equal(await fs.readFile(path.join(target, 'config.toml'), 'utf8'), broken);
});

for (const [status, name, detail] of results) {
  console.log(`${status === 'PASS' ? '✅' : '❌'} ${name}`);
  if (detail) console.error(detail);
}
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（${results.length} 项）`);
await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
process.exit(failed === 0 ? 0 : 1);

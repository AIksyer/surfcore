// 生成发布包的安装清单：每个文件的 sha256。
// 用途：客户端更新前用它判断"这个文件是不是我们的"（不在清单里 = 用户自建，永不删除），
// 以及判断"用户改过没有"（哈希不符 = 本地修改 → 阻止自动覆盖）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

// 与 apply-update.mjs 的排除项保持一致：这些目录/文件属于用户或运行时，不进清单
const EXCLUDE_DIRS = new Set([
  'state', 'backups', 'node_modules', '.git', 'logs', 'staging', 'pet', 'characters',
  'voice-packs', 'dist', 'video', 'release', 'tmp-update',
]);
const EXCLUDE_FILES = new Set(['config.json', 'bili.config.json', 'updates-pending.json', '.installed-meta.json', '.installed-manifest.json']);

// 只列 **git 跟踪的文件**（= GitHub archive 里会有的东西）。
// 2026-10-30 事故：以前扫的是开发工作目录，把 gitignore 的 _backups/、audio/、本地改过的
// docs/* 也算进清单 → 用户下载的归档天然对不上 → 每次校验必失败、自动更新 100% 不可用。
const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' })
  .split(String.fromCharCode(0))
  .filter(Boolean)
  .filter((rel) => {
    const parts = rel.split('/');
    if (parts.some((x) => EXCLUDE_DIRS.has(x))) return false;
    if (EXCLUDE_FILES.has(parts[parts.length - 1])) return false;
    if (rel === 'release/install-manifest.json') return false;
    return true;
  });

const dirty = execFileSync('git', ['-C', root, 'status', '--porcelain', '--', ...tracked], { encoding: 'utf8' }).trim();
// 生成器自己会改 release/install-manifest.json，别把它算成"脏"
const dirtyReal = String(dirty).split(String.fromCharCode(10)).filter((line) => line && !line.includes('release/install-manifest.json')).join(String.fromCharCode(10)).trim();
if (dirtyReal) {
  console.error('[release-manifest] 工作区有未提交改动，清单会与实际归档不一致：');
  console.error(String(dirtyReal).split(String.fromCharCode(10)).slice(0, 10).join(String.fromCharCode(10)));
  process.exitCode = 1;
}

const files = {};
for (const rel of tracked) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) continue;
  files[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const out = {
  schemaVersion: 1,
  version,
  generatedAt: new Date().toISOString(),
  files,
};
const target = path.join(root, 'release', 'install-manifest.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(`install-manifest: ${Object.keys(files).length} files, version ${version} -> ${target}`);

// 生成发布包的安装清单：每个文件的 sha256。
// 用途：客户端更新前用它判断"这个文件是不是我们的"（不在清单里 = 用户自建，永不删除），
// 以及判断"用户改过没有"（哈希不符 = 本地修改 → 阻止自动覆盖）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

// 与 apply-update.mjs 的排除项保持一致：这些目录/文件属于用户或运行时，不进清单
const EXCLUDE_DIRS = new Set([
  'state', 'backups', 'node_modules', '.git', 'logs', 'staging', 'pet', 'characters',
  'voice-packs', 'dist', 'video', 'release', 'tmp-update',
]);
const EXCLUDE_FILES = new Set(['config.json', 'bili.config.json', 'updates-pending.json', '.installed-meta.json', '.installed-manifest.json']);

const files = {};
function walk(dir, rel = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    const relPath = rel ? `${rel}/${name}` : name;
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue;
      walk(path.join(dir, name), relPath);
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDE_FILES.has(name)) continue;
    if (name === 'install-manifest.json' && rel === 'release') continue;
    const buf = fs.readFileSync(path.join(dir, name));
    files[relPath] = crypto.createHash('sha256').update(buf).digest('hex');
  }
}
walk(root);

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

// 离线语音包导入：校验 / 复制 / 环境修复 / 配置保留。
//
// 设计底线（2026-10-29 用户确认）：
// - 用户下载解压出来的目录是**原始备份**：默认只复制，不移动、不删除；
// - 先校验后操作；任何失败都不能动标准目录和旧包；
// - 旧 config.toml 原样保留；没有才从 example 生成并清空云端凭据；
// - 有 manifest 就核对包类型/版本/声明的 sha256；没有 manifest 允许继续但标记未验证；
// - 每个错误都有 code + 可读原因 + hint + missing，供 UI 弹窗给下一步。

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { stripCloudCredentials } from './voice-pack-secrets.js';

export const IMPORT_CODES = {
  PATH_EMPTY: 'IMPORT_PATH_EMPTY',
  PATH_NOT_FOUND: 'IMPORT_PATH_NOT_FOUND',
  PATH_NOT_DIR: 'IMPORT_PATH_NOT_DIR',
  PACK_NOT_FOUND: 'IMPORT_PACK_NOT_FOUND',
  PACK_TYPE_MISMATCH: 'IMPORT_PACK_TYPE_MISMATCH',
  PACK_INCOMPLETE: 'IMPORT_PACK_INCOMPLETE',
  MANIFEST_INVALID: 'IMPORT_MANIFEST_INVALID',
  MANIFEST_HASH_MISMATCH: 'IMPORT_MANIFEST_HASH_MISMATCH',
  UNVERIFIED: 'IMPORT_UNVERIFIED',
  CONFIG_INVALID: 'IMPORT_CONFIG_INVALID',
  CONFIG_MISSING: 'IMPORT_CONFIG_MISSING',
  ENV_MISSING: 'IMPORT_ENV_MISSING',
  ENV_REWRITE_FAILED: 'IMPORT_ENV_REWRITE_FAILED',
  TARGET_RUNNING: 'IMPORT_TARGET_RUNNING',
  DISK_FULL: 'IMPORT_DISK_FULL',
  COPY_FAILED: 'IMPORT_COPY_FAILED',
  CANCELLED: 'IMPORT_CANCELLED',
  ROLLBACK_FAILED: 'IMPORT_ROLLBACK_FAILED',
  CLEANUP_FAILED: 'IMPORT_CLEANUP_FAILED',
  SOURCE_DELETE_REFUSED: 'IMPORT_SOURCE_DELETE_REFUSED',
  BACKUP_DELETE_REFUSED: 'IMPORT_BACKUP_DELETE_REFUSED',
};

export class ImportError extends Error {
  constructor(code, message, { hint = '', missing = [], detail = null, status = 400 } = {}) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    this.hint = hint;
    this.missing = Array.isArray(missing) ? missing : [];
    this.detail = detail;
    this.status = status;
  }

  toJSON() {
    return {
      ok: false,
      code: this.code,
      error: this.message,
      hint: this.hint,
      ...(this.missing.length ? { missing: this.missing } : {}),
      ...(this.detail !== null && this.detail !== undefined ? { detail: this.detail } : {}),
    };
  }
}

export function importError(code, message, opts) {
  return new ImportError(code, message, opts);
}

async function statOrNull(p) {
  try { return await fsp.stat(p); } catch { return null; }
}

async function readText(p) {
  try { return await fsp.readFile(p, 'utf8'); } catch { return ''; }
}

/** 用户可能选包目录、包的上一级、或重复套了一层的目录。 */
export async function normalizeSourceDir(id, sourceDir) {
  const raw = String(sourceDir || '').trim();
  if (!raw) {
    throw importError(IMPORT_CODES.PATH_EMPTY, '没有选择离线包目录', {
      hint: '点「导入离线包…」选择解压出来的 voice-local / voice-cloud 文件夹，或它的上一级。',
    });
  }
  const abs = path.resolve(raw);
  const st = await statOrNull(abs);
  if (!st) {
    throw importError(IMPORT_CODES.PATH_NOT_FOUND, `目录不存在：${abs}`, {
      hint: '确认离线包已经完整解压；路径变了就重新选择目录。',
      detail: { path: abs },
    });
  }
  if (!st.isDirectory()) {
    throw importError(IMPORT_CODES.PATH_NOT_DIR, `选中的不是文件夹：${abs}`, {
      hint: '请选择解压出来的文件夹，不要选择 zip 文件。',
      detail: { path: abs },
    });
  }
  const base = path.basename(abs).toLowerCase();
  if (base === id) return abs;
  const nested = path.join(abs, id);
  const nestedSt = await statOrNull(nested);
  if (nestedSt?.isDirectory()) return nested;
  const detected = await detectPackType(abs);
  if (detected) return abs;
  throw importError(IMPORT_CODES.PACK_NOT_FOUND, `这个目录里没有 ${id}`, {
    hint: id === 'voice-local'
      ? '请选择解压出来的 voice-local 文件夹（里面应有 voxd/、vendor/、.venv/）。'
      : '请选择解压出来的 voice-cloud 文件夹（里面应有 voxd/、voices/、.venv/）。',
    detail: { path: abs, expected: id, detected: detected || null },
  });
}

/** 从配置/目录特征判断这是哪个包；判断不出返回 null。 */
export async function detectPackType(dir) {
  const cfg = await readText(path.join(dir, 'config.toml')) || await readText(path.join(dir, 'config.example.toml'));
  const primary = /^\s*primary\s*=\s*"([^"]+)"/m.exec(cfg)?.[1] || '';
  if (primary === 'cloud') return 'voice-cloud';
  if (primary === 'gsv') return 'voice-local';
  if (await statOrNull(path.join(dir, 'voices', 'age12-cloud', 'voice.json'))) return 'voice-cloud';
  if (await statOrNull(path.join(dir, 'vendor', 'GPT-SoVITS', 'code'))) return 'voice-local';
  return null;
}

/** 必需文件/目录；返回相对路径数组。 */
export async function missingPackFiles(id, dir) {
  const missing = [];
  const need = (rel) => missing.push(rel);
  for (const rel of ['voxd', 'models', 'voices', '.venv/Scripts/python.exe']) {
    if (!(await statOrNull(path.join(dir, rel)))) need(rel);
  }
  if (!(await statOrNull(path.join(dir, 'config.example.toml'))) && !(await statOrNull(path.join(dir, 'config.toml')))) {
    need('config.example.toml');
  }
  if (id === 'voice-local') {
    for (const rel of ['vendor/GPT-SoVITS/code', '.venv-gsv/Scripts/python.exe', 'logs/gsv/tts_infer.yaml']) {
      if (!(await statOrNull(path.join(dir, rel)))) need(rel);
    }
  }
  if (id === 'voice-cloud') {
    if (!(await statOrNull(path.join(dir, 'voices', 'age12-cloud', 'voice.json')))) {
      need('voices/age12-cloud/voice.json');
    }
  }
  return missing;
}

async function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

function manifestWeightEntries(manifest) {
  const out = [];
  const push = (p, sha) => {
    if (!p || !sha) return;
    out.push({ path: String(p), sha256: String(sha).toLowerCase() });
  };
  const weights = manifest?.voice?.weights;
  if (weights && typeof weights === 'object' && !Array.isArray(weights)) {
    for (const v of Object.values(weights)) {
      if (v && typeof v === 'object') push(v.path, v.sha256);
    }
  }
  if (Array.isArray(manifest?.weights)) {
    for (const v of manifest.weights) push(v?.path, v?.sha256);
  }
  if (Array.isArray(manifest?.files)) {
    for (const v of manifest.files) push(v?.path, v?.sha256);
  }
  return out;
}

/** 读取并核对 offline-manifest.json；不存在返回 null（调用方决定是否允许未验证）。 */
export async function readAndVerifyManifest(id, dir) {
  const file = path.join(dir, 'offline-manifest.json');
  const st = await statOrNull(file);
  if (!st) return null;
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    throw importError(IMPORT_CODES.MANIFEST_INVALID, 'offline-manifest.json 不是合法 JSON', {
      hint: '重新下载完整离线包；不要手工改清单。',
      detail: { file, reason: String(e?.message || e) },
    });
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw importError(IMPORT_CODES.MANIFEST_INVALID, 'offline-manifest.json 结构不对', {
      hint: '重新下载完整离线包；不要手工改清单。',
      detail: { file },
    });
  }
  if (manifest.pack && manifest.pack !== id) {
    throw importError(IMPORT_CODES.PACK_TYPE_MISMATCH, `这是 ${manifest.pack} 的离线包，当前要导入的是 ${id}`, {
      hint: id === 'voice-local'
        ? '请到本地语音包卡片导入 voice-local，或选择本地包文件夹。'
        : '请到云端语音包卡片导入 voice-cloud，或选择云端包文件夹。',
      detail: { expected: id, actual: manifest.pack },
    });
  }
  for (const item of manifestWeightEntries(manifest)) {
    const rel = item.path.replaceAll('\\', '/');
    const abs = path.resolve(dir, rel);
    const root = path.resolve(dir) + path.sep;
    if (!abs.startsWith(root)) {
      throw importError(IMPORT_CODES.MANIFEST_INVALID, `清单里的路径越界：${item.path}`, {
        hint: '离线包可能被篡改，请重新下载。',
        detail: { path: item.path },
      });
    }
    const fst = await statOrNull(abs);
    if (!fst?.isFile()) {
      throw importError(IMPORT_CODES.PACK_INCOMPLETE, `清单声明的文件不存在：${item.path}`, {
        hint: '离线包不完整；重新下载完整包后再导入。',
        missing: [item.path],
        detail: { path: item.path },
      });
    }
    const actual = await hashFile(abs);
    if (actual !== item.sha256) {
      throw importError(IMPORT_CODES.MANIFEST_HASH_MISMATCH, `文件校验失败：${item.path}`, {
        hint: '文件可能下载不完整或被替换；重新下载后再导入，不要继续使用这个包。',
        detail: { path: item.path, expected: item.sha256, actual },
      });
    }
  }
  return manifest;
}

/** 检查目录结构 + 类型 + manifest；不写任何东西。 */
export async function inspectImportSource({ id, sourceDir, targetDir = '' }) {
  if (id !== 'voice-local' && id !== 'voice-cloud') {
    throw importError(IMPORT_CODES.PACK_NOT_FOUND, `未知语音包：${id}`, { hint: '刷新设置页后重试。' });
  }
  const src = await normalizeSourceDir(id, sourceDir);
  const detected = await detectPackType(src);
  if (detected && detected !== id) {
    throw importError(IMPORT_CODES.PACK_TYPE_MISMATCH, `这是 ${detected} 的目录，不是 ${id}`, {
      hint: id === 'voice-local' ? '请到本地语音包卡片导入。' : '请到云端语音包卡片导入。',
      detail: { expected: id, actual: detected, path: src },
    });
  }
  const missing = await missingPackFiles(id, src);
  if (missing.length) {
    throw importError(IMPORT_CODES.PACK_INCOMPLETE, '离线包不完整，无法导入', {
      hint: id === 'voice-local'
        ? '请确认已经完整解压 voice-local 文件夹。如果是下载不完整，请重新下载后再导入。'
        : '请确认已经完整解压 voice-cloud 文件夹。如果是下载不完整，请重新下载后再导入。',
      missing,
      detail: { path: src },
    });
  }
  const manifest = await readAndVerifyManifest(id, src);
  const sizeBytes = await dirSize(src);
  const warnings = [];
  if (!manifest) {
    warnings.push({
      code: IMPORT_CODES.UNVERIFIED,
      message: '该离线包没有 offline-manifest.json，无法验证文件完整性。',
      hint: '如果来源不可信，请重新下载官方离线包；确认来源可信再继续。',
    });
  }
  return {
    ok: true,
    id,
    sourceDir: src,
    targetDir: targetDir || '',
    type: detected || id,
    sizeBytes,
    version: String(manifest?.version || ''),
    verified: Boolean(manifest),
    manifest,
    warnings,
  };
}

/** Windows Defender/索引器刚扫完大目录时，rename 会短暂 EPERM/EBUSY；重试而不是直接失败。 */
export async function renameWithRetry(src, dest, { tries = 120, delayMs = 500 } = {}) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    try {
      await fsp.rename(src, dest);
      return;
    } catch (e) {
      last = e;
      if (!/EPERM|EBUSY|EACCES|ENOTEMPTY/.test(String(e?.code || ''))) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}

/** 清理临时目录：同样容忍 Windows 瞬时占用；失败时由调用方报告残留路径。 */
export async function removeWithRetry(target, { tries = 60, delayMs = 500 } = {}) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    try {
      await fsp.rm(target, { recursive: true, force: true });
      return;
    } catch (e) {
      last = e;
      if (!/EPERM|EBUSY|EACCES|ENOTEMPTY/.test(String(e?.code || ''))) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}

/** 计算目录大小（字节）；跳过符号链接。 */
export async function dirSize(root) {
  let total = 0;
  const walk = async (dir) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) await walk(p);
      else if (ent.isFile()) {
        try { total += (await fsp.stat(p)).size; } catch {}
      }
    }
  };
  await walk(root);
  return total;
}

/** 只改 .venv / .venv-gsv 的 pyvenv.cfg；不改 site-packages。 */
export async function rewriteVenvConfig(dir, { versions = ['313'] } = {}) {
  for (const ver of versions) {
    const venv = ver === '312' ? '.venv-gsv' : '.venv';
    const cfgFile = path.join(dir, venv, 'pyvenv.cfg');
    const runtime = path.join(dir, 'runtime', `python${ver}`);
    const py = path.join(runtime, 'python.exe');
    if (!(await statOrNull(cfgFile))) {
      throw importError(IMPORT_CODES.ENV_MISSING, `缺少 ${venv}/pyvenv.cfg`, {
        hint: '离线包环境不完整；重新下载完整包。',
        missing: [`${venv}/pyvenv.cfg`],
      });
    }
    if (!(await statOrNull(py))) {
      throw importError(IMPORT_CODES.ENV_MISSING, `缺少 runtime/python${ver}/python.exe`, {
        hint: '离线包运行时缺失；重新下载完整包。',
        missing: [`runtime/python${ver}/python.exe`],
      });
    }
    const text = await fsp.readFile(cfgFile, 'utf8');
    const home = runtime.replaceAll('\\', '/');
    const lines = text.split(/\r?\n/);
    let sawHome = false;
    let sawExe = false;
    const out = lines.map((line) => {
      if (/^\s*home\s*=/.test(line)) { sawHome = true; return `home = ${home}`; }
      if (/^\s*executable\s*=/.test(line)) { sawExe = true; return `executable = ${home}/python.exe`; }
      return line;
    });
    if (!sawHome) {
      throw importError(IMPORT_CODES.ENV_REWRITE_FAILED, `${venv}/pyvenv.cfg 里没有 home 字段`, {
        hint: '这不是可移植的 venv；重新下载完整包，或把 pyvenv.cfg 恢复成标准格式。',
        detail: { file: cfgFile },
      });
    }
    if (!sawExe) out.push(`executable = ${home}/python.exe`);
    try {
      await fsp.writeFile(cfgFile, out.join('\n'), 'utf8');
    } catch (e) {
      throw importError(IMPORT_CODES.ENV_REWRITE_FAILED, `改写 ${venv}/pyvenv.cfg 失败`, {
        hint: '检查文件是否只读/被杀毒软件占用；修复后重试。',
        detail: { file: cfgFile, reason: String(e?.message || e) },
      });
    }
  }
}

export function validateConfigText(text) {
  const s = String(text || '').replace(/\r\n/g, '\n');
  if (!s.trim()) return '配置为空';
  if (!/^\[server\]\s*$/m.test(s)) return '缺少 [server] 段';
  if (!/^\[engine\]\s*$/m.test(s)) return '缺少 [engine] 段';
  if (!/^\s*port\s*=/m.test(s)) return '缺少 port';
  if (!/^\s*(primary|fallbacks)\s*=/m.test(s)) return '缺少 primary/fallbacks';
  return '';
}

/** 保留旧配置；没有才从 example 生成并清空凭据。 */
export async function prepareConfig(dir, oldConfigPath) {
  const target = path.join(dir, 'config.toml');
  if (oldConfigPath) {
    let old = '';
    try { old = await fsp.readFile(oldConfigPath, 'utf8'); } catch (e) {
      throw importError(IMPORT_CODES.CONFIG_INVALID, '读不到旧 config.toml，无法保留用户配置', {
        hint: '先备份旧包并修复/删除旧 config.toml 后再导入；导入不会覆盖它。',
        detail: { file: oldConfigPath, reason: String(e?.message || e) },
      });
    }
    const bad = validateConfigText(old);
    if (bad) {
      throw importError(IMPORT_CODES.CONFIG_INVALID, `旧 config.toml 格式不对（${bad}）`, {
        hint: '旧配置不会被覆盖。请先备份并修复/删除旧 config.toml，再重新导入。',
        detail: { file: oldConfigPath },
      });
    }
    await fsp.writeFile(target, old, 'utf8');
    return { preserved: true, created: false, sanitized: false };
  }
  await fsp.rm(target, { force: true }).catch(() => {});
  // 包里自带 config.toml 的旧包：清掉凭据后使用；不能让它的 key 留在包里。
  const bundled = await readText(target);
  if (bundled) {
    const bad = validateConfigText(bundled);
    if (bad) {
      throw importError(IMPORT_CODES.CONFIG_INVALID, `包内 config.toml 格式不对（${bad}）`, {
        hint: '导入不会覆盖它。请先修复包内 config.toml，或只保留 config.example.toml 后重试。',
        detail: { file: target },
      });
    }
    const cleaned = stripCloudCredentials(bundled);
    await fsp.writeFile(target, cleaned, 'utf8');
    return { preserved: false, created: false, sanitized: cleaned !== bundled };
  }
  const example = path.join(dir, 'config.example.toml');
  let text = '';
  try { text = await fsp.readFile(example, 'utf8'); } catch {
    throw importError(IMPORT_CODES.CONFIG_MISSING, '包里没有 config.example.toml，无法生成配置', {
      hint: '重新下载完整离线包；不要使用只带 config.toml 的旧目录。',
      missing: ['config.example.toml'],
    });
  }
  const cleaned = stripCloudCredentials(text);
  await fsp.writeFile(target, cleaned, 'utf8');
  return { preserved: false, created: true, sanitized: cleaned !== text };
}

/**
 * 递归复制；跳过根 config.toml（配置单独处理）。
 * onProgress(percent, phase)；isCancelled() 返回 true 时抛 IMPORT_CANCELLED。
 */
export async function copyTree(src, dest, { onProgress = () => {}, isCancelled = () => false } = {}) {
  const files = [];
  let total = 0;
  let copied = 0;
  const walk = async (dir, rel = '') => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) {
      throw importError(IMPORT_CODES.COPY_FAILED, `读取源目录失败：${rel || dir}`, {
        hint: '检查离线包是否被删除/占用，或重新选择目录。',
        detail: { path: dir, reason: String(e?.message || e) },
      });
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) {
        throw importError(IMPORT_CODES.COPY_FAILED, `离线包里含符号链接，已拒绝导入：${relPath}`, {
          hint: '重新下载官方离线包；不要手工制作带符号链接的包。',
          detail: { path: relPath },
        });
      }
      if (ent.isDirectory()) {
        await fsp.mkdir(path.join(dest, relPath), { recursive: true });
        await walk(abs, relPath);
      } else if (ent.isFile()) {
        const st = await fsp.stat(abs);
        files.push({ abs, rel: relPath, size: st.size });
        total += st.size;
      }
    }
  };
  await fsp.mkdir(dest, { recursive: true });
  onProgress(5, '准备复制');
  await walk(src);
  if (!files.length) throw importError(IMPORT_CODES.PACK_INCOMPLETE, '离线包里没有可复制的文件', {
    hint: '确认选择的是解压后的包目录，不是空文件夹。',
  });
  for (const f of files) {
    if (isCancelled()) throw importError(IMPORT_CODES.CANCELLED, '导入已取消', { hint: '没有改动旧包；可以重新导入。', status: 409 });
    const target = path.join(dest, f.rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    try {
      await fsp.copyFile(f.abs, target);
    } catch (e) {
      throw importError(IMPORT_CODES.COPY_FAILED, `复制失败：${f.rel}`, {
        hint: '检查磁盘空间、源文件是否被占用/删除，然后重试。',
        detail: { path: f.rel, reason: String(e?.message || e) },
      });
    }
    copied += f.size;
    const pct = total ? Math.min(75, 5 + Math.round((copied / total) * 70)) : 50;
    onProgress(pct, '复制文件');
  }
  onProgress(75, '复制完成');
}

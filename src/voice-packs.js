// 语音包管理器：把语音引擎做成"可选安装包"，surfcore 本体不背这几 GB。
//
// 设计要点：
// - npm 包里只有 manifest（几百字节），模型和运行时都在包内，装的时候才下载/复制。
// - 安装源支持两种：本地目录（开发期）和 http(s) zip（分发期）。zip 用系统自带 tar 解压。
// - 所有路径都限制在 packsDir 下面，卸载前先校验，避免误删用户别的东西。
// - 语音服务挂了绝不影响聊天：这里只负责"启停/状态"，不参与消息主流程。

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 开发期的默认安装源：**仓库同级的** `voice/packages/<id>`。
 *
 * 为什么不写死盘符（2026-10-26）：原来这里硬编码了本机的一个绝对路径（`<工作区>\voice\...`），
 * 换机器/换目录后默认安装源直接指向不存在的路径，而现象只是"安装失败"。
 * 改成相对仓库根解析：本机仓库放在工作区分区下，其上级正好是 `voice/` 所在目录，
 * 解析结果与旧值**逐字相同**（`scripts/test-voice-packs-default.mjs` 比对），所以本机行为不变，换目录也能用。
 */
function devPackUrl(id) {
  return path.join(REPO_ROOT, '..', 'voice', 'packages', id);
}

/** 默认两个语音包。url 支持：http(s) 链接、本地目录、本地 zip。 */
export const DEFAULT_MANIFESTS = [
  {
    id: 'voice-local',
    name: '本地语音包',
    version: '1.0.0',
    // 2026-10-28 更正：旧值 7.83GB 是开发机整目录（含 .venv 5.1GB + 日志），
    // 公开分发实际下载 ≈ 1.77GB（vendor 1.71 + models 0.05）。
    sizeBytes: 1_900_000_000,
    port: 8765,
    startScript: 'run.bat',
    stopScript: 'stop.bat',
    // 本地音色真正的推理进程：voxd(8765) 只是入口，合成要 GPT-SoVITS(9880)。
    // 2026-10-27：只起 run.bat 时发语音全 503，用户以为"语音坏了"。
    engineScript: 'gsv.bat',
    enginePort: 9880,
    repo: 'Mieksido/surfvoicelocal',
    postInstall: ['scripts/fetch-models.mjs', 'scripts/bootstrap-env.mjs'],
    engineWarmupHint: '本地音色引擎加载约 40 秒，期间发语音会失败，稍等再试',
    // 开发期用本地目录；分发期换成 GitHub Releases 的 zip 链接
    url: process.env.SURFCORE_VOICE_LOCAL_URL || devPackUrl('voice-local'),
    requires: { gpu: true, network: false },
    voices: [{ id: 'loli12-gsv', label: '小语（本地 · 女童声）' }],
    about: {
      summary: '在你自己的电脑上跑，不联网也能说话。',
      pros: ['完全免费', '断网可用', '延迟 1.0~1.5 秒'],
      cons: ['需要 NVIDIA 显卡（6G 显存以上）', '下载约 1.8GB，首次装依赖 20~40 分钟'],
    },
  },
  {
    id: 'voice-cloud',
    name: '云端语音包',
    version: '1.0.0',
    sizeBytes: 60_000_000,
    port: 8767,
    startScript: 'run.bat',
    stopScript: 'stop.bat',
    repo: 'Mieksido/surfvoicecloud',
    postInstall: ['scripts/fetch-models.mjs', 'scripts/bootstrap-env.mjs'],
    url: process.env.SURFCORE_VOICE_CLOUD_URL || devPackUrl('voice-cloud'),
    requires: { gpu: false, network: true },
    voices: [{ id: 'age12-cloud', label: '小语（云端 · 女童声）' }],
    about: {
      summary: '调用火山引擎声音复刻服务，音质最好。',
      pros: ['延迟 0.5~1.1 秒', '不占显卡', '安装约 60MB，1~3 分钟'],
      cons: ['按字符计费（火山引擎收取，与本插件无关）', '必须联网', '要自己申请两个密钥'],
      billing: '按字符计费。每天直播 3 小时约 135 万字符/月。不想付费就装本地包，效果接近且不要钱。',
      disclaimer: '这不是推销：两个包功能对等，装哪个都不影响插件其他功能。',
    },
  },
];

function packsDir(cfg) {
  // 默认目录必须和插件侧一致（插件用 <仓库根>/state/voice-packs）。
  // 2026-10-27：以前用 process.cwd()，桥接 cwd 不同就会指到两个地方 → "装了却说没装"。
  const base = cfg?.voicePacks?.dir || path.join(REPO_ROOT, 'state', 'voice-packs');
  return path.resolve(base);
}

function stateFile(cfg) {
  return path.join(packsDir(cfg), 'installed.json');
}

async function readState(cfg) {
  try {
    return JSON.parse(await fsp.readFile(stateFile(cfg), 'utf8'));
  } catch {
    return { packs: {} };
  }
}

async function writeState(cfg, state) {
  await fsp.mkdir(packsDir(cfg), { recursive: true });
  await fsp.writeFile(stateFile(cfg), JSON.stringify(state, null, 2), 'utf8');
}

function manifests(cfg) {
  const extra = Array.isArray(cfg?.voicePacks?.manifests) ? cfg.voicePacks.manifests : [];
  const byId = new Map(DEFAULT_MANIFESTS.map((m) => [m.id, m]));
  for (const m of extra) byId.set(m.id, { ...byId.get(m.id), ...m });
  return [...byId.values()];
}

/** 已知会放语音包的目录（按可信度）：配置目录、仓库根、cwd、用户目录下常见位置。 */
function packDirCandidates(cfg, id) {
  const list = [];
  const push = (base) => {
    const d = path.join(path.resolve(base), id);
    if (!list.includes(d)) list.push(d);
  };
  push(packsDir(cfg));
  push(path.join(REPO_ROOT, 'state', 'voice-packs'));
  push(path.join(process.cwd(), 'state', 'voice-packs'));
  // 旧版默认目录用过 cwd，用户把包装到「文档\surfcore」这种地方很常见（2026-10-28 反馈）。
  push(path.join(os.homedir(), 'Documents', 'surfcore', 'state', 'voice-packs'));
  push(path.join(os.homedir(), 'surfcore', 'state', 'voice-packs'));
  return list;
}

function packDir(cfg, id) {
  const root = packsDir(cfg);
  const dir = path.join(root, id);
  if (!dir.startsWith(root + path.sep)) throw new Error(`非法语音包 id：${id}`);
  // 配置目录里没有，就去候选目录找已经装好的那份（否则"装了却说没装"）。
  try {
    if (fs.existsSync(path.join(dir, 'config.toml'))) return dir;
  } catch {}
  for (const candidate of packDirCandidates(cfg, id)) {
    try {
      if (fs.existsSync(path.join(candidate, 'config.toml'))) return candidate;
    } catch {}
  }
  return dir;
}

/** 这个包是否不在「配置的安装目录」里（UI 用来提示"已在别处安装"）。 */
function isExternalDir(cfg, id, dir) {
  return path.resolve(dir) !== path.resolve(path.join(packsDir(cfg), id));
}

/** TCP 探活：给 300ms，够本机服务回应。 */
function probePort(port, timeout = 300) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 本地目录直接用；zip 先落到临时文件再用系统 tar 解压（Windows 10+ 自带 bsdtar）。 */
/** GitHub archive zip 解压后多一层 `<repo>-main/`：把里面的内容提上来。 */
async function flattenSingleDir(destDir) {
  let entries = [];
  try { entries = await fsp.readdir(destDir, { withFileTypes: true }); } catch { return; }
  const dirs = entries.filter((e) => e.isDirectory());
  const files = entries.filter((e) => !e.isDirectory());
  if (dirs.length !== 1 || files.length > 0) return;
  const inner = path.join(destDir, dirs[0].name);
  if (await exists(path.join(destDir, 'config.toml'))) return;
  if (!(await exists(path.join(inner, 'config.toml')))) return;
  for (const name of await fsp.readdir(inner)) {
    await fsp.rename(path.join(inner, name), path.join(destDir, name));
  }
  await fsp.rm(inner, { recursive: true, force: true });
}

async function fetchToLocal(cfg, id, src, destDir, onProgress = () => {}) {
  if (/^https?:\/\//i.test(src)) {
    await fsp.mkdir(destDir, { recursive: true });
    const tmp = path.join(os.tmpdir(), `surfcore-${id}-${Date.now()}.zip`);
    const res = await fetch(src);
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') || 0);
    let got = 0;
    const file = fs.createWriteStream(tmp);
    for await (const chunk of res.body) {
      got += chunk.length;
      file.write(chunk);
      if (total) onProgress(Math.min(99, Math.round((got / total) * 100)), '下载中');
    }
    await new Promise((r) => file.end(r));
    onProgress(99, '解压中');
    await new Promise((resolve, reject) => {
      const p = spawn('tar', ['-xf', tmp, '-C', destDir], { stdio: 'ignore' });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`解压失败（exit ${code}）`))));
      p.on('error', reject);
    });
    await fsp.rm(tmp, { force: true });
    return;
  }

  // 本地目录 / 本地 zip
  const st = await fsp.stat(src).catch(() => null);
  if (!st) throw new Error(`安装源不存在：${src}`);
  if (st.isDirectory()) {
    onProgress(10, '复制中');
    await fsp.cp(src, destDir, { recursive: true, force: true });
    onProgress(100, '完成');
    return;
  }
  onProgress(10, '解压中');
  await fsp.mkdir(destDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const p = spawn('tar', ['-xf', src, '-C', destDir], { stdio: 'ignore' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`解压失败（exit ${code}）`))));
    p.on('error', reject);
  });
  onProgress(100, '完成');
}

export function createVoicePacks(cfg) {
  const activeInstalls = new Map(); // id → {progress, phase, startedAt, error}

  async function statusOne(m) {
    const dir = packDir(cfg, m.id);
    const hasFiles = await exists(path.join(dir, 'config.toml'));
    const portUp = await probePort(m.port);
    const engineUp = m.enginePort ? await probePort(m.enginePort) : null;
    // 「外部安装」两种：① 文件在别的目录（旧默认目录/cwd，2026-10-28 用户反馈）；② 只有端口在跑。
    const external = hasFiles ? isExternalDir(cfg, m.id, dir) : portUp;
    const installed = hasFiles || portUp;
    const running = portUp;
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      sizeBytes: m.sizeBytes,
      port: m.port,
      enginePort: m.enginePort ?? null,
      engineUp,
      requires: m.requires,
      voices: m.voices,
      about: m.about,
      installed,
      running,
      external,
      dir: hasFiles ? dir : null,
      install: activeInstalls.get(m.id) || null,
    };
  }

  async function list() {
    const state = await readState(cfg);
    const packs = await Promise.all(manifests(cfg).map(statusOne));
    return {
      ok: true,
      packsDir: packsDir(cfg),
      packs: packs.map((p) => ({
        ...p,
        enabled: state.packs?.[p.id]?.enabled ?? false,
        installedAt: state.packs?.[p.id]?.installedAt ?? null,
      })),
    };
  }

  async function install(id, { force = false } = {}) {
    const m = manifests(cfg).find((x) => x.id === id);
    if (!m) throw new Error(`未知语音包：${id}`);
    // 上一次已经结束（完成/失败）的安装记录要清掉，否则会永远卡在"正在安装中"，
    // 用户失败后连重试都点不了（2026-10-27 反馈）。
    if (activeInstalls.has(id)) {
      const prev = activeInstalls.get(id);
      if (prev && (prev.phase === '完成' || prev.phase === '失败')) activeInstalls.delete(id);
      else throw new Error('这个包正在安装中');
    }
    const dir = packDir(cfg, id);
    if (!force && (await exists(path.join(dir, 'config.toml')))) throw new Error('已经安装过了');

    const rec = { progress: 0, phase: '准备中', startedAt: Date.now(), error: null, log: '' };
    activeInstalls.set(id, rec);
    // 异步跑，接口立刻返回，前端轮询 status 看进度
    (async () => {
      try {
        await fsp.rm(dir, { recursive: true, force: true });
        // 安装源：本地开发目录 / 本地 zip / http(s)。开发目录在用户机器上不存在，
        // 这时退到 GitHub 仓库的 archive zip（代码很小），模型由 postInstall 单独拉。
        let src = String(m.url || '');
        const localDir = /^https?:/i.test(src) ? null : path.resolve(src || '.');
        if (localDir && !(await exists(localDir))) {
          if (!m.repo) throw new Error(`安装源不存在：${src}（这个包没有配置在线安装地址）`);
          src = `https://github.com/${m.repo}/archive/refs/heads/main.zip`;
          rec.phase = '改用在线源';
        }
        await fetchToLocal(cfg, id, src, dir, (p, phase) => {
          rec.progress = p;
          rec.phase = phase;
        });
        await flattenSingleDir(dir);
        // 仓库里只有 config.example.toml（真实配置不入库）：装完先复制成 config.toml，
        // 否则 voxd 起不来、用户看到"包里没有 config.toml"。
        if (!(await exists(path.join(dir, 'config.toml'))) && (await exists(path.join(dir, 'config.example.toml')))) {
          await fsp.copyFile(path.join(dir, 'config.example.toml'), path.join(dir, 'config.toml'));
          rec.phase = '生成配置';
        }
        if (!(await exists(path.join(dir, 'config.toml')))) {
          throw new Error('包里没有 config.toml，可能下载的是错的文件');
        }
        // 后置步骤：先拉模型/运行库（sha256 校验），再建 Python 环境（首次要几分钟）。
        const postScripts = (Array.isArray(m.postInstall) ? m.postInstall : (m.postInstall ? [m.postInstall] : []))
          .filter((x) => x);
        for (const script of postScripts) {
          if (!(await exists(path.join(dir, script)))) continue;
          rec.phase = script.includes('bootstrap') ? '安装 Python 依赖（首次 5~40 分钟）' : '拉取模型（可能几分钟）';
          rec.progress = 99;
          const okPost = await new Promise((resolve) => {
            const child = spawn(process.execPath, [path.join(dir, script)], {
              cwd: dir, windowsHide: true, env: { ...process.env },
            });
            let out = '';
            const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(false); }, 45 * 60_000);
            child.stdout?.on('data', (d) => { out = (out + String(d)).slice(-2000); rec.log = out; });
            child.stderr?.on('data', (d) => { out = (out + String(d)).slice(-2000); rec.log = out; });
            child.on('error', () => { clearTimeout(timer); resolve(false); });
            child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
          });
          if (!okPost) throw new Error(`${script} 失败：${(rec.log || '').slice(-300) || '看包内日志'}`);
        }
        const state = await readState(cfg);
        state.packs = state.packs || {};
        state.packs[id] = { enabled: true, installedAt: new Date().toISOString(), version: m.version };
        await writeState(cfg, state);
        rec.phase = '完成';
        rec.progress = 100;
        setTimeout(() => activeInstalls.delete(id), 5000).unref?.();
      } catch (e) {
        rec.error = String(e?.message || e);
        rec.phase = '失败';
        setTimeout(() => activeInstalls.delete(id), 10 * 60_000).unref?.();
      }
    })();

    return { ok: true, started: true };
  }

  async function remove(id) {
    const dir = packDir(cfg, id);
    await stop(id).catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true });
    const state = await readState(cfg);
    if (state.packs?.[id]) {
      delete state.packs[id];
      await writeState(cfg, state);
    }
    return { ok: true };
  }

  async function start(id) {
    const m = manifests(cfg).find((x) => x.id === id);
    if (!m) throw new Error(`未知语音包：${id}`);
    const dir = packDir(cfg, id);
    if (!(await exists(path.join(dir, 'config.toml')))) throw new Error('还没安装');
    // Python 环境缺失时直接给可操作的提示，别让用户看着"启动超时"猜。
    if (process.platform === 'win32' && !(await exists(path.join(dir, '.venv', 'Scripts', 'python.exe')))) {
      throw new Error('Python 环境还没装好：先点「卸载」再点「安装」重新装一次（会自动创建 .venv 并装依赖）');
    }
    if (await probePort(m.port)) return { ok: true, already: true, port: m.port };

    // 本地音色：先把 GPT-SoVITS(9880) 拉起来，否则入口起来了也只能 503。
    let engineStarted = false;
    if (m.engineScript && m.enginePort) {
      const engineUp = await probePort(m.enginePort);
      if (!engineUp) {
        const engineScript = path.join(dir, m.engineScript);
        if (await exists(engineScript)) {
          const engineChild = spawn('cmd', ['/c', engineScript], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true });
          engineChild.unref();
          engineStarted = true;
        }
      }
    }

    const script = path.join(dir, m.startScript || 'run.bat');
    if (!(await exists(script))) throw new Error(`包内缺少启动脚本：${m.startScript}`);
    const child = spawn('cmd', ['/c', script], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    // 最多等 60 秒（本地包要加载模型）
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await probePort(m.port)) {
        const engineUp = m.enginePort ? await probePort(m.enginePort) : null;
        return {
          ok: true, port: m.port, seconds: i + 1,
          ...(m.enginePort ? { enginePort: m.enginePort, engineUp, engineStarted } : {}),
          ...(m.enginePort && !engineUp ? { warning: m.engineWarmupHint } : {}),
        };
      }
    }
    return { ok: false, error: '启动超时（60 秒内端口没起来）', port: m.port };
  }

  async function stop(id) {
    const m = manifests(cfg).find((x) => x.id === id);
    if (!m) throw new Error(`未知语音包：${id}`);
    const dir = packDir(cfg, id);
    const script = path.join(dir, m.stopScript || 'stop.bat');
    if (await exists(script)) {
      await new Promise((resolve) => {
        const p = spawn('cmd', ['/c', script], { cwd: dir, stdio: 'ignore', windowsHide: true });
        p.on('exit', resolve);
        p.on('error', resolve);
      });
    }
    for (let i = 0; i < 10; i++) {
      if (!(await probePort(m.port))) return { ok: true };
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: false, error: '端口还在监听（可能不是这个包占的）' };
  }

  /** 写云端密钥：只改 config.toml 里那三行，其余原样保留。 */
  async function cloudConfig(id, body) {
    const dir = packDir(cfg, id);
    const file = path.join(dir, 'config.toml');
    if (!(await exists(file))) throw new Error('还没安装');
    let text = await fsp.readFile(file, 'utf8');
    const set = (key, value) => {
      const re = new RegExp(`^${key}\\s*=.*$`, 'm');
      const line = `${key} = "${String(value).replace(/"/g, '\\"')}"`;
      text = re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
    };
    if (body.appId) set('cloud_app_id', body.appId);
    if (body.accessKey) set('cloud_access_key', body.accessKey);
    if (body.resource) set('cloud_resource', body.resource);
    await fsp.writeFile(file, text, 'utf8');
    if (body.speaker) {
      const vdir = path.join(dir, 'voices');
      const first = (await fsp.readdir(vdir).catch(() => [])).find((x) => x.startsWith('age12'));
      if (first) {
        const vf = path.join(vdir, first, 'voice.json');
        const v = JSON.parse(await fsp.readFile(vf, 'utf8').catch(() => '{}'));
        v.speaker = String(body.speaker);
        await fsp.writeFile(vf, JSON.stringify(v, null, 2) + '\n', 'utf8');
      }
    }
    return { ok: true, file };
  }


  /** 启动其中一个并切换过去：另一个自动停掉，避免"两个都在跑却不知道用哪个"。 */
  async function activate(id) {
    const m = manifests(cfg).find((x) => x.id === id);
    if (!m) throw new Error(`未知语音包：${id}`);
    for (const other of manifests(cfg)) {
      if (other.id === id) continue;
      if (await probePort(other.port)) await stop(other.id).catch(() => {});
    }
    if (!(await probePort(m.port))) {
      const r = await start(id);
      if (r.ok === false) return r;
    }
    // 顺手把路由切过去（写 config.json，宿主热读）
    try {
      const cfgPath = path.join(process.cwd(), 'config.json');
      const disk = JSON.parse(await fsp.readFile(cfgPath, 'utf8'));
      disk.socialV2 = disk.socialV2 || {};
      disk.socialV2.voice = disk.socialV2.voice || {};
      disk.socialV2.voice.tts = disk.socialV2.voice.tts || {};
      disk.socialV2.voice.tts.route = id === 'voice-cloud' ? 'cloud' : 'local';
      // 只要切路由，不能顺手把开关关掉（曾经因此出现“语音合成还没开启”）
      disk.socialV2.voice.tts.enabled = true;
      await fsp.writeFile(cfgPath, JSON.stringify(disk, null, 2) + '\n', 'utf8');
    } catch {}
    return { ok: true, route: id === 'voice-cloud' ? 'cloud' : 'local', port: m.port };
  }

  /** 启用/停用（不影响安装状态，只影响宿主是否把它当作可用语音源）。 */
  async function setEnabled(id, enabled) {
    const m = manifests(cfg).find((x) => x.id === id);
    if (!m) throw new Error(`未知语音包：${id}`);
    const state = await readState(cfg);
    state.packs = state.packs || {};
    state.packs[id] = { ...(state.packs[id] || {}), enabled: !!enabled };
    await writeState(cfg, state);
    return { ok: true, enabled: !!enabled };
  }


  /** 读云端配置：AppID / AccessKey（打码）/ 音色 ID，给设置页回显。 */
  async function readCloudConfig(id) {
    const dir = packDir(cfg, id);
    const file = path.join(dir, 'config.toml');
    const text = (await fsp.readFile(file, 'utf8').catch(() => ''));
    const pick = (k) => (text.match(new RegExp('^' + k + '\\s*=\\s*"([^"]*)"', 'm')) || [])[1] || '';
    const appId = pick('cloud_app_id');
    const accessKey = pick('cloud_access_key');
    let speaker = '';
    try {
      const vdir = path.join(dir, 'voices');
      const first = (await fsp.readdir(vdir)).find((x) => x.startsWith('age12'));
      if (first) {
        const v = JSON.parse(await fsp.readFile(path.join(vdir, first, 'voice.json'), 'utf8'));
        speaker = String(v.speaker || '');
      }
    } catch {}
    return {
      ok: true,
      appId,
      hasAccessKey: !!accessKey,
      accessKeyMasked: accessKey ? accessKey.slice(0, 4) + '****' + accessKey.slice(-4) : '',
      speaker,
      configured: !!appId && !!accessKey && !!speaker,
    };
  }


  /** 云端用量：读包内 logs/requests.jsonl，汇总今天/本月字符数，按用户填的单价估算费用。 */
  async function cloudStats(id, opts = {}) {
    const dir = packDir(cfg, id);
    const file = path.join(dir, 'logs', 'requests.jsonl');
    const text = await fsp.readFile(file, 'utf8').catch(() => '');
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const dayKey = `${monthKey}-${String(now.getDate()).padStart(2, '0')}`;
    let todayChars = 0;
    let monthChars = 0;
    let totalChars = 0;
    let todayCalls = 0;
    let monthCalls = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const chars = Number(row.chars) || 0;
      const t = String(row.t || '');
      totalChars += chars;
      if (t.startsWith(dayKey)) { todayChars += chars; todayCalls += 1; }
      if (t.startsWith(monthKey)) { monthChars += chars; monthCalls += 1; }
    }
    const conf = (await readCloudConfig(id).catch(() => ({}))) || {};
    let cloudCfg = cfg?.socialV2?.voice?.cloud ?? {};
    // 面板刚保存的单价/额度在 config.json 里，内存 cfg 不会热更新，这里直接读盘
    try {
      const disk = JSON.parse(await fsp.readFile(path.join(process.cwd(), 'config.json'), 'utf8'));
      cloudCfg = disk?.socialV2?.voice?.cloud ?? cloudCfg;
    } catch {}
    const pricePerKChar = Number(opts.pricePerKChar ?? cloudCfg.pricePerKChar ?? 0) || 0;
    const monthlyQuota = Number(opts.monthlyQuota ?? cloudCfg.monthlyQuota ?? 0) || 0;
    const model = (await fsp.readFile(path.join(dir, 'config.toml'), 'utf8').catch(() => '')
      .then((t) => (t.match(/^cloud_resource\s*=\s*"([^"]*)"/m) || [])[1] || '')) || '';
    return {
      ok: true,
      model: model === 'seed-icl-2.0' ? '豆包声音复刻 2.0（字符版）' : (model || '未配置'),
      resource: model,
      speaker: conf.speaker || '',
      todayChars, monthChars, totalChars, todayCalls, monthCalls,
      pricePerKChar,
      monthlyQuota,
      monthCost: pricePerKChar ? +(monthChars / 1000 * pricePerKChar).toFixed(2) : null,
      remainChars: monthlyQuota ? Math.max(0, monthlyQuota - monthChars) : null,
      updatedAt: new Date().toISOString(),
    };
  }

  /** 包里预置的"参考音频"（用户拿去喂声音复刻模型，省得自己录）。 */
  async function sampleFile(id) {
    const dir = packDir(cfg, id);
    const vp = path.join(dir, 'voicepack');
    const files = (await fsp.readdir(vp).catch(() => [])).filter((f) => /\.(wav|mp3|m4a)$/i.test(f));
    if (!files.length) throw new Error('这个包没有预置参考音频');
    const file = path.join(vp, files[0]);
    return { file, name: files[0], buffer: await fsp.readFile(file) };
  }

  /** 试听：走包自己的 /v1/speak/file，返回耗时和音频大小。 */
  async function test(id, { text = '你好呀，语音包已经装好了。' } = {}) {
    const m = manifests(cfg).find((x) => x.id === id);
    if (!m) throw new Error(`未知语音包：${id}`);
    if (!(await probePort(m.port))) throw new Error('服务没在运行，先点「启动」');
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${m.port}/v1/speak/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`合成失败：HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, ms: Date.now() - t0, bytes: buf.length, seconds: +(buf.length / 2 / 24000).toFixed(2) };
  }

  return { list, install, remove, start, stop, activate, cloudConfig, readCloudConfig, cloudStats, test, sampleFile, setEnabled, manifests, packsDir };
}

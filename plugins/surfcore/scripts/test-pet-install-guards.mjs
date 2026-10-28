// 桌宠安装的三种"下错包"场景：
//   1) GitHub 源码 zip（多一层 <repo>-main/）→ 自动拍平后应安装成功
//   2) SurfCore 源码 zip → 明确报"这是 SurfCore 源码包"，并清掉残留
//   3) 任意非桌宠 zip → 报"不是 pet-pack.zip"，并清掉残留
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPetService } from '../lib/pet.js';

if (process.platform !== 'win32') {
  console.log('（非 Windows，跳过）');
  process.exit(0);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-pet-install-'));
const stateDir = path.join(base, 'state');
const appDir = path.join(base, 'app');
let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label} ${extra}`); }
};

const zipOf = (name, build) => {
  const stage = path.join(base, `stage-${name}`);
  fs.mkdirSync(stage, { recursive: true });
  build(stage);
  const zip = path.join(base, `${name}.zip`);
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path '${path.join(stage, '*').replace(/'/g, "''")}' -DestinationPath '${zip.replace(/'/g, "''")}' -Force`], { stdio: 'ignore' });
  return zip;
};

try {
  fs.mkdirSync(path.join(stateDir, 'pet'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'pet', 'config.json'), JSON.stringify({ appDir, source: '', electronPath: '' }));
  const pet = createPetService({ stateDir, pluginLog: () => {}, getSubprocess: () => null });

  // 1) GitHub 源码风格：surfpet-main/package.json
  const wrappedZip = zipOf('wrapped', (stage) => {
    const inner = path.join(stage, 'surfpet-main');
    fs.mkdirSync(path.join(inner, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(inner, 'package.json'), JSON.stringify({ name: 'feiyu-pet', version: '9.9.9' }));
    fs.writeFileSync(path.join(inner, 'dist', 'main.js'), '//');
  });
  fs.writeFileSync(path.join(stateDir, 'pet', 'config.json'), JSON.stringify({ appDir, source: wrappedZip, electronPath: '' }));
  const r1 = await pet.startInstall(wrappedZip);
  await new Promise((r) => setTimeout(r, 2500));
  const pkg = fs.existsSync(path.join(appDir, 'package.json'))
    ? JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')) : null;
  ok(r1.ok === true, '源码风格 zip：安装流程启动');
  ok(pkg?.version === '9.9.9', '单层目录被拍平，package.json 到位', JSON.stringify(pkg));

  // 2) SurfCore 源码包
  fs.rmSync(appDir, { recursive: true, force: true });
  const coreZip = zipOf('core', (stage) => {
    fs.mkdirSync(path.join(stage, 'plugins', 'surfcore'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'surfcore', version: '0.6.16' }));
  });
  await pet.startInstall(coreZip);
  await new Promise((r) => setTimeout(r, 2500));
  const st2 = pet.status();
  ok(st2.installing?.phase === '失败', 'SurfCore 源码包：判为失败', JSON.stringify(st2.installing));
  ok(/SurfCore 的源码包/.test(String(st2.installing?.error ?? '')), '错误文案说明"这是源码包"', String(st2.installing?.error ?? ''));
  ok(!fs.existsSync(appDir), '失败后安装目录被清理（下次不会被"目录非空"拦住）');

  // 3) 任意非桌宠 zip
  const junkZip = zipOf('junk', (stage) => {
    fs.mkdirSync(path.join(stage, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'something-else', version: '1.0.0' }));
  });
  await pet.startInstall(junkZip);
  await new Promise((r) => setTimeout(r, 2500));
  const st3 = pet.status();
  ok(st3.installing?.phase === '失败', '任意非桌宠 zip：判为失败');
  ok(/不是桌宠安装包|没有桌宠程序|pet-pack/.test(String(st3.installing?.error ?? '')), '错误文案指出不是 pet-pack', String(st3.installing?.error ?? ''));
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n✅ test-pet-install-guards 通过');

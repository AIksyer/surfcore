// 卸载桌宠必须保留 data/，重装要能自动恢复；更新路径不应重复备份。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPetService } from '../lib/pet.js';

if (process.platform !== 'win32') {
  console.log('（非 Windows，跳过：解压依赖 PowerShell Expand-Archive）');
  process.exit(0);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-pet-uninstall-'));
const stateDir = path.join(base, 'state');
const appDir = path.join(base, 'app');
let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label} ${extra}`); }
};

const makePack = () => {
  const stage = path.join(base, 'stage');
  fs.mkdirSync(path.join(stage, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'feiyu-pet', version: '9.9.9' }));
  fs.writeFileSync(path.join(stage, 'dist', 'main.js'), '//');
  const zip = path.join(base, 'pet-pack.zip');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path '${path.join(stage, '*').replace(/'/g, "''")}' -DestinationPath '${zip.replace(/'/g, "''")}' -Force`], { stdio: 'ignore' });
  return zip;
};

const waitInstall = async (pet, timeoutMs = 20_000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = pet.status();
    if (!st.installing) return st;
    if (st.installing.phase === '失败' || st.installing.phase === '完成') return st;
    await new Promise((r) => setTimeout(r, 200));
  }
  return pet.status();
};

try {
  fs.mkdirSync(path.join(stateDir, 'pet'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'pet', 'config.json'), JSON.stringify({ appDir, source: '', electronPath: '' }));

  // 已安装状态：marker + data（用户聊天记录/设置）
  fs.mkdirSync(path.join(appDir, 'data', 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'skins'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'feiyu-pet', version: '9.9.8' }));
  fs.writeFileSync(path.join(appDir, '.surfcore-pet.json'), JSON.stringify({ app: 'surfcore-pet' }));
  fs.writeFileSync(path.join(appDir, 'data', 'userdata', 'chat.json'), '{"msgs":42}');

  const pet = createPetService({ stateDir, pluginLog: () => {}, getSubprocess: () => null });

  // 1) 卸载：目录被删，但 data 备份留下
  const removed = await pet.remove();
  ok(removed.ok === true, '卸载成功');
  ok(!fs.existsSync(appDir), '安装目录已删除');
  const keep = path.join(stateDir, 'pet-data-keep', 'data', 'userdata', 'chat.json');
  ok(fs.existsSync(keep), 'data/ 已备份到 pet-data-keep');
  ok(fs.readFileSync(keep, 'utf8').includes('42'), '备份内容正确');

  // 2) 重装：data 自动恢复
  const zip = makePack();
  fs.writeFileSync(path.join(stateDir, 'pet', 'config.json'), JSON.stringify({ appDir, source: zip, electronPath: '' }));
  pet.configure({ source: zip });
  await pet.startInstall(zip);
  const st2 = await waitInstall(pet);
  ok(st2.installed === true, '重装成功', JSON.stringify(st2.installing));
  ok(fs.existsSync(path.join(appDir, 'data', 'userdata', 'chat.json')), '重装后 data/ 自动恢复');
  ok(fs.readFileSync(path.join(appDir, 'data', 'userdata', 'chat.json'), 'utf8').includes('42'), '恢复的内容正确');

  // 3) 再卸载一次：备份应被覆盖成最新（不叠加多份）
  fs.writeFileSync(path.join(appDir, 'data', 'userdata', 'chat.json'), '{"msgs":99}');
  await pet.remove();
  const kept2 = fs.readFileSync(path.join(stateDir, 'pet-data-keep', 'data', 'userdata', 'chat.json'), 'utf8');
  ok(kept2.includes('99'), '第二次卸载的备份是最新数据');
  const keepDirs = fs.readdirSync(path.join(stateDir, 'pet-data-keep'));
  ok(keepDirs.filter((d) => d === 'data').length === 1, '备份目录只有一份，不叠加');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n✅ test-pet-uninstall-keep 通过');

// 回归：桌宠安装「填了表单却不生效」+ Windows 路径盘符校验
// 2026-10-30 用户反馈：填了安装目录、Electron 已下载，点「安装」仍报「请先填写安装包地址」，
// config.json 的 source/appDir 始终为空 —— 安装请求根本没带表单。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createPetService, checkAppDir } from '../lib/pet.js';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label} ${extra}`); }
};

// 1) 盘符校验：Windows 风格路径通过；POSIX 风格（/dswork/pet）必须被拒
{
  if (process.platform === 'win32') {
    const good = checkAppDir('D:\\dshwork\\pet', { allowNonEmpty: true });
    ok(good.ok === true || good.reason === '目录不可访问', '带盘符路径不被"缺盘符"误杀', JSON.stringify(good));
    const bad = checkAppDir('/dswork/pet', { allowNonEmpty: true });
    ok(bad.ok === false && bad.code === 'pet.path-no-drive', 'POSIX 风格路径 → code=pet.path-no-drive', JSON.stringify(bad));
    ok(typeof bad.hint === 'string' && bad.hint.includes('D:'), '给了 D:\\... 的改法', String(bad.hint));
  } else {
    console.log('ℹ  非 Windows，跳过盘符校验');
  }
}

// 2) 安装：没填安装包地址 → 结构化错误（field/code/hint），且不启动任务
{
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-pet-'));
  const pet = createPetService({ stateDir, pluginLog: () => {}, getSubprocess: () => null });
  const r = await pet.install('', { source: '', appDir: '', electronPath: '' });
  ok(r.ok === false && r.code === 'pet.source-missing', '空地址 → code=pet.source-missing', JSON.stringify(r));
  ok(r.field === 'source', '错误点名字段 source', String(r.field));
  ok(typeof r.hint === 'string' && r.hint.includes('官方'), '给了下一步（用官方最新版）', String(r.hint));
  const st = pet.status();
  ok(!st.installing, '没启动安装任务（不会卡"安装中"）', JSON.stringify(st.installing));
  fs.rmSync(stateDir, { recursive: true, force: true });
}

// 3) 安装：请求里的 appDir 必须先落盘（用户没点「保存设置」也要生效）
{
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-pet-'));
  const pet = createPetService({ stateDir, pluginLog: () => {}, getSubprocess: () => null });
  // source 用一个不存在的本地路径：会走到"找不到安装包"分支，但配置应已写入
  const r = await pet.install('C:\\definitely-not-exists\\pet-pack.zip', { appDir: 'C:\\pet-test-dir' });
  ok(r.ok === true && r.started === true, '安装任务已启动', JSON.stringify(r));
  const cfgFile = path.join(stateDir, 'pet', 'config.json');
  // 任务异步执行，稍等再读
  await new Promise((res) => setTimeout(res, 300));
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch {}
  ok(cfg && cfg.appDir === 'C:\\pet-test-dir', '请求里的 appDir 已落盘', JSON.stringify(cfg));
  ok(cfg && cfg.source === 'C:\\definitely-not-exists\\pet-pack.zip', '请求里的 source 已落盘', JSON.stringify(cfg));
  fs.rmSync(stateDir, { recursive: true, force: true });
}

// 4) 前端契约：安装/启动必须把表单带上
{
  const src = fs.readFileSync(path.join(REPO, 'plugins/surfcore/lib/client.js'), 'utf8');
  ok(/api\("\/pet\/install",[\s\S]{0,200}source: form\.source\.trim\(\)/.test(src), '安装请求带 source', '');
  ok(/api\("\/pet\/install",[\s\S]{0,260}appDir: form\.appDir\.trim\(\)/.test(src), '安装请求带 appDir', '');
  ok(/act\("start", \{ electronPath: form\.electronPath\.trim\(\) \}\)/.test(src), '启动请求带 electronPath', '');
  const host = fs.readFileSync(path.join(REPO, 'plugins/surfcore/lib/index.js'), 'utf8');
  ok(/petService\.install\(body\?\.source/.test(host), '后端 install 接收表单', '');
}

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n✅ test-pet-install-form 通过');

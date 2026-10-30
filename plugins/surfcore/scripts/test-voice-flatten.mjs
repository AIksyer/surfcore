// 语音包安装：GitHub 源码 zip 解压后是 <repo>-main/，必须拍平。
// 2026-10-28 报告 #1：旧判定看 config.toml，而仓库里只有 config.example.toml → 永远拍不平，
// 结果装成 voice-local/surfvoicelocal-main/…，后续全部失败。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flattenSingleDir } from '../../../src/voice-packs.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-flatten-'));
let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
};

try {
  // 场景 1：真实仓库布局（没有 config.toml，只有 config.example.toml / models.json / version.json）
  const d1 = path.join(base, 'p1');
  const inner1 = path.join(d1, 'surfvoicelocal-main');
  fs.mkdirSync(inner1, { recursive: true });
  fs.writeFileSync(path.join(inner1, 'config.example.toml'), 'x');
  fs.writeFileSync(path.join(inner1, 'models.json'), '{}');
  fs.writeFileSync(path.join(inner1, 'version.json'), '{}');
  const r1 = await flattenSingleDir(d1);
  ok(r1 === true, '没有 config.toml 也能拍平（按 config.example.toml/models.json 判定）');
  ok(fs.existsSync(path.join(d1, 'config.example.toml')), '文件被提到包根');
  ok(!fs.existsSync(inner1), '内层目录被删除');

  // 场景 2：正常的 pet-pack 风格（顶层就有 package.json）→ 不该动
  const d2 = path.join(base, 'p2');
  fs.mkdirSync(d2, { recursive: true });
  fs.writeFileSync(path.join(d2, 'package.json'), '{}');
  const r2 = await flattenSingleDir(d2);
  ok(r2 === false, '顶层已有包文件时不拍平');

  // 场景 3：多个目录（不是单层包装）→ 不该动
  const d3 = path.join(base, 'p3');
  fs.mkdirSync(path.join(d3, 'a'), { recursive: true });
  fs.mkdirSync(path.join(d3, 'b'), { recursive: true });
  fs.writeFileSync(path.join(d3, 'a', 'models.json'), '{}');
  const r3 = await flattenSingleDir(d3);
  ok(r3 === false, '多目录不拍平（避免误伤）');

  // 场景 4：单层但里面没有包标记（例如纯文档目录）→ 不该动
  const d4 = path.join(base, 'p4');
  fs.mkdirSync(path.join(d4, 'docs-only'), { recursive: true });
  fs.writeFileSync(path.join(d4, 'docs-only', 'readme.txt'), 'hi');
  const r4 = await flattenSingleDir(d4);
  ok(r4 === false, '没有包标记不拍平');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n✅ test-voice-flatten 通过');

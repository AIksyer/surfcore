// 回归守卫：语音包安装进度必须能跨请求存活。
// 2026-10-28 事故：/api/voice/* 为了"配置热生效"改成每个请求都 createVoicePacks()，
// 而安装进度（activeInstalls）存在实例里 → POST 的实例随请求结束销毁，
// 后续 GET 是新实例 → 前端永远拿不到进度，只显示"开始安装…"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve('../../src/bridge.js'), 'utf8');

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label} ${extra}`); }
};

const startIdx = src.indexOf('function startConsoleServer()');
ok(startIdx > 0, '找到 startConsoleServer');

const serverIdx = src.indexOf('http.createServer(async (req, res)', startIdx);
ok(serverIdx > startIdx, '找到请求处理入口');

const cacheIdx = src.indexOf('let vpCache', startIdx);
ok(cacheIdx > startIdx, '存在 vpCache 缓存');
ok(cacheIdx < serverIdx, 'vpCache 声明在请求回调**外面**（否则每个请求都会被重置）');
ok(src.includes('function getVoicePacksCached()'), '存在 getVoicePacksCached()');
ok(!/const vp = createVoicePacks\(freshCfg\)/.test(src), '不要在每个请求里直接 createVoicePacks（进度会丢）');

// config 变更仍要热生效：缓存 key 用 config.json 的 mtime+size
ok(/mtimeMs\}:?\$\{.*size|mtimeMs/.test(src), '缓存 key 基于 config.json 的 mtime（保证热生效）');

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n✅ test-voice-progress-instance 通过');

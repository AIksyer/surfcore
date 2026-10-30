// 回归：语音失败分类 + 换路策略 + 自检接线
// 2026-10-30：用户分不清「火山挂了 / 本地服务没起 / 音色映射错 / 限流」，全被转述成“TTS 没起来”。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { classifyVoiceError, pickFallbackRoute } from '../src/voice-diagnostics.js';

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label} ${extra}`); }
};

// 1) 分类：每种真实错误都要落到正确的 code/stage，并带可执行 hint
const cases = [
  ['语音发送频率超限（每分钟最多 2 条），请稍后再试', 'voice.rate-limited', 'send'],
  ['TTS 服务返回 503：角色「age12-cloud」没有配 [voice.characters] 映射', 'voice.config-mapping', 'config'],
  ['TTS 服务没起来（voxd 是否在运行？）：fetch failed', 'voice.service-down', 'service'],
  ['云端合成失败 401: {"code":45000001,"message":"invalid access key"}', 'voice.upstream-auth', 'upstream'],
  ['云端合成失败（网络？）: <urlopen error timed out>', 'voice.upstream-network', 'upstream'],
  ['TTS 服务返回 503：没有引擎能满足这个请求：cloud 不可用', 'voice.engine-failed', 'engine'],
  ['稀奇古怪的错误', 'voice.unknown', 'unknown'],
];
for (const [msg, code, stage] of cases) {
  const r = classifyVoiceError(msg);
  ok(r.code === code && r.stage === stage, `分类：${code}`, `${r.code}/${r.stage}`);
  ok(typeof r.hint === 'string' && r.hint.length > 4, `分类：${code} 有 hint`);
}

// 2) 换路：可重试的才换，且只换到另一条不同地址
{
  const ep = { local: 'http://127.0.0.1:8765', cloud: 'http://127.0.0.1:8767' };
  ok(pickFallbackRoute('cloud', ep, 'voice.upstream-network') === 'local', '云端网络失败 → 换本地');
  ok(pickFallbackRoute('local', ep, 'voice.service-down') === 'cloud', '本地服务没起 → 换云端');
  ok(pickFallbackRoute('cloud', ep, 'voice.rate-limited') === '', '限流不换路');
  ok(pickFallbackRoute('cloud', ep, 'voice.config-mapping') === '', '映射错误不换路');
  ok(pickFallbackRoute('cloud', { local: 'http://127.0.0.1:8767', cloud: 'http://127.0.0.1:8767' }, 'voice.upstream-network') === '', '同一地址不换路');
  ok(pickFallbackRoute('cloud', { cloud: 'http://127.0.0.1:8767' }, 'voice.upstream-network') === '', '没有另一条路就不换');
}

// 3) 接线：桥接/插件/前端三处都要有
{
  const bridge = fs.readFileSync(path.resolve('src/bridge.js'), 'utf8');
  ok(bridge.includes("from './voice-diagnostics.js'"), '桥接使用 voice-diagnostics');
  ok(/logVoiceError\(/.test(bridge), '桥接记录语音失败');
  ok(bridge.includes("err.code = 'voice.rate-limited'"), '限流错误带 code');
  ok(bridge.includes('/api/voice/tts-check'), '桥接提供语音自检端点');
  ok(/pickFallbackRoute\(/.test(bridge), '桥接调用换路策略');

  const host = fs.readFileSync(path.resolve('plugins/surfcore/lib/index.js'), 'utf8');
  ok(/voice\/tts-check/.test(host), '插件代理自检接口');

  const client = fs.readFileSync(path.resolve('plugins/surfcore/lib/client.js'), 'utf8');
  ok(client.includes('语音自检'), '语音页有自检卡片');
  ok(/api\("\/voice\/tts-check"/.test(client), '前端调用自检接口');
  ok(client.includes('stageRow'), '前端按阶段渲染结果');
}

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n✅ test-voice-diagnostics 通过');

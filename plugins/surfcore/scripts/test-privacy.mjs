/** 隐私闸门回归：私信/密钥/PII 必须被挡住，正常公开内容必须放行。 */
import assert from 'node:assert/strict';
import { sanitizeText, scanText, assertSafeOutput, isPublicGroupMessage } from '../lib/privacy.js';

const cases = [
  { text: '我的QQ是123456789，手机13800138000', ok: false, why: 'QQ号/手机号' },
  { text: '私信我，我告诉你', ok: false, why: '私信话题' },
  { text: '密码：abcd1234', ok: false, why: '密码' },
  { text: 'SESSDATA=abc123456789', ok: false, why: 'cookie' },
  { text: '今天看了个视频 BV1xx411c7mD 很好笑', ok: true, why: '正常内容' },
  { text: '这个猫猫好可爱 mer', ok: true, why: '正常内容' },
  { text: '我住在北京市朝阳区某某小区', ok: false, why: '住址' },
  { text: '身份证 110101199001011234', ok: false, why: '身份证' },
];
for (const item of cases) {
  const result = sanitizeText(item.text);
  assert.equal(result.ok, item.ok, `${item.why}: ${JSON.stringify(result)}`);
}

assert.equal(scanText('sk-1234567890abcdef1234567890abcdef').severe, true);
assert.throws(() => assertSafeOutput('password: hunter2'), /隐私闸门拒绝/);
assert.doesNotThrow(() => assertSafeOutput('今天看了个视频，挺好笑的'));

assert.equal(isPublicGroupMessage({ key: 'private:12345', groupIds: [], text: 'hi' }).ok, false);
assert.equal(isPublicGroupMessage({ key: 'group:767098733', groupIds: ['767098733'], text: 'hi' }).ok, true);
assert.equal(isPublicGroupMessage({ key: 'group:999999999', groupIds: ['767098733'], text: 'hi' }).ok, false);
assert.equal(isPublicGroupMessage({ key: 'group:767098733', groupIds: ['767098733'], text: '/reset' }).ok, false);

console.log('privacy tests OK');

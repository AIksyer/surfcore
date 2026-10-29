/** 身份对齐回归：候选识别、B站简报不带 QQ 号、优先级说明。 */
import assert from 'node:assert/strict';
import {
  buildBiliAlignmentBrief, buildQqAlignmentBrief, detectCandidatesFromText,
} from '../lib/align.js';

const qqCandidate = detectCandidatesFromText({
  platform: 'qq',
  text: '我B站 UID: 87654321 名字叫零酱',
  author: { id: '10001', name: '阿零' },
  counterpartPlatform: 'bili',
});
assert.ok(qqCandidate.some((c) => c.platform === 'qq' && c.counterpart?.id === '87654321'), JSON.stringify(qqCandidate));
assert.ok(qqCandidate.every((c) => c.counterpart?.name !== 'UID'));

const biliCandidate = detectCandidatesFromText({
  platform: 'bili',
  text: '加我QQ 12345678 一起玩',
  author: { id: '20002', name: '零酱' },
  counterpartPlatform: 'qq',
});
assert.ok(biliCandidate.some((c) => c.platform === 'bili' && c.counterpart?.id === '12345678'), JSON.stringify(biliCandidate));

const links = [{
  identities: {
    qq: { id: '10001', name: '阿零', groups: ['767098733'] },
    bili: { id: '87654321', name: '零酱' },
  },
  source: 'test',
  confidence: 1,
  verified: true,
}];
const qqBrief = buildQqAlignmentBrief({ groupIds: ['767098733'], links });
assert.ok(qqBrief.includes('零酱'));
assert.ok(!qqBrief.includes('10001'), 'QQ 对齐简报不应出现 QQ 号（没设称呼时）');
assert.ok(qqBrief.includes('最高优先级'));
assert.ok(qqBrief.includes('按群昵称认人'));
assert.ok(!qqBrief.includes('优先于人格卡'), '没设称呼时不注入称呼规则');

const biliBrief = buildBiliAlignmentBrief({ links });
assert.ok(biliBrief.includes('零酱'));
assert.ok(!biliBrief.includes('10001'), 'B站对齐简报不应出现 QQ 号');
assert.ok(!biliBrief.includes('767098733'), 'B站对齐简报不应出现群号');

// ── 称呼（label）：以后只叫这个 ──────────────────────────────────────────────
const labeled = [{
  identities: {
    qq: { id: '10001', name: '阿零', groups: ['767098733'] },
    bili: { id: '87654321', name: '零酱' },
  },
  label: '小零',
  source: 'manual',
  confidence: 1,
  verified: true,
}];
const qqLabeled = buildQqAlignmentBrief({ links: labeled });
assert.ok(qqLabeled.includes('以后只叫 TA「小零」'), 'QQ 简报必须写明只用称呼');
assert.ok(qqLabeled.includes('10001'), '有称呼时要带 QQ 号：只能按 ID 对上，不能靠会变的群昵称');
assert.ok(qqLabeled.includes('优先于人格卡'), '称呼规则要高于人格卡称呼表');
assert.ok(qqLabeled.includes('绝对不要念出来'), '带号码时必须重申不要念号码');

const biliLabeled = buildBiliAlignmentBrief({ links: labeled });
assert.ok(biliLabeled.includes('小零'), 'B站 简报也要带称呼');
assert.ok(biliLabeled.includes('以后只叫 TA「小零」'));
assert.ok(!biliLabeled.includes('10001'), 'B站 简报仍然不能出现 QQ 号');
assert.ok(biliLabeled.includes('优先于人格卡'));

// ── 只有 QQ / 只有 B站：也可以设称呼，只在有账号的那一侧出现 ─────────────────
const qqOnly = [{
  identities: { qq: { id: '10002', name: '阿零2' } },
  label: '小二',
  source: 'manual',
  confidence: 1,
  verified: true,
}];
const qqOnlyBrief = buildQqAlignmentBrief({ links: qqOnly });
assert.ok(qqOnlyBrief.includes('小二'), '只有 QQ 的人也要能设称呼');
assert.ok(qqOnlyBrief.includes('10002'), '只有 QQ 的人按 QQ 号对上');
assert.ok(qqOnlyBrief.includes('只在 QQ 登记'), '要明确这是“只有 QQ”的登记');
assert.equal(buildBiliAlignmentBrief({ links: qqOnly }), '', '只有 QQ 的人不能出现在 B站 简报');

const biliOnly = [{
  identities: { bili: { id: '87654322', name: '孤鱼' } },
  label: '小鱼',
  source: 'manual',
  confidence: 1,
  verified: true,
}];
const biliOnlyBrief = buildBiliAlignmentBrief({ links: biliOnly });
assert.ok(biliOnlyBrief.includes('小鱼'), '只有 B站 的人也要能设称呼');
assert.ok(biliOnlyBrief.includes('87654322'), '只有 B站 的人按 mid 对上');
assert.ok(biliOnlyBrief.includes('只在 B站 登记'), '要明确这是“只有 B站”的登记');
assert.equal(buildQqAlignmentBrief({ links: biliOnly }), '', '只有 B站 的人不能出现在 QQ 简报');

// 只有一边、又没设称呼：没有提示价值，不占预算（保持旧行为）。
assert.equal(buildQqAlignmentBrief({ links: [{ identities: { qq: { id: '10003', name: 'x' } } }] }), '');
assert.equal(buildBiliAlignmentBrief({ links: [{ identities: { bili: { id: '87654323', name: 'y' } } }] }), '');

console.log('align tests OK');

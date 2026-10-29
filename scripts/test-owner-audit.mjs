// 主人特权操作审计回归（纯本地临时目录，不碰真实 state/）。
//
// 钉住：结构/轮转/跨文件读尾/写入失败可见/旧文件清理/不写正文。
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnerAudit } from '../src/owner-audit.js';

let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
};

const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'surfcore-audit-'));
try {
  console.log('## 1. 写入结构与字段');
  {
    const dir = path.join(base, 'basic');
    const audit = createOwnerAudit({ dir });
    const wrote = audit.append('question.answer', {
      actor: { platform: 'qq', id: '10001', isOwner: false },
      auth: { rule: 'ownerOnly', decision: 'deny' },
      result: { ok: false, errorCode: 'not-owner' },
      ref: { session: 'group:1' },
    });
    ok(wrote === true, 'append 返回 true');
    const lines = fs.readFileSync(audit.path, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[0]);
    ok(/^\d{4}-\d{2}-\d{2}T/.test(entry.at), '有 ISO 时间戳');
    ok(entry.event === 'question.answer', '事件名');
    ok(entry.actor.id === '10001' && entry.actor.isOwner === false, '操作者标识完整保存');
    ok(entry.auth.rule === 'ownerOnly' && entry.auth.decision === 'deny', '授权判定');
    ok(entry.result.ok === false && entry.result.errorCode === 'not-owner', '执行结果');
    ok(entry.ref.session === 'group:1', '关联 ID');
    ok(!JSON.stringify(entry).includes('【回答者') && !JSON.stringify(entry).includes('token'), '不写正文/token');
  }

  console.log('## 2. 轮转与跨文件读尾');
  {
    const dir = path.join(base, 'rotate');
    // 每条约 100B；maxBytes 设 250 → 每条都接近一轮。
    const audit = createOwnerAudit({ dir, maxBytes: 250, maxFiles: 3 });
    for (let i = 0; i < 12; i += 1) {
      audit.append('approval.answer', {
        actor: { platform: 'qq', id: String(10000 + i), isOwner: true },
        auth: { rule: 'ownerQQ', decision: 'allow' },
        result: { ok: true },
        ref: { session: `private:${i}` },
      });
    }
    ok(fs.existsSync(audit.path), '主文件存在');
    ok(fs.existsSync(`${audit.path}.1`), '轮转出 .1');
    ok(!fs.existsSync(`${audit.path}.3`), `maxFiles=3 时不产生 .3`);
    const tail = audit.readTail(3);
    ok(tail.length === 3, 'readTail 能跨轮转文件拿到最近 3 条');
    ok(tail[2].ref.session === 'private:11', '最新一条在最末');
    ok(tail.every((e) => e.event === 'approval.answer'), '读回的仍是结构化条目');
  }

  console.log('## 3. 写入失败必须可见（不能装作成功）');
  {
    const dir = path.join(base, 'broken');
    await fsp.mkdir(path.join(dir, 'owner-audit.jsonl'), { recursive: true }); // 同名目录 → append EISDIR
    const logs = [];
    const audit = createOwnerAudit({ dir, log: (...a) => logs.push(a.join(' ')) });
    const wrote = audit.append('role.switch', { actor: { id: '1', isOwner: true } });
    ok(wrote === false, 'append 返回 false');
    ok(audit.health.writable === false, 'health.writable=false');
    ok(Boolean(audit.health.lastError), 'health 记录错误');
    ok(logs.some((line) => line.includes('审计写入失败')), '错误写进 log（不静默）');
  }

  console.log('## 4. 90 天清理（旧轮转文件删、主文件不动）');
  {
    const dir = path.join(base, 'cleanup');
    const audit = createOwnerAudit({ dir, retentionDays: 1 });
    audit.append('memory.alert', { actor: { id: '1', isOwner: true } });
    await fsp.writeFile(`${audit.path}.1`, '{}\n', 'utf8');
    await fsp.writeFile(`${audit.path}.2`, '{}\n', 'utf8');
    const old = new Date(Date.now() - 3 * 86400_000);
    fs.utimesSync(`${audit.path}.1`, old, old);
    const fresh = new Date();
    fs.utimesSync(`${audit.path}.2`, fresh, fresh);
    audit.cleanupOld();
    ok(!fs.existsSync(`${audit.path}.1`), '超过保留期的 .1 被删');
    ok(fs.existsSync(`${audit.path}.2`), '未过期的 .2 保留');
    ok(fs.existsSync(audit.path), '主文件不动');
  }
} finally {
  await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
}

console.log(failures === 0 ? '\n✅ 审计模块回归通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);

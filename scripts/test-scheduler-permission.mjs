// B站 会话权限自动校正（2026-10-23）。
// 背景：会话 cwd=C:\Users\Mieksido 在 workspace-write 下起不了命令，定时任务只能干等审批。
// 这里只测纯逻辑（mock ctx.permissionPresets / ctx.sessions），不碰真实 DSH。
import assert from 'node:assert/strict';
import { applySessionPermission, applySessionPermissionTo } from '../plugins/surfcore/lib/scheduler.js';

function makeCtx({ session = null, current = 'workspace-write', throwSet = false } = {}) {
  const calls = [];
  const ctx = {
    sessions: { get: (id) => (id === 'bili-whale-test' ? session : undefined) },
    permissionPresets: {
      current: () => current,
      set: (s, target) => {
        if (throwSet) throw new Error('unknown preset');
        calls.push([s, target]);
      },
    },
  };
  return { ctx, calls };
}

// 1) 新会话是 workspace-write → 切到 danger-full-access
{
  const session = { id: 'bili-whale-test' };
  const { ctx, calls } = makeCtx({ session });
  const r = applySessionPermission(ctx, 'bili-whale-test', 'danger-full-access');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.changed, true);
  assert.deepEqual(calls, [[session, 'danger-full-access']]);
}

// 2) 已经是目标权限 → 不重复写
{
  const { ctx, calls } = makeCtx({ session: { id: 'x' }, current: 'danger-full-access' });
  const r = applySessionPermission(ctx, 'bili-whale-test', 'danger-full-access');
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(calls.length, 0);
}

// 3) 会话还没挂上 → 返回 session-not-active，不抛（下一 tick 再试）
{
  const { ctx, calls } = makeCtx();
  const r = applySessionPermission(ctx, 'bili-whale-test', 'danger-full-access');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'session-not-active');
  assert.equal(calls.length, 0);
}

// 4) 宿主没有 permissionPresets 服务 → 不抛
{
  const r = applySessionPermission({}, 'bili-whale-test', 'danger-full-access');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'permission-services-unavailable');
}

// 5) 预设名不存在（set 抛错）→ 返回 set-failed，不把生物钟带崩
{
  const { ctx } = makeCtx({ session: { id: 'x' }, throwSet: true });
  const r = applySessionPermission(ctx, 'bili-whale-test', 'danger-full-access');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'set-failed');
}

// 6) 默认目标是 danger-full-access（避免调用方漏传时变成收紧）
{
  const { ctx, calls } = makeCtx({ session: { id: 'x' } });
  const r = applySessionPermission(ctx, 'bili-whale-test');
  assert.equal(r.ok, true);
  assert.equal(calls[0][1], 'danger-full-access');
}

// 7) Cordis 服务通过 ctx.get() 暴露（插件没 inject 时走这条）也要能拿到
{
  const session = { id: 'x' };
  const calls = [];
  const viaGet = {
    get(name) {
      if (name === 'sessions') return { get: () => session };
      if (name === 'permissionPresets') return { current: () => 'workspace-write', set: (s, t) => calls.push([s, t]) };
      return undefined;
    },
  };
  const r = applySessionPermission(viaGet, 'bili-whale-test', 'danger-full-access');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(calls, [[session, 'danger-full-access']]);
}

// 8) 直接拿 session 对象（session/created 事件路径）也能设置
{
  const session = { id: 'created-session' };
  const { ctx, calls } = makeCtx({});
  const r = applySessionPermissionTo(ctx, session, 'danger-full-access');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(calls, [[session, 'danger-full-access']]);
}

// 9) 未 inject 服务时，直接访问 ctx.sessions 会抛；必须回退到 ctx.get()
//    （2026-10-23 真实踩到：ctx.get('permissionPresets') 明明存在，却因为
//     `ctx.sessions ?? ctx.get('sessions')` 先抛而整段变成 unavailable）
{
  const session = { id: 'x' };
  const calls = [];
  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: () => session };
      if (name === 'permissionPresets') return { current: () => 'workspace-write', set: (s, t) => calls.push([s, t]) };
      return undefined;
    },
  };
  Object.defineProperty(ctx, 'sessions', { get() { throw new Error('service not injected'); } });
  Object.defineProperty(ctx, 'permissionPresets', { get() { throw new Error('service not injected'); } });
  const r = applySessionPermission(ctx, 'bili-whale-test', 'danger-full-access');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(calls, [[session, 'danger-full-access']]);
}

console.log('scheduler permission tests OK');

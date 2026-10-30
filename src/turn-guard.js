/**
 * 单轮止血：只做纯策略，不碰 DSH / QQ / 文件。
 *
 * 触发条件只有三类：
 *   · 单轮工具步数超上限；
 *   · 同一 tool + 同一错误重复到阈值；
 *   · 每日额度在回合中间被判定为已耗尽。
 *
 * 真正的 cancel / 通知由 bridge 做；这里只回答“该不该停、为什么停”。
 */
export const DEFAULT_TURN_GUARD = Object.freeze({
  maxSteps: 40,
  maxRepeatedErrors: 3,
})

function normalizeError(text) {
  return String(text ?? '')
    .replace(/\b\d+(?:\.\d+)?\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

export function createTurnGuard(options = {}) {
  const cfg = { ...DEFAULT_TURN_GUARD, ...(options && typeof options === 'object' ? options : {}) };
  const maxSteps = Math.max(1, Math.round(Number(cfg.maxSteps) || DEFAULT_TURN_GUARD.maxSteps));
  const maxRepeatedErrors = Math.max(1, Math.round(Number(cfg.maxRepeatedErrors) || DEFAULT_TURN_GUARD.maxRepeatedErrors));
  const turns = new Map();

  function begin(sessionId, key = '', now = Date.now()) {
    const state = {
      sessionId,
      key,
      startedAt: now,
      steps: 0,
      errors: new Map(),
      stopped: false,
      stopReason: null,
    };
    turns.set(sessionId, state);
    return state;
  }

  function get(sessionId) {
    return turns.get(sessionId) ?? null;
  }

  function stop(state, code, reason, evidence = {}) {
    if (!state || state.stopped) return null;
    state.stopped = true;
    state.stopReason = { code, reason, evidence };
    return state.stopReason;
  }

  /** 一次工具调用算一步；达到上限就停。 */
  function noteStep(sessionId) {
    const state = turns.get(sessionId);
    if (!state || state.stopped) return null;
    state.steps += 1;
    if (state.steps > maxSteps) {
      return stop(state, 'TURN_STEPS_EXCEEDED', `单轮工具步数超过 ${maxSteps}`, {
        steps: state.steps,
        maxSteps,
      });
    }
    return null;
  }

  /** 工具错误：同一个 tool + 归一化错误重复到阈值就停。 */
  function noteToolError(sessionId, tool, error) {
    const state = turns.get(sessionId);
    if (!state || state.stopped) return null;
    const fingerprint = `${String(tool ?? '')}:${normalizeError(error)}`;
    const count = (state.errors.get(fingerprint) ?? 0) + 1;
    state.errors.set(fingerprint, count);
    if (count >= maxRepeatedErrors) {
      return stop(state, 'TURN_REPEATED_TOOL_ERROR', `同一工具错误连续出现 ${count} 次`, {
        tool: String(tool ?? ''),
        fingerprint,
        count,
        maxRepeatedErrors,
      });
    }
    return null;
  }

  /** 回合内每日额度已耗尽。 */
  function noteBudgetExhausted(sessionId, hits = []) {
    const state = turns.get(sessionId);
    if (!state || state.stopped) return null;
    return stop(state, 'TURN_BUDGET_EXHAUSTED', '回合进行中每日额度已耗尽', { hits });
  }

  function end(sessionId) {
    turns.delete(sessionId);
  }

  return { begin, get, noteStep, noteToolError, noteBudgetExhausted, end, config: { maxSteps, maxRepeatedErrors } };
}

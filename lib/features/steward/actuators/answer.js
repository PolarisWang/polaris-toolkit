/**
 * 代答执行器：回答 root agent 挂着的提问。
 *
 * 宿主硬约束（dsh-user-questions assertLiveRoot）：只能对 root agent 代答；
 * 子 agent 的提问只能 steer 它的父会话。这里把越权变成可预期的 { ok:false }。
 */
export function createAnswerer(options) {
  const o = options === undefined ? {} : options;
  const log = typeof o.log === "function" ? o.log : () => {};
  return {
    async answer(ctx, request) {
      let svc;
      try { svc = ctx.get("userQuestions"); } catch { svc = undefined; }
      if (svc === undefined || svc === null) return { ok: false, reason: "user-questions-unavailable" };
      try {
        await svc.answer(request.agent, request.callId, { answers: request.answers });
        return { ok: true };
      } catch (error) {
        const code = error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : String(error);
        log("warn", "answer failed for " + String(request.callId) + ": " + code);
        return { ok: false, reason: code };
      }
    }
  };
}

/**
 * 投递执行器：往会话里发消息（等价于 GUI 里输入）。
 *
 * 走 sessionController.prompt —— 和 GUI 同一个入口，因此自带 requestId 幂等：
 * 同一个 requestId 重复投递不会产生第二条消息。这也正是工作流重试的幂等键。
 */
export function createPrompter(options) {
  const o = options === undefined ? {} : options;
  const log = typeof o.log === "function" ? o.log : () => {};
  function controller(ctx) {
    try { return ctx.get("sessionController"); } catch { return undefined; }
  }
  return {
    /** mode: "followup"（下一轮，默认）或 "steer"（下一步，打断当前思考）。 */
    async prompt(ctx, request) {
      const svc = controller(ctx);
      if (svc === undefined || svc === null) return { ok: false, reason: "session-controller-unavailable" };
      try {
        await svc.prompt({ sessionId: request.sessionId, content: request.content, mode: request.mode, requestId: request.requestId });
        return { ok: true, requestId: request.requestId };
      } catch (error) {
        const code = error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : String(error);
        log("warn", "prompt to " + request.sessionId + " failed: " + code);
        return { ok: false, reason: code };
      }
    }
  };
}

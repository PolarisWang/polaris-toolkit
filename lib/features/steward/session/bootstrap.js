/**
 * 总管会话的创建/恢复。
 *
 * 关键约束：会话必须是真实 DSH 会话（侧边栏可见、能被用户直接打字），
 * 且不能出现在自己的观察名单里（否则它会观察到自己，形成自激）。
 * 任何一步失败都只降级为“没有会话”，绝不阻断插件加载。
 */
export function createSessionBinder(options) {
  const o = options === undefined ? {} : options;
  const log = typeof o.log === "function" ? o.log : () => {};
  let bound = null;

  function agentsOf(ctx) {
    try { return ctx.get("agents"); } catch { return undefined; }
  }

  return {
    /** 返回 { ok, sessionId, agentId, created } 或 { ok:false, reason }。 */
    ensure(ctx, settings) {
      const cfg = settings === undefined ? {} : settings;
      const agents = agentsOf(ctx);
      if (agents === undefined || agents === null) return { ok: false, reason: "agents-unavailable" };
      if (typeof cfg.sessionId === "string" && cfg.sessionId !== "") {
        try {
          const agent = typeof agents.get === "function" ? agents.get(cfg.sessionId) : undefined;
          if (agent !== undefined && agent !== null) {
            bound = agent;
            return { ok: true, sessionId: cfg.sessionId, agentId: agent.id, created: false };
          }
        } catch (error) { log("warn", "steward session lookup failed: " + String(error)); }
      }
      if (typeof agents.create !== "function") return { ok: false, reason: "agents-create-unavailable" };
      try {
        const agent = agents.create({ preset: cfg.preset === undefined ? "steward" : cfg.preset, title: cfg.title === undefined ? "大内总管" : cfg.title });
        if (agent === undefined || agent === null) return { ok: false, reason: "agents-create-returned-nothing" };
        bound = agent;
        const sessionId = agent.session !== undefined && agent.session !== null ? agent.session.id : agent.id;
        return { ok: true, sessionId, agentId: agent.id, created: true };
      } catch (error) {
        log("warn", "steward session create failed: " + String(error));
        return { ok: false, reason: String(error) };
      }
    },
    current() { return bound; },
    reset() { bound = null; }
  };
}

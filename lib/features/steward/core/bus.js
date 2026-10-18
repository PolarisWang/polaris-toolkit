/**
 * Steward: 宿主事件总线订阅。
 *
 * 只做三件事：把事件落到账本、把值得注意的变化变成 signal、把出错压成日志。
 * 任何 handler 抛异常都必须在本地吞掉——订阅者挂了不能影响宿主其它订阅者。
 */

const INTERESTING_SESSION_EVENTS = new Set([
  "turn/start",
  "turn/end",
  "message/user",
  "message/assistant",
  "tool/call",
  "tool/result",
  "session/title",
  "error"
]);

function pickAgentId(payload) {
  if (payload === null || typeof payload !== "object") return undefined;
  if (payload.agent !== undefined && payload.agent !== null && payload.agent.id !== undefined) return String(payload.agent.id);
  if (payload.agentId !== undefined) return String(payload.agentId);
  if (payload.id !== undefined) return String(payload.id);
  return undefined;
}

function pickSessionId(payload) {
  if (payload === null || typeof payload !== "object") return undefined;
  if (payload.sessionId !== undefined) return String(payload.sessionId);
  if (payload.session !== undefined && payload.session !== null && payload.session.id !== undefined) return String(payload.session.id);
  if (payload.agent !== undefined && payload.agent !== null && payload.agent.sessionId !== undefined) return String(payload.agent.sessionId);
  return undefined;
}

export function createBus({ ctx, store, log }) {
  const offs = [];
  const seenTypes = Object.create(null);

  function on(event, handler) {
    try {
      const off = ctx.on(event, (payload) => {
        seenTypes[event] = (seenTypes[event] || 0) + 1;
        try {
          handler(payload === null || payload === undefined ? {} : payload);
        } catch (error) {
          if (log !== undefined) log("warn", "steward bus handler " + event + " failed: " + String(error));
        }
      });
      if (typeof off === "function") offs.push(off);
    } catch (error) {
      if (log !== undefined) log("warn", "steward bus subscribe " + event + " failed: " + String(error));
    }
  }

  on("agent/created", (payload) => {
    const id = pickAgentId(payload);
    const sessionId = pickSessionId(payload);
    store.counters.created += 1;
    if (id === undefined) return;
    store.touch(id, "agent/created", { sessionId, status: "idle" });
    store.append("agent/created", { agentId: id, sessionId });
  });

  on("agent/disposed", (payload) => {
    const id = pickAgentId(payload);
    store.counters.disposed += 1;
    if (id === undefined) return;
    const rec = store.agents.get(id);
    store.append("agent/disposed", { agentId: id, sessionId: rec === undefined ? undefined : rec.sessionId });
    store.drop(id);
  });

  on("agent/status", (payload) => {
    const id = pickAgentId(payload);
    if (id === undefined) return;
    const status = typeof payload.status === "string" ? payload.status : (payload.agent !== undefined && payload.agent !== null ? payload.agent.status : undefined);
    if (typeof status !== "string") return;
    const rec = store.setStatus(id, status);
    if (rec.attention === true && status === "running") {
      store.pushSignal({ kind: "attention-cleared", severity: "info", agentId: id, sessionId: rec.sessionId, message: "agent resumed running, attention cleared" });
    }
  });

  on("agent/error", (payload) => {
    const id = pickAgentId(payload);
    const message = payload.message !== undefined ? payload.message : (payload.error !== undefined ? payload.error : "agent error");
    store.counters.errors += 1;
    if (id !== undefined) store.touch(id, "agent/error", { errors: (store.agents.get(id) === undefined ? 0 : store.agents.get(id).errors) + 1, attention: true, attentionReason: "agent/error" });
    store.pushSignal({ kind: "agent/error", severity: "error", agentId: id, sessionId: pickSessionId(payload), message: String(message) });
  });

  on("agent/request-error", (payload) => {
    const id = pickAgentId(payload);
    store.counters.errors += 1;
    store.pushSignal({ kind: "agent/request-error", severity: "error", agentId: id, sessionId: pickSessionId(payload), message: String(payload.message !== undefined ? payload.message : "request error") });
  });

  on("agent/turn-stopping", (payload) => {
    const id = pickAgentId(payload);
    if (id === undefined) return;
    const rec = store.touch(id, "agent/turn-stopping", {});
    rec.turns += 1;
    store.counters.userTurns += 1;
  });

  on("agent/inbox/inserted", (payload) => {
    const id = pickAgentId(payload);
    if (id === undefined) return;
    store.touch(id, "agent/inbox/inserted", { lastInboxAt: Date.now() });
  });

  on("subagent/start", (payload) => {
    store.counters.subagents += 1;
    store.append("subagent/start", { parent: pickAgentId(payload), child: payload.childSessionId === undefined ? undefined : String(payload.childSessionId) });
  });

  on("subagent/end", (payload) => {
    store.append("subagent/end", { parent: pickAgentId(payload), child: payload.childSessionId === undefined ? undefined : String(payload.childSessionId) });
  });

  on("session/created", (payload) => {
    store.append("session/created", { sessionId: pickSessionId(payload) });
  });

  on("session/disposed", (payload) => {
    store.append("session/disposed", { sessionId: pickSessionId(payload) });
  });

  on("session/event", (payload) => {
    const type = payload.type !== undefined ? String(payload.type) : (payload.event !== undefined && payload.event.type !== undefined ? String(payload.event.type) : "");
    if (!INTERESTING_SESSION_EVENTS.has(type)) return;
    const id = pickAgentId(payload);
    const sessionId = pickSessionId(payload);
    if (id !== undefined) store.touch(id, "session/event:" + type, {});
    if (type === "turn/start" || type === "message/user") {
      store.append("session/event", { sessionId, type });
    }
  });

  on("session/title", (payload) => {
    const sessionId = pickSessionId(payload);
    const title = payload.title === undefined ? undefined : String(payload.title);
    if (sessionId === undefined || title === undefined) return;
    for (const rec of store.agents.values()) {
      if (rec.sessionId === sessionId) rec.title = title;
    }
    store.append("session/title", { sessionId, title, source: payload.source });
  });

  function dispose() {
    for (const off of offs) {
      try { off(); } catch { /* ignore */ }
    }
    offs.length = 0;
  }

  return { dispose, seenTypes, subscriptions: offs.length };
}

export default { createBus };

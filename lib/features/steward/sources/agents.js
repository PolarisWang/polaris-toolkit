/**
 * Steward: agent 观察源。
 *
 * 事实来源（都是宿主 0.2.1 里真实存在的服务）：
 *   - ctx.agents.list()                     → [{ id, status, sessionId }]
 *   - ctx.userQuestions.continued(agent)    → 还挂着的提问（只能查 root agent）
 *   - 事件总线                                 → 变更时刻与静默时长
 *
 * 关键设计：agent/status 只在 idle↔running 变化时发，所以"卡住"必须靠
 * 最后一次事件的时间差合成（stalled），不能等宿主告诉我们。
 */
const STALL_MS = 8 * 60_000;

export function createAgentsSource({ ctx, store, titles, log }) {
  let lastSync = 0;
  let lastError;

  function service(name) {
    try { return ctx.get(name); } catch { return undefined; }
  }

  function questionsOf(agent) {
    const uq = service("userQuestions");
    if (uq === undefined || typeof uq.continued !== "function") return [];
    try {
      const list = uq.continued(agent);
      return Array.isArray(list) ? list : [];
    } catch (error) {
      lastError = String(error);
      if (log !== undefined) log("debug", "steward: continued() failed: " + lastError);
      return [];
    }
  }

  /** 把宿主当前的 agent 列表并入账本，并合成 stalled / question 两种"注意"。 */
  function sync(now) {
    const t = now === undefined ? Date.now() : now;
    lastSync = t;
    const registry = (function () {
      try { return ctx.agents; } catch { return undefined; }
    })();
    if (registry === undefined || typeof registry.list !== "function") return 0;
    let list;
    try { list = registry.list(); } catch (error) { lastError = String(error); return 0; }
    if (!Array.isArray(list)) return 0;
    const live = new Set();
    for (const agent of list) {
      if (agent === null || agent === undefined) continue;
      const id = String(agent.id);
      live.add(id);
      const rec = store.touch(id, "sync", {});
      // agent id 形如 "session-<uuid>"，会话 id 是裸 uuid；registry.list() 不一定带
      // sessionId，所以这里必须能从 id 反推出来，否则标题永远查不到（两套键不相交）。
      const rawSession = agent.sessionId === undefined || agent.sessionId === null ? undefined : String(agent.sessionId);
      rec.sessionId = rawSession === undefined
        ? (rec.sessionId === undefined ? (id.startsWith("session-") ? id.slice(8) : id) : rec.sessionId)
        : (rawSession.startsWith("session-") ? rawSession.slice(8) : rawSession);
      const cwd = agent.cwd !== undefined ? agent.cwd : (agent.session !== undefined && agent.session !== null ? agent.session.cwd : undefined);
      if (cwd !== undefined) rec.cwd = String(cwd);
      if (typeof rec.title !== "string") {
        const title = titles.get(rec.sessionId) === undefined ? titles.get(id) : titles.get(rec.sessionId);
        if (title !== undefined) rec.title = title;
      }
      const status = typeof agent.status === "string" ? agent.status : "unknown";
      if (rec.status !== status) store.setStatus(id, status, t);

      rec.stalled = rec.status === "running" && t - rec.lastEventAt > STALL_MS;
      if (rec.stalled === true && rec.stallAlerted !== true) {
        rec.stallAlerted = true;
        store.pushSignal({
          kind: "agent/stalled",
          severity: "warning",
          agentId: rec.id,
          sessionId: rec.sessionId,
          moduleId: rec.moduleId,
          message: "running but silent for " + Math.round((t - rec.lastEventAt) / 60000) + " min"
        });
      }
      if (rec.stalled !== true) rec.stallAlerted = false;

      const questions = questionsOf(agent);
      if (questions.length > 0) {
        const since = rec.question === undefined ? t : rec.question.since;
        rec.question = { count: questions.length, since, lastCallId: questions[questions.length - 1].callId };
        if (rec.attention !== true) {
          rec.attention = true;
          rec.attentionReason = "user-question";
          store.pushSignal({
            kind: "agent/question",
            severity: "warning",
            agentId: rec.id,
            sessionId: rec.sessionId,
            moduleId: rec.moduleId,
            message: "waiting for an answer: " + String(questions[questions.length - 1].title === undefined ? questions[questions.length - 1].callId : questions[questions.length - 1].title)
          });
        }
      } else if (rec.question !== undefined) {
        rec.question = undefined;
        if (rec.attentionReason === "user-question") { rec.attention = false; rec.attentionReason = undefined; }
      }
    }
    for (const rec of Array.from(store.agents.values())) {
      if (!live.has(rec.id)) rec.gone = true;
    }
    return list.length;
  }

  async function refreshTitles() {
    const ids = [];
    for (const rec of store.agents.values()) {
      if (rec.sessionId !== undefined) ids.push(rec.sessionId);
      ids.push(rec.id);
    }
    const map = await titles.refresh(ids);
    let named = 0;
    for (const rec of store.agents.values()) {
      const title = titles.get(rec.sessionId) === undefined ? titles.get(rec.id) : titles.get(rec.sessionId);
      if (title !== undefined) { rec.title = title; named += 1; }
    }
    return named;
  }

  return { sync, refreshTitles, get lastSync() { return lastSync; }, get lastError() { return lastError; } };
}

export default { createAgentsSource };

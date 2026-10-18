/**
 * Steward 状态视图层（评审第 8 项拆分的产物）：账本 + 健康 + 模块桶 → 面板/API 的 JSON。
 *
 * 全部是纯读取（不改 store、不发副作用），所以可以安全地被 http.js 的 /api/state、
 * /api/modules、/api/agents 等路由按需调用。依赖的只是装配时传进来的 S。
 */
export function createViews(S) {
  const { store, titles, health, events, modules, readSettings, approvals, engine, scope } = S;

  function stewardSnapshot() {
    const snap = store.snapshot();
    return {
      at: Date.now(),
      hostId: String(readSettings().federation.hostId),
      health: health.last,
      metrics: scope.metrics.snapshot(),
      modules: modulesView(),
      agents: agentsView(),
      signals: snap.signals,
      counters: snap.counters,
      runs: runsView(50),
      approvals: approvalsView(),
      budget: budgetView(Date.now()),
      titles: { size: titles.size() }
    };
  }

  function modulesView() {
    const mods = modules();
    return mods.map((mod) => {
      const rows = Array.from(store.agents.values()).filter((rec) => rec.moduleId === mod.id);
      return {
        id: mod.id, name: mod.name, host: mod.host, enabled: mod.enabled,
        count: rows.length,
        running: rows.filter((rec) => rec.status === "running").length,
        attention: rows.filter((rec) => rec.attention === true || rec.stalled === true).length
      };
    });
  }

  function agentsView() {
    return Array.from(store.agents.values()).map((rec) => ({
      id: rec.id, sessionId: rec.sessionId, title: rec.title, status: rec.status,
      statusSince: rec.statusSince, lastEventAt: rec.lastEventAt, lastEventType: rec.lastEventType,
      moduleId: rec.moduleId, routeReason: rec.routeReason, routeConfidence: rec.routeConfidence,
      stalled: rec.stalled === true, attention: rec.attention === true, attentionReason: rec.attentionReason,
      question: rec.question, turns: rec.turns, errors: rec.errors, events: rec.events
    }));
  }

  function budgetView(now) {
    const hourAgo = now - 3_600_000;
    const used = store.snapshot().actions.filter((a) => a.at !== undefined && a.at >= hourAgo).length;
    const max = Math.max(1, readSettings().budgetPerHour);
    return { used, max, pct: Math.round((used / max) * 1000) / 10 };
  }

  function runsView(limit) {
    if (engine === undefined) return [];
    return engine.list({ limit: limit === undefined ? 20 : limit }).map((run) => ({
      id: run.id, wf: run.wf, subject: run.subject, moduleId: run.module_id, status: run.status,
      step: run.current_step, attempts: run.attempts, shadow: run.shadow === 1,
      error: run.error, updatedAt: run.updated_at, createdAt: run.created_at
    }));
  }

  function approvalsView() {
    if (approvals === undefined) return [];
    try { return approvals.listOpen().slice(0, 20); } catch { return []; }
  }


  return { stewardSnapshot, modulesView, agentsView, budgetView, runsView, approvalsView };
}

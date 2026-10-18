/**
 * Steward 指标发布（评审 P0-2 拆分的产物）：只往 scope.metrics 注册 gauge，不自己采样。
 *
 * 堆 / RSS / 事件循环由 scope.host 统一采样；这里发布的是「总管眼里的世界」。
 * 视图函数会遍历 agent 表，所以做 5 秒缓存，一次 tick 只算一次。
 */
export function createStewardMetrics(scope, S) {
  const { agentsView, modulesView, approvalsView, runsView, budgetView, store, titles, readSettings } = S;

  // 堆 / RSS / 事件循环由 scope.host 统一采样；这里发布的是"总管眼里的世界"。
  // 视图函数本身有开销（会遍历 agent 表），所以做 4 秒缓存，一次 tick 只算一次。
  let statsCache = { at: 0, value: undefined };
  function statsNow() {
    const now = Date.now();
    if (statsCache.value !== undefined && now - statsCache.at < 4000) return statsCache.value;
    const value = { agents: [], modules: [], approvals: [], runs: [], budget: {} };
    try { value.agents = agentsView(); } catch { /* 视图坏了不该拖垮指标 */ }
    try { value.modules = modulesView(); } catch { /* ignore */ }
    try { value.approvals = approvalsView(); } catch { /* ignore */ }
    try { value.runs = runsView(50); } catch { /* ignore */ }
    try { value.budget = budgetView(now); } catch { /* ignore */ }
    statsCache = { at: now, value };
    return value;
  }
  const metricOffs = [];
  const moduleGauges = new Set();
  metricOffs.push(scope.metrics.gauge("polaris_steward_agents_total", () => statsNow().agents.length, { help: "总管观测到的 agent 数" }));
  metricOffs.push(scope.metrics.gauge("polaris_steward_agents_running", () => statsNow().agents.filter((a) => a.status === "running").length, { help: "运行中的 agent 数" }));
  metricOffs.push(scope.metrics.gauge("polaris_steward_agents_stalled", () => statsNow().agents.filter((a) => a.stalled === true).length, { help: "疑似卡住的 agent 数" }));
  metricOffs.push(scope.metrics.gauge("polaris_steward_agents_attention", () => statsNow().agents.filter((a) => a.attention === true).length, { help: "需要人看一眼的 agent 数" }));
  metricOffs.push(scope.metrics.gauge("polaris_steward_agents_unassigned", () => statsNow().agents.filter((a) => a.moduleId === "unassigned").length, { help: "还没归到任何项目的 agent 数" }));
  metricOffs.push(scope.metrics.gauge("polaris_steward_runs_open", () => statsNow().runs.filter((r) => r.status !== "done" && r.status !== "failed").length, { help: "未收尾的工作流数" }));
  metricOffs.push(scope.metrics.gauge("polaris_steward_runs_failed", () => statsNow().runs.filter((r) => r.status === "failed").length, { help: "失败的工作流数" }));
  metricOffs.push(scope.metrics.gauge("polaris_steward_approvals_open", () => statsNow().approvals.length, { help: "待批决策数" }));
  metricOffs.push(scope.metrics.gauge("polaris_steward_budget_used", () => Number(statsNow().budget.used) || 0, { help: "本小时已用动作预算" }));
  metricOffs.push(scope.metrics.gauge("polaris_steward_budget_max", () => Number(statsNow().budget.max) || 0, { help: "本小时动作预算上限" }));
  metricOffs.push(scope.metrics.gauge("polaris_steward_signals_total", () => store.signals.length, { help: "内存里保留的信号条数" }));
  metricOffs.push(scope.metrics.gauge("polaris_steward_events_total", () => store.counters.events, { help: "journal 累计事件数" }));
  metricOffs.push(scope.metrics.gauge("polaris_steward_title_cache", () => titles.size(), { help: "会话标题缓存条数" }));
  metricOffs.push(scope.metrics.gauge("polaris_steward_modules_total", () => statsNow().modules.length, { help: "已配置的项目模块数" }));
  metricOffs.push(scope.metrics.gauge("polaris_steward_act_mode", () => { const c = readSettings(); return c.actMode === "live" ? 1 : 0; }, { help: "1=live 真执行，0=echo 只打印" }));
  // 每个模块一条序列：模块是配置出来的，所以第一次见到时懒注册。
  function ensureModuleGauges() {
    for (const mod of statsNow().modules) {
      const id = String(mod.id === undefined ? "-" : mod.id);
      if (moduleGauges.has(id)) continue;
      moduleGauges.add(id);
      metricOffs.push(scope.metrics.gauge("polaris_module_agents", () => { const row = statsNow().modules.find((m) => String(m.id) === id); return row === undefined ? 0 : Number(row.count) || 0; }, { labels: { module: id }, help: "各模块下的 agent 数" }));
      metricOffs.push(scope.metrics.gauge("polaris_module_running", () => { const row = statsNow().modules.find((m) => String(m.id) === id); return row === undefined ? 0 : Number(row.running) || 0; }, { labels: { module: id }, help: "各模块下运行中的 agent 数" }));
    }
  }
  ensureModuleGauges();

  return {
    statsNow,
    ensureModuleGauges,
    dispose() { for (const off of metricOffs.splice(0)) { try { off(); } catch { /* ignore */ } } }
  };
}

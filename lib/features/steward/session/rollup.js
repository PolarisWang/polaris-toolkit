/**
 * rollup：喂给总管会话的唯一输入。
 *
 * 原则（design 8.4）：只给聚合与待决，不给原始日志。一次唤醒的输入控制在
 * 一两千字以内，否则每次唤醒都在烧上下文。
 */

export const SEVERITY_WEIGHT = { info: 1, warning: 2, error: 3, critical: 4 };

function topN(list, n) {
  return list.slice().sort((a, b) => (SEVERITY_WEIGHT[b.severity] || 0) - (SEVERITY_WEIGHT[a.severity] || 0) || b.at - a.at).slice(0, n);
}

export function buildRollup(input) {
  const i = input === undefined || input === null ? {} : input;
  const now = typeof i.now === "number" ? i.now : Date.now();
  const windowMs = typeof i.windowMs === "number" ? i.windowMs : 300_000;
  const agents = Array.isArray(i.agents) ? i.agents : [];
  const runs = Array.isArray(i.runs) ? i.runs : [];
  const signals = Array.isArray(i.signals) ? i.signals : [];
  const approvals = Array.isArray(i.approvals) ? i.approvals : [];
  const recentSignals = signals.filter((s) => now - Number(s.at) <= windowMs);

  const byModule = {};
  const attention = [];
  for (const agent of agents) {
    const moduleId = agent.moduleId === undefined ? "unassigned" : agent.moduleId;
    byModule[moduleId] = byModule[moduleId] === undefined ? 0 : byModule[moduleId];
    byModule[moduleId] += 1;
    if (agent.status === "stalled" || agent.question !== undefined && agent.question !== null || Number(agent.silenceMs) > 30 * 60_000) attention.push(agent);
  }

  const openRuns = runs.filter((r) => ["pending", "running", "waiting"].indexOf(r.status) >= 0);
  const failedRuns = runs.filter((r) => r.status === "failed");

  return {
    at: now,
    agents: {
      total: agents.length,
      running: agents.filter((a) => a.status === "running").length,
      idle: agents.filter((a) => a.status === "idle").length,
      stalled: agents.filter((a) => a.status === "stalled").length,
      byModule
    },
    attention: attention.slice(0, 8).map((a) => ({
      subject: a.id, title: a.title === undefined ? null : a.title, moduleId: a.moduleId,
      status: a.status, silenceMs: a.silenceMs === undefined ? null : Number(a.silenceMs),
      question: a.question === undefined ? null : a.question
    })),
    signals: {
      window: windowMs,
      total: recentSignals.length,
      top: topN(recentSignals, 6).map((s) => ({ kind: s.kind, subject: s.subject, severity: s.severity, at: s.at }))
    },
    runs: {
      open: openRuns.length,
      waiting: openRuns.filter((r) => r.status === "waiting").length,
      failed: failedRuns.length,
      recent: openRuns.slice(0, 6).map((r) => ({ id: r.id, wf: r.wf, subject: r.subject, status: r.status, step: r.current_step }))
    },
    approvals: approvals.filter((a) => a.status === "open").map((a) => ({ id: a.id, title: a.title, deadline: a.deadline })),
    health: i.health === undefined ? null : i.health,
    budget: i.budget === undefined ? null : i.budget
  };
}

/** 渲染成给模型看的短文本。 */
export function renderRollup(rollup) {
  const lines = [];
  lines.push("时间 " + new Date(rollup.at).toISOString() + "；agent " + rollup.agents.total + "（running " + rollup.agents.running + "，stalled " + rollup.agents.stalled + "）");
  const modules = Object.keys(rollup.agents.byModule).sort().map((m) => m + ":" + rollup.agents.byModule[m]).join(" ");
  if (modules !== "") lines.push("模块 " + modules);
  if (rollup.attention.length > 0) {
    lines.push("需要关注:");
    for (const a of rollup.attention) {
      const bits = [a.moduleId, a.status, a.silenceMs === null ? "" : Math.round(a.silenceMs / 60000) + "m"].filter((x) => x !== "");
      lines.push("- " + (a.title === null ? a.subject : a.title) + " (" + bits.join("/") + ")" + (a.question === null ? "" : " 待答提问"));
    }
  }
  if (rollup.signals.total > 0) lines.push("信号 " + rollup.signals.total + " 条：" + rollup.signals.top.map((s) => s.kind).join("、"));
  lines.push("工作流 打开 " + rollup.runs.open + "（等待 " + rollup.runs.waiting + "，失败 " + rollup.runs.failed + "）");
  if (rollup.approvals.length > 0) lines.push("待批 " + rollup.approvals.length + " 项：" + rollup.approvals.map((a) => a.title).join("、"));
  return lines.join("\n");
}

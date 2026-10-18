/**
 * Steward 大脑层（评审第 8 项拆分的产物）：事实 → 规则 → 工作流，外加唯一的 tick 循环。
 *
 * 这里集中了所有「会自己动起来」的东西：规则事件桥、工具包 heap/critical 订阅、
 * 以及一个交给 scope.every 的调度（堆压力高时工具包会统一降频）。
 * index.js 只负责装配，并在 dispose 时调用返回的 offTick。
 */
import fs from "node:fs";
import os from "node:os";

function freeDiskMB() {
  try {
    const s = typeof fs.statfsSync === "function" ? fs.statfsSync(os.homedir()) : undefined;
    if (s === undefined) return undefined;
    return Math.round((Number(s.bfree) * Number(s.bsize)) / 1048576);
  } catch { return undefined; }
}

export function createBrain(scope, S) {
  const {
    agentsSource, approvals, binder, budgetView, bus, c, classifier, counters, db, engine,
    events, exporter, health, loadRules, log, modulesView, notifier, offs, peer, prompter,
    readSettings, routeAll, stewardSnapshot, store, tasks, titles,
  } = S;
  const getRuleSet = () => S.getRuleSet();
  const getEvaluator = () => S.getEvaluator();

  function fire(result, extra) {
    if (engine === undefined || result === undefined || !Array.isArray(result.decisions)) return 0;
    const base = extra !== null && typeof extra === "object" ? extra : {};
    const hostId = String(readSettings().federation.hostId);
    const cfg = readSettings();
    let started = 0;
    for (const decision of result.decisions) {
      const list = Array.isArray(decision.actions) ? decision.actions : [];
      for (const action of list) {
        if (action === null || typeof action !== "object" || typeof action.workflow !== "string") continue;
        const budget = budgetView(Date.now());
        if (budget.pct >= 100 && decision.severity !== "critical") {
          store.pushAction({ kind: "budget-block", agentId: base.agentId, ok: false, message: "hourly budget exhausted (" + budget.used + "/" + budget.max + "), suppressed " + decision.ruleId });
          continue;
        }
        const vars = Object.assign({}, decision.params === undefined ? {} : decision.params, base, {
          subject: decision.subject, ruleId: decision.ruleId, title: decision.title, level: decision.severity,
          text: (base.text === undefined ? decision.title : String(base.text))
        });
        vars.moduleId = vars.moduleId === undefined ? "unassigned" : vars.moduleId;
        try {
          engine.start(action.workflow, {
            subject: String(decision.subject), moduleId: String(vars.moduleId), hostId,
            vars, shadow: decision.shadow === true, traceId: "rule:" + decision.ruleId + ":" + String(decision.subject)
          });
          started += 1;
          store.pushAction({ kind: "workflow", agentId: base.agentId, ok: true, message: decision.ruleId + " -> " + action.workflow });
        } catch (error) {
          log("warn", "steward: start " + action.workflow + " failed: " + String(error));
          store.pushAction({ kind: "workflow", agentId: base.agentId, ok: false, message: decision.ruleId + " -> " + action.workflow + " failed: " + String(error) });
        }
      }
    }
    return started;
  }

  function evaluateAgents() {
    if (getEvaluator() === undefined) return 0;
    const t = Date.now();
    let fired = 0;
    for (const rec of store.agents.values()) {
      const facts = {
        agentId: rec.id, sessionId: rec.sessionId, moduleId: rec.moduleId, status: rec.status,
        silenceMs: t - rec.lastEventAt, stalled: rec.stalled === true,
        ageMs: t - (rec.firstSeenAt === undefined ? t : rec.firstSeenAt),
        turns: rec.turns, errors: rec.errors
      };
      if (rec.question !== undefined) { facts.question = rec.question.count; facts.questionAgeMs = t - rec.question.since; }
      const result = getEvaluator().evaluate({ type: "agent/tick", subject: rec.id, at: t, facts });
      fired += fire(result, { agentId: rec.id, sessionId: rec.sessionId, moduleId: rec.moduleId, title: rec.title, silenceMs: facts.silenceMs });
    }
    return fired;
  }

  function evaluateHost() {
    if (getEvaluator() === undefined) return 0;
    const h = health.last;
    if (h === undefined) return 0;
    const pct = h.heapLimitMB > 0 ? Math.round((h.heapUsedMB / h.heapLimitMB) * 1000) / 10 : 0;
    const disk = freeDiskMB();
    const facts = {
      heapPct: pct, usedMB: h.heapUsedMB, limitMB: h.heapLimitMB, heapUsedMB: h.heapUsedMB,
      loopP99Ms: h.loop === undefined ? 0 : h.loop.p99Ms,
      crashLast24h: h.crash === undefined ? 0 : h.crash.last24h,
      // 距最近一次崩溃日志的分钟数：用来区分"这次启动之后的崩溃"与"历史崩溃"
      crashNewestAgeMin: h.crash === undefined || h.crash.newest === undefined || typeof h.crash.newest.at !== "number"
        ? 99999 : Math.max(0, Math.round((Date.now() - h.crash.newest.at) / 60000)),
      freeDiskMB: disk === undefined ? 999999 : disk
    };
    return fire(getEvaluator().evaluate({ type: "host/tick", subject: "host", at: Date.now(), facts }), {});
  }

  function evaluateSteward() {
    if (getEvaluator() === undefined) return 0;
    const now = Date.now();
    const d = new Date(now);
    const budget = budgetView(now);
    const facts = { minuteOfHour: d.getMinutes(), budgetUsedPct: budget.pct, budgetUsed: budget.used };
    return fire(getEvaluator().evaluate({ type: "steward/tick", subject: "steward", at: now, facts }), {});
  }

  // ---------- 交办单跟进：会话跑完一轮就把单子推到"待验收" ----------
  const lastTurns = new Map();
  function trackTurns() {
    if (tasks === undefined) return 0;
    let moved = 0;
    for (const rec of store.agents.values()) {
      if (rec === undefined || rec.id === undefined) continue;
      const turns = Number(rec.turns) || 0;
      const prev = lastTurns.get(rec.id);
      lastTurns.set(rec.id, turns);
      if (prev === undefined || turns <= prev) continue;
      try { moved += tasks.onTurnEnd(rec.sessionId); } catch (error) { log("debug", "steward: task turn/end failed: " + String(error)); }
    }
    return moved;
  }

  // ---------- 升级退役（C 方案）：卡住 -> 催一句 -> 取消 -> 交给人 ----------
  // 三级都受 cooldownSec 约束，且必须先过 policy（L3 才允许 steer/cancel）。
  const escState = new Map();
  async function escalate() {
    const cfg = readSettings();
    const esc = cfg.escalation;
    if (esc === undefined || esc.enabled !== true) return 0;
    const now = Date.now();
    const cooldown = Math.max(60, Number(esc.cooldownSec) || 600) * 1000;
    const maxAttempts = Math.max(1, Number(esc.maxAttempts) || 2);
    const live = cfg.actMode === "live";
    let acted = 0;
    for (const rec of store.agents.values()) {
      if (rec === undefined || rec.id === undefined) continue;
      if (rec.stalled !== true) { escState.delete(rec.id); continue; }
      const prev = escState.get(rec.id);
      if (prev !== undefined && now - prev.at < cooldown) continue;
      const step = prev === undefined ? 0 : prev.step;
      if (step >= maxAttempts) {
        if (prev !== undefined && prev.reported === true) continue;
        store.pushAction({ kind: "escalate", agentId: rec.id, ok: false, message: "agent " + String(rec.title === undefined ? rec.id : rec.title) + " 卡住已久且已催/取消过，交给人处理" });
        escState.set(rec.id, { at: now, step, reported: true });
        continue;
      }
      const sessionId = rec.sessionId === undefined ? "" : String(rec.sessionId);
      if (sessionId === "") continue;
      if (step === 0) {
        const verdict = policyGate("agent.steer");
        if (verdict !== undefined && verdict.ok !== true) continue;
        if (!live) {
          store.pushAction({ kind: "echo", agentId: rec.id, ok: true, message: "拟催 " + sessionId + "：" + steerText(cfg) });
          escState.set(rec.id, { at: now, step: 1 });
          acted += 1;
          continue;
        }
        const sent = prompter === undefined ? { ok: false, reason: "prompter-unavailable" } : await prompter.prompt(scope.ctx, {
          sessionId, content: [{ type: "text", text: steerText(cfg) }], mode: "steer",
          requestId: "steward-steer-" + rec.id + "-" + now
        });
        if (sent !== undefined && sent.ok === true) {
          store.pushAction({ kind: "escalate", agentId: rec.id, ok: true, message: "已催 " + sessionId });
          escState.set(rec.id, { at: now, step: 1 });
          acted += 1;
        }
        continue;
      }
      const verdict = policyGate("agent.cancel");
      if (verdict !== undefined && verdict.ok !== true) continue;
      if (!live) {
        store.pushAction({ kind: "echo", agentId: rec.id, ok: true, message: "拟取消 " + sessionId });
        escState.set(rec.id, { at: now, step: step + 1 });
        acted += 1;
        continue;
      }
      try {
        const ctrl = scope.ctx.get("sessionController");
        if (ctrl === undefined || typeof ctrl.cancel !== "function") continue;
        await ctrl.cancel({ sessionId });
        store.pushAction({ kind: "escalate", agentId: rec.id, ok: true, message: "已取消 " + sessionId });
        escState.set(rec.id, { at: now, step: step + 1 });
        acted += 1;
      } catch (error) {
        log("warn", "steward: cancel " + sessionId + " failed: " + String(error));
        escState.set(rec.id, { at: now, step: step + 1 });
      }
    }
    return acted;
  }

  function steerText(cfg) {
    const custom = cfg.escalation === undefined ? "" : String(cfg.escalation.steerText === undefined ? "" : cfg.escalation.steerText).trim();
    if (custom !== "") return custom;
    return "看起来卡住了：一句话说明你现在在做什么、卡在哪；如果已经完成就直接收尾，不要再等。";
  }

  function policyGate(action) {
    if (S.policy === undefined || typeof S.policy.gate !== "function") return undefined;
    return S.policy.gate(action);
  }

  const RULE_EVENTS = ["agent/error", "agent/request-error", "subagent/end"];
  for (const type of RULE_EVENTS) {
    try {
      const off = scope.ctx.on(type, (payload) => {
        try {
          if (getEvaluator() === undefined) return;
          const p = payload !== null && typeof payload === "object" ? payload : {};
          const agentId = p.agentId !== undefined ? String(p.agentId) : (p.agent !== undefined && p.agent !== null && p.agent.id !== undefined ? String(p.agent.id) : undefined);
          const rec = agentId === undefined ? undefined : store.agents.get(agentId);
          const facts = Object.assign({}, p, {
            agentId, sessionId: rec === undefined ? p.sessionId : rec.sessionId,
            moduleId: rec === undefined ? undefined : rec.moduleId,
            status: p.status === undefined && rec !== undefined ? rec.status : p.status,
            silenceMs: rec === undefined ? 0 : Date.now() - rec.lastEventAt
          });
          const result = getEvaluator().evaluate({ type, subject: agentId === undefined ? "host" : agentId, at: Date.now(), facts });
          fire(result, { agentId, sessionId: facts.sessionId, moduleId: facts.moduleId, title: rec === undefined ? undefined : rec.title, text: p.message === undefined ? undefined : String(p.message) });
        } catch (error) {
          log("warn", "steward: rule bridge " + type + " failed: " + String(error));
        }
      });
      if (typeof off === "function") offs.push(off);
    } catch (error) {
      log("warn", "steward: rule bridge subscribe " + type + " failed: " + String(error));
    }
  }

  // 工具包总线（P1-5）：heap-guard 在堆危急时广播一次，这里决定要不要升格成工作流。
  try {
    const offHeap = scope.bus.on("heap/critical", (payload) => {
      try {
        const p = payload !== null && typeof payload === "object" ? payload : {};
        const text = "宿主堆 " + String(p.usedMB) + " MB (" + String(p.usedPct) + "%)，增长 " + String(p.growthMBPerMin) + " MB/min";
        store.pushAction({ kind: "signal", ok: true, message: "heap/critical " + text });
        log("warn", "steward: heap/critical " + text);
        const cfg = readSettings();
        if (engine === undefined || cfg.autoAct !== true || cfg.actMode !== "live") return;
        if (budgetView(Date.now()).pct >= 100) return;
        engine.start("wf.host.protect", {
          subject: "host", moduleId: "host", hostId: String(cfg.federation.hostId),
          vars: { subject: "host", title: "宿主堆危急", level: "critical", text: text, heapPct: p.usedPct, usedMB: p.usedMB, growthMBPerMin: p.growthMBPerMin },
          traceId: "heap:" + String(p.at)
        });
      } catch (error) {
        log("debug", "steward: heap/critical handler failed: " + String(error));
      }
    });
    if (typeof offHeap === "function") offs.push(offHeap);
  } catch (error) {
    log("debug", "steward: heap/critical subscribe failed: " + String(error));
  }

  async function tick() {
    events.ticks += 1;
    try {
      // 先采样健康度：后面有 await（标题/cwd 刷新），不能让 /api/state 在
      // 第一次 tick 完成前拿不到 health。
      health.sample();
      agentsSource.sync();
      if (events.ticks % Math.max(1, Math.round(c.titleSec / c.tickSec)) === 0) {
        try { await agentsSource.refreshTitles(); } catch (error) { log("debug", "steward: title refresh failed: " + String(error)); }
      }
      try { await agentsSource.refreshCwd(); } catch (error) { log("debug", "steward: cwd refresh failed: " + String(error)); }
      routeAll();
      trackTurns();
      events.started += evaluateAgents();
      events.started += evaluateHost();
      events.started += evaluateSteward();
      if (exporter !== undefined) {
        void exporter.maybePush(stewardSnapshot()).catch((error) => log("debug", "steward: exporter push failed: " + String(error)));
      }
      if (engine !== undefined) await engine.tick(Date.now());
      try { await escalate(); } catch (error) { log("debug", "steward: escalate failed: " + String(error)); }
      if (tasks !== undefined) { try { await tasks.tick(); } catch (error) { log("debug", "steward: task dispatch failed: " + String(error)); } }
      if (approvals !== undefined) { try { approvals.sweep(); } catch (error) { log("debug", "steward: approval sweep failed: " + String(error)); } }
      store.flush();
      events.lastError = undefined;
    } catch (error) {
      events.lastError = String(error);
      log("warn", "steward tick failed: " + events.lastError);
    }
  }

  void tick();
  // 统一调度（P2-11）：不再自己 setInterval，堆压力高时工具包会整体降频。
  const offTick = scope.every(Math.max(1000, c.tickSec * 1000), () => { void tick(); }, { jitter: 0.1 });

  return { fire, evaluateAgents, evaluateHost, evaluateSteward, tick, offTick };
}

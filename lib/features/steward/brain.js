/**
 * Steward 编排器（能力平面 §5）：只负责"什么时候看一眼"与"看完记账"。
 *
 * 决策不在这个文件里：判定（judge.*）、片段（plan.*）与动作（notify/steer/...）
 * 都在能力平面，由编制树（plane/preset.js 预置 + settings.plane 覆盖）决定谁在
 * 什么事件上看什么、判断什么、做什么。brain 只做三件事：
 *   1. 事实源：健康采样、agent 同步、标题/cwd 刷新、模块路由；
 *   2. 事件泵：host/tick、agent/tick、steward/tick、heap/critical、agent/error → plane.dispatch；
 *   3. 记账：交办单轮次跟进、升级退役、工作流引擎推进、汇报、落盘。
 *
 * 与规则版旧实现的差别：evaluator / 规则事件桥 / fire() / engine.start("wf.*") 全部消失，
 * 改为 dispatch()；engine 只保留给历史 runs 的读与旧剧本的收尾。
 */

export function createBrain(scope, S) {
  const src = S === undefined || S === null ? {} : S;
  const agentsSource = src.agentsSource;
  const approvals = src.approvals;
  const budgetView = src.budgetView;
  const c = src.c;
  const engine = src.engine;
  const events = src.events;
  const exporter = src.exporter;
  const health = src.health;
  const log = src.log;
  const offs = Array.isArray(src.offs) ? src.offs : [];
  const plane = src.plane;
  const policy = src.policy;
  const readSettings = src.readSettings;
  const routeAll = src.routeAll;
  const stewardSnapshot = src.stewardSnapshot;
  const store = src.store;
  const tasks = src.tasks;

  function selfSessionId() {
    try {
      const s = readSettings();
      return String(s.session !== undefined && s.session !== null && s.session.id !== undefined ? s.session.id : "");
    } catch { return ""; }
  }

  /** 一个 agent 的判定事实（judge.agent.* 的字段都在这里）。 */
  function agentFacts(rec, t) {
    const sid = rec.sessionId === undefined || rec.sessionId === null ? "" : String(rec.sessionId);
    const facts = {
      agentId: rec.id,
      sessionId: sid,
      moduleId: rec.moduleId,
      status: rec.status,
      title: rec.title,
      cwd: rec.cwd,
      silenceMs: t - (rec.lastEventAt === undefined ? t : rec.lastEventAt),
      stalled: rec.stalled === true,
      ageMs: t - (rec.firstSeenAt === undefined ? t : rec.firstSeenAt),
      turns: rec.turns,
      errors: rec.errors,
      subject: sid === "" ? "agent:" + String(rec.id) : "session:" + sid,
      parentSessionId: sid
    };
    if (rec.question !== undefined && rec.question !== null) {
      facts.question = rec.question.count;
      facts.questionAgeMs = t - rec.question.since;
    }
    return facts;
  }

  /** 往能力平面投一个事件；没有编制订阅时 dispatch 自己会短路。 */
  async function emit(event, facts, opts) {
    if (plane === undefined || typeof plane.dispatch !== "function") return { traceId: "", stewards: [], calls: 0, previews: 0, skipped: "no-plane" };
    return plane.dispatch(event, facts, opts);
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
    // 上限与清理（评审 P1-D）：会话已经不在账本里的，基线与升级状态一起丢掉，
    // 否则这两个 Map 会随宿主生命周期无限长。
    if (lastTurns.size > 200 || escState.size > 200) {
      const live = new Set();
      for (const rec of store.agents.values()) if (rec !== undefined && rec.id !== undefined) live.add(String(rec.id));
      for (const key of Array.from(lastTurns.keys())) if (!live.has(String(key))) lastTurns.delete(key);
      for (const key of Array.from(escState.keys())) if (!live.has(String(key))) escState.delete(key);
      while (lastTurns.size > 400) lastTurns.delete(lastTurns.keys().next().value);
      while (escState.size > 400) escState.delete(escState.keys().next().value);
    }
    return moved;
  }

  // ---------- 升级退役：卡住 -> 催一句 -> 取消 -> 交给人 ----------
  // 三级都受 cooldownSec 约束，且必须先过 policy（L3 才允许 steer/cancel）。
  // 被授权闸门拦住时也留一条 action，而不是静默（评审缺陷 #4）。
  const escState = new Map();
  async function escalate() {
    const cfg = readSettings();
    const esc = cfg.escalation;
    if (esc === undefined || esc === null || esc.enabled !== true) return 0;
    const now = Date.now();
    const cooldown = Math.max(60, Number(esc.cooldownSec) || 600) * 1000;
    const maxAttempts = Math.max(1, Number(esc.maxAttempts) || 2);
    const live = cfg.actMode === "live";
    let acted = 0;
    for (const rec of store.agents.values()) {
      if (rec === undefined || rec.id === undefined) continue;
      if (rec.sessionId !== undefined && String(rec.sessionId) === selfSessionId()) continue;
      // 等人回话 / 等审批的会话不算"卡住"，不能催、更不能取消（评审缺陷 #4）。
      if (rec.stalled !== true || rec.attention === true || rec.question !== undefined) { escState.delete(rec.id); continue; }
      const prev = escState.get(rec.id);
      if (prev !== undefined && now - prev.at < cooldown) continue;
      const step = prev === undefined ? 0 : prev.step;
      if (step >= maxAttempts) {
        if (prev !== undefined && prev.reported === true) continue;
        store.pushAction({ kind: "escalate", agentId: rec.id, ok: false, message: "agent " + String(rec.title === undefined ? rec.id : rec.title) + " 卡住已久且已催/取消过，交给人处理" });
        escState.set(rec.id, { at: now, step: step, reported: true });
        continue;
      }
      const sessionId = rec.sessionId === undefined ? "" : String(rec.sessionId);
      if (sessionId === "") continue;
      const action = step === 0 ? "agent.steer" : "agent.cancel";
      const verdict = policyGate(action);
      if (verdict !== undefined && verdict.ok !== true) {
        store.pushAction({ kind: "denied", agentId: rec.id, ok: false, message: action + " 被授权闸门拦截：" + String(verdict.reason) + "（当前 " + String(policy !== undefined && policy.level !== undefined ? policy.level() : "?") + "）" });
        escState.set(rec.id, { at: now, step: step });
        continue;
      }
      if (step === 0) {
        if (!live) {
          store.pushAction({ kind: "echo", agentId: rec.id, ok: true, message: "拟催 " + sessionId + "：" + steerText(cfg) });
          escState.set(rec.id, { at: now, step: 1 });
          acted += 1;
          continue;
        }
        const sent = src.prompter === undefined ? { ok: false, reason: "prompter-unavailable" } : await src.prompter.prompt(scope.ctx, {
          sessionId: sessionId, content: [{ type: "text", text: steerText(cfg) }], mode: "steer",
          requestId: "steward-steer-" + String(rec.id) + "-" + String(now)
        });
        if (sent !== undefined && sent !== null && sent.ok === true) {
          store.pushAction({ kind: "escalate", agentId: rec.id, ok: true, message: "已催 " + sessionId });
          escState.set(rec.id, { at: now, step: 1 });
          acted += 1;
        }
        continue;
      }
      if (!live) {
        store.pushAction({ kind: "echo", agentId: rec.id, ok: true, message: "拟取消 " + sessionId });
        escState.set(rec.id, { at: now, step: step + 1 });
        acted += 1;
        continue;
      }
      try {
        const ctrl = scope.ctx.get("sessionController");
        if (ctrl === undefined || typeof ctrl.cancel !== "function") continue;
        await ctrl.cancel({ sessionId: sessionId });
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
    const custom = cfg.escalation === undefined || cfg.escalation === null ? "" : String(cfg.escalation.steerText === undefined ? "" : cfg.escalation.steerText).trim();
    if (custom !== "") return custom;
    return "看起来卡住了：一句话说明你现在在做什么、卡在哪；如果已经完成就直接收尾，不要再等。";
  }

  function policyGate(action) {
    if (policy === undefined || typeof policy.gate !== "function") return undefined;
    return policy.gate(action);
  }

  // ---------- 事件桥：宿主生命周期事件 → 能力平面 ----------
  const RULE_EVENTS = ["agent/error", "agent/request-error", "subagent/end"];
  for (const type of RULE_EVENTS) {
    try {
      const off = scope.ctx.on(type, (payload) => {
        void (async () => {
          try {
            const p = payload !== null && typeof payload === "object" ? payload : {};
            const agentId = p.agentId !== undefined ? String(p.agentId) : (p.agent !== undefined && p.agent !== null && p.agent.id !== undefined ? String(p.agent.id) : undefined);
            const rec = agentId === undefined ? undefined : store.agents.get(agentId);
            const facts = Object.assign({}, p, {
              agentId: agentId,
              sessionId: rec === undefined ? p.sessionId : rec.sessionId,
              moduleId: rec === undefined ? undefined : rec.moduleId,
              status: p.status === undefined && rec !== undefined ? rec.status : p.status,
              title: rec === undefined ? undefined : rec.title,
              text: p.message === undefined ? type : String(p.message),
              silenceMs: rec === undefined ? 0 : Date.now() - rec.lastEventAt,
              subject: rec !== undefined && rec.sessionId !== undefined ? "session:" + String(rec.sessionId) : "host"
            });
            await emit(type, facts, { subject: facts.subject, selfSessionId: selfSessionId() });
          } catch (error) {
            log("warn", "steward: plane bridge " + type + " failed: " + String(error));
          }
        })();
      });
      if (typeof off === "function") offs.push(off);
    } catch (error) {
      log("warn", "steward: plane bridge subscribe " + type + " failed: " + String(error));
    }
  }

  // 工具包总线：heap-guard 在堆危急时广播一次，这里交给能力平面决定要不要升格。
  try {
    const offHeap = scope.bus.on("heap/critical", (payload) => {
      void (async () => {
        try {
          const p = payload !== null && typeof payload === "object" ? payload : {};
          const text = "宿主堆 " + String(p.usedMB) + " MB (" + String(p.usedPct) + "%)，增长 " + String(p.growthMBPerMin) + " MB/min";
          store.pushAction({ kind: "signal", ok: true, message: "heap/critical " + text });
          log("warn", "steward: heap/critical " + text);
          const extra = { heapPct: Number(p.usedPct), pct: Number(p.usedPct), usedMB: Number(p.usedMB), limitMB: Number(p.limitMB), level: String(p.level === undefined ? "critical" : p.level), text: text, growthMBPerMin: Number(p.growthMBPerMin) };
          const facts = plane !== undefined && typeof plane.hostFacts === "function" ? plane.hostFacts(extra) : extra;
          await emit("heap/critical", facts, { subject: "host", selfSessionId: selfSessionId(), vars: extra });
        } catch (error) {
          log("debug", "steward: heap/critical handler failed: " + String(error));
        }
      })();
    });
    if (typeof offHeap === "function") offs.push(offHeap);
  } catch (error) {
    log("debug", "steward: heap/critical subscribe failed: " + String(error));
  }

  let lastReap = 0;

  async function tick() {
    events.ticks += 1;
    try {
      health.sample();
      agentsSource.sync();
      if (events.ticks % Math.max(1, Math.round(c.titleSec / c.tickSec)) === 0) {
        try { await agentsSource.refreshTitles(); } catch (error) { log("debug", "steward: title refresh failed: " + String(error)); }
      }
      try { await agentsSource.refreshCwd(); } catch (error) { log("debug", "steward: cwd refresh failed: " + String(error)); }
      routeAll();
      trackTurns();
      if (Date.now() - lastReap > 300000) {
        lastReap = Date.now();
        const reaped = store.reapAgents === undefined ? [] : store.reapAgents({});
        if (reaped.length > 0) log("debug", "steward: reaped " + reaped.length + " idle agent record(s)");
      }

      // 事实 → 编制树（每个事件一条 trace；没有编制订阅的事件会短路）。
      const t = Date.now();
      const self = selfSessionId();
      let calls = 0;
      let previews = 0;
      if (plane !== undefined && typeof plane.hostFacts === "function") {
        const hostRes = await emit("host/tick", plane.hostFacts({}), { subject: "host", selfSessionId: self });
        calls += Number(hostRes.calls) || 0;
        previews += Number(hostRes.previews) || 0;
      }
      for (const rec of store.agents.values()) {
        if (rec === undefined || rec.id === undefined) continue;
        const facts = agentFacts(rec, t);
        const res = await emit("agent/tick", facts, {
          subject: facts.subject,
          selfSessionId: self,
          humanPresent: facts.question !== undefined && Number(facts.question) > 0
        });
        calls += Number(res.calls) || 0;
        previews += Number(res.previews) || 0;
      }
      events.started += calls;
      if (previews > 0) log("debug", "steward: " + String(previews) + " action(s) previewed by echo/grant gate");

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
  const offTick = scope.every(Math.max(1000, c.tickSec * 1000), () => { void tick(); }, { jitter: 0.1 });

  return { tick: tick, offTick: offTick, escalate: escalate, trackTurns: trackTurns, emit: emit, agentFacts: agentFacts };
}

export default { createBrain };

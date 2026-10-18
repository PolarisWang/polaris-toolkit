/**
 * Feature: Steward（大内总管 / 多会话总管团）
 *
 * 分层（docs/steward-design.md）：
 *   观察层  core/store.js + core/bus.js + sources/* + health.js   —— 只读事实
 *   规则层  rules/*（expr / loader / evaluator）                  —— 事实 → 决策
 *   执行层  wf/engine.js + wf/defs.js + actuators/* + channels/*  —— 决策 → 副作用
 *   会话层  session/*（rollup / pressure / handoff / bootstrap）   —— 判断与汇报
 *   联邦层  federation/*（HMAC 信封 + 命令白名单 + 心跳）          —— 多设备
 *
 * 加载安全（硬要求）：setup() 整体包在 try/catch 里，任何子系统的构造失败只会
 * 降级成 "degraded" 并记进 events.degraded，绝不让宿主加载插件时崩。
 * 副作用（发通知 / 发消息 / 代答 / 瘦身）默认全部关闭：autoAct=false，
 * actions.stallSteer=false，actions.heapSlim=false，只有人显式打开才动手。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { createStore } from "./core/store.js";
import { createBus } from "./core/bus.js";
import { createHealth } from "./health.js";
import { createAgentsSource } from "./sources/agents.js";
import { createTitleSource } from "./sources/titles.js";
import { applyRouting, normalizeModules, routeAgent, DEFAULT_MODULES } from "./modules.js";
import { stewardPanelHtml } from "./panel.js";
import { createDb } from "./core/db.js";
import { createApprovalStore } from "./core/approvals.js";
import { createEngine } from "./wf/engine.js";
import { defineWorkflows } from "./wf/defs.js";
import { buildRuleSet, loadOverrides } from "./rules/loader.js";
import { createEvaluator } from "./rules/evaluator.js";
import { createDesktopChannel } from "./channels/desktop.js";
import { createFeishuChannel } from "./channels/feishu.js";
import { createNotifier } from "./actuators/notify.js";
import { createPrompter } from "./actuators/prompt.js";
import { createAnswerer } from "./actuators/answer.js";
import { createSessionBinder } from "./session/bootstrap.js";
import { buildRollup, renderRollup } from "./session/rollup.js";
import { createPeer } from "./federation/peer.js";
import { createClassifier } from "./classify.js";
import { createExporter, prometheusText } from "./export.js";

export const id = "steward";
export const title = "Steward";
export const subtitle = "大内总管：观察全部 agent、归类到模块、规则 → 工作流 → 动作";
export const order = 20;

export const Config = z.object({
  tickSec: z.natural().default(5),
  titleSec: z.natural().default(60),
  stallMinutes: z.natural().default(8),
  journalDays: z.natural().default(30)
});

export const actions = [
  { id: "collect", kind: "button", label: "强制采样", hint: "立即对账一次 agent 列表、刷新会话名与健康数据" },
  { id: "flush", kind: "button", label: "落盘 journal", hint: "把内存里待写的观察记录立刻写进 journal-YYYYMMDD.jsonl" },
  { id: "digest", kind: "button", label: "立即汇报", hint: "把当前态势渲染成一段话走通知通道（受 notify.minSeverity 过滤）" },
  { id: "reload-rules", kind: "button", label: "重载规则", hint: "重新读内置规则与 rules/overrides/*.json" }
];

const DEFAULTS = {
  notify: { minSeverity: "warning", larkEnabled: false, larkCommand: "lark-cli" },
  actions: { stallSteer: false, heapSlim: false },
  session: { mode: "manual", preset: "steward", title: "大内总管", model: "auto", rotateTurns: 200, rotateTokens: 300000 },
  federation: { hostId: "win-main", secret: "", peerUrl: "" },
  // actMode: "echo" 只把动作要发的 message 打进 journal/面板，等主人 ack 后再切 "live"。
  actMode: "echo",
  classifier: { enabled: true, provider: "", model: "", minConfidence: 0.55, maxPerTick: 2, timeoutMs: 12000, maxTokens: 120, ttlDays: 7 },
  export: { prometheus: true, intervalSec: 60, otlp: { enabled: false, endpoint: "", headers: {} } },
  budgetPerHour: 60,
  autoAct: false
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function settings(config) {
  const c = normalize(config);
  return Object.assign(clone(DEFAULTS), {
    modules: clone(DEFAULT_MODULES),
    pins: {},
    tickSec: c.tickSec,
    stallMinutes: c.stallMinutes
  });
}

export function normalize(raw) {
  const v = raw !== null && typeof raw === "object" ? raw : {};
  function nat(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  }
  return {
    tickSec: nat(v.tickSec, 5),
    titleSec: nat(v.titleSec, 60),
    stallMinutes: nat(v.stallMinutes, 8),
    journalDays: nat(v.journalDays, 30)
  };
}

function freeDiskMB() {
  try {
    const s = typeof fs.statfsSync === "function" ? fs.statfsSync(os.homedir()) : undefined;
    if (s === undefined) return undefined;
    return Math.round((Number(s.bfree) * Number(s.bsize)) / 1048576);
  } catch { return undefined; }
}

export function setup(scope) {
  try {
    setupInner(scope);
  } catch (error) {
    try { scope.log("error", "steward: setup failed, feature degraded: " + String(error !== null && error !== undefined && error.stack !== undefined ? error.stack : error)); } catch { /* ignore */ }
  }
}

function setupInner(scope) {
  const c = normalize(scope.config);
  const log = (level, message) => scope.log(level, message);
  const store = createStore({ dir: scope.dir, log });
  // 会话名的第二来源：Heap Guard 已经用子进程扫过 session/title 事件并缓存，
  // 这里只读它的内存表，不再重复扫描（拿不到就返回空数组，标题源自己降级）。
  const titlesFromHeapGuard = () => {
    try {
      const rts = scope.shared === undefined ? undefined : scope.shared.runtimes;
      const rt = rts === undefined ? undefined : rts.get("heap-guard");
      if (rt === undefined || rt.titleStore === undefined || typeof rt.titleStore.entries !== "function") return [];
      return rt.titleStore.entries();
    } catch { return []; }
  };
  const titles = createTitleSource({ ctx: scope.ctx, log, fallback: titlesFromHeapGuard });
  const agentsSource = createAgentsSource({ ctx: scope.ctx, store, titles, log });
  const bus = createBus({ ctx: scope.ctx, store, log });
  const health = createHealth();
  const events = { startedAt: Date.now(), lastCollect: undefined, lastError: undefined, ticks: 0, started: 0, degraded: [] };
  const offs = [];

  function attempt(label, fn, fallback) {
    try {
      const value = fn();
      if (value === undefined || value === null) { events.degraded.push(label + ": empty"); return fallback; }
      return value;
    } catch (error) {
      const text = label + ": " + String(error !== null && error !== undefined && error.message !== undefined ? error.message : error);
      events.degraded.push(text);
      log("warn", "steward: " + text);
      return fallback;
    }
  }

  function readSettings() {
    let raw = {};
    try { raw = scope.settings.all(); } catch { raw = {}; }
    if (raw === null || typeof raw !== "object") raw = {};
    const d = settings(scope.config);
    const out = Object.assign({}, d, raw);
    out.notify = Object.assign({}, d.notify, raw.notify !== null && typeof raw.notify === "object" ? raw.notify : {});
    out.actions = Object.assign({}, d.actions, raw.actions !== null && typeof raw.actions === "object" ? raw.actions : {});
    out.session = Object.assign({}, d.session, raw.session !== null && typeof raw.session === "object" ? raw.session : {});
    out.federation = Object.assign({}, d.federation, raw.federation !== null && typeof raw.federation === "object" ? raw.federation : {});
    out.classifier = Object.assign({}, d.classifier, raw.classifier !== null && typeof raw.classifier === "object" ? raw.classifier : {});
    out.export = Object.assign({}, d.export, raw.export !== null && typeof raw.export === "object" ? raw.export : {});
    out.export.otlp = Object.assign({}, d.export.otlp, raw.export !== null && typeof raw.export === "object" && raw.export.otlp !== null && typeof raw.export.otlp === "object" ? raw.export.otlp : {});
    out.actMode = raw.actMode === "live" ? "live" : "echo";
    out.modules = Array.isArray(raw.modules) && raw.modules.length > 0 ? raw.modules : d.modules;
    out.pins = raw.pins !== null && typeof raw.pins === "object" ? raw.pins : {};
    out.autoAct = raw.autoAct === true;
    out.budgetPerHour = Number(raw.budgetPerHour) > 0 ? Math.floor(Number(raw.budgetPerHour)) : d.budgetPerHour;
    return out;
  }

  // ---------- 基础设施（每一步都可失败，失败只降级） ----------
  const db = attempt("db", () => createDb({ dir: scope.dir, log }), undefined);
  const approvals = db === undefined ? undefined : attempt("approvals", () => createApprovalStore({ db, clock: () => Date.now(), log }), undefined);
  const desktopChannel = attempt("channel.desktop", () => createDesktopChannel({ log }), undefined);
  const feishuChannel = attempt("channel.feishu", () => createFeishuChannel({ log, command: readSettings().notify.larkCommand }), undefined);
  const notifier = attempt("notifier", () => createNotifier({ desktop: desktopChannel, feishu: feishuChannel, settings: readSettings, log }), undefined);
  const prompter = attempt("prompter", () => createPrompter({ log }), undefined);
  const answerer = attempt("answerer", () => createAnswerer({ log }), undefined);
  const binder = attempt("binder", () => createSessionBinder({ log }), undefined);

  // ---------- agent 判断（模块归属）与指标出口 ----------
  const classifier = attempt("classifier", () => createClassifier({ ctx: scope.ctx, dir: scope.dir, log, readSettings }), undefined);
  const exporter = attempt("exporter", () => createExporter({ readSettings, log }), undefined);

  function echoAction(kind, text, agentId) {
    const message = "[" + kind + "] " + String(text === undefined ? "" : text).slice(0, 400);
    store.pushAction({ kind: "echo", agentId, ok: true, message });
    try { log("info", "steward echo " + message); } catch { /* ignore */ }
    return { ok: true, echo: true, message };
  }

  // actMode="echo"：动作只把 message 打进 journal 与面板，等主人 ack 后再切 "live"。
  const gatedNotifier = {
    send: async (message) => {
      const base = message === undefined || message === null ? {} : message;
      if (readSettings().actMode !== "live") {
        return echoAction("notify:" + String(base.level === undefined ? "info" : base.level), String(base.title === undefined ? "" : base.title) + " — " + String(base.text === undefined ? "" : base.text), base.subject === undefined ? undefined : String(base.subject));
      }
      if (notifier === undefined) return { ok: false, reason: "no-notifier" };
      return notifier.send(message);
    },
    threshold: () => (notifier === undefined ? 0 : notifier.threshold())
  };

  const gatedPrompter = {
    prompt: async (ctx, request) => {
      const req = request === undefined || request === null ? {} : request;
      if (readSettings().actMode !== "live") return echoAction("prompt:" + String(req.mode === undefined ? "followup" : req.mode), "-> " + String(req.sessionId === undefined ? "?" : req.sessionId) + ": " + String(req.content === undefined ? "" : req.content), req.sessionId === undefined ? undefined : String(req.sessionId));
      if (prompter === undefined) return { ok: false, reason: "no-prompter" };
      return prompter.prompt(ctx, request);
    }
  };

  const gatedAnswerer = {
    answer: async (ctx, request) => {
      const req = request === undefined || request === null ? {} : request;
      if (readSettings().actMode !== "live") return echoAction("answer", String(req.agent === undefined ? "?" : req.agent) + " / " + String(req.callId === undefined ? "?" : req.callId) + ": " + JSON.stringify(req.answers === undefined ? {} : req.answers), req.agent === undefined ? undefined : String(req.agent));
      if (answerer === undefined) return { ok: false, reason: "no-answerer" };
      return answerer.answer(ctx, request);
    }
  };

  let ruleSet = { rules: [], hash: "unavailable", overrides: {} };
  let evaluator;

  function overridesDir() { return path.join(scope.dir, "rules", "overrides"); }

  function loadRules() {
    ruleSet = buildRuleSet({ overrides: loadOverrides(overridesDir(), log), log });
    if (evaluator !== undefined) evaluator.setRuleSet(ruleSet);
    return ruleSet;
  }

  ruleSet = attempt("rules", () => loadRules(), ruleSet);
  evaluator = attempt("evaluator", () => createEvaluator({ ruleSet, clock: () => Date.now(), log }), undefined);

  const engine = db === undefined ? undefined : attempt("engine", () => createEngine({
    db,
    owner: "steward@" + String(readSettings().federation.hostId),
    clock: () => Date.now(),
    log,
    recovery: (ctx) => (ctx !== undefined && ctx.step !== undefined && ctx.step.status === "result" ? "done" : "fail"),
    onFinish: (run) => { if (run !== undefined && run !== null && run.status === "failed") log("warn", "steward: run " + String(run.id) + " failed: " + String(run.error)); }
  }), undefined);

  async function slimNow(level) {
    const heap = scope.shared !== undefined && scope.shared.runtimes !== undefined ? scope.shared.runtimes.get("heap-guard") : undefined;
    if (heap === undefined || typeof heap.action !== "function") return { ok: false, reason: "heap-guard-unavailable" };
    try { return await heap.action("slim-biggest", { level: level === undefined ? 3 : level }); }
    catch (error) { return { ok: false, reason: String(error) }; }
  }

  if (engine !== undefined) {
    attempt("workflows", () => defineWorkflows({
      engine,
      notify: gatedNotifier,
      settings: readSettings,
      hostCtx: () => scope.ctx,
      log,
      actions: { approval: approvals, prompt: gatedPrompter, answer: gatedAnswerer, slim: slimNow }
    }), undefined);
  }

  const fed = readSettings().federation;
  const peer = typeof fed.secret === "string" && fed.secret.length >= 16
    ? attempt("peer", () => createPeer({ hostId: String(fed.hostId), secret: String(fed.secret), log }), undefined)
    : undefined;

  // ---------- 路由与视图 ----------
  function modules() {
    const raw = readSettings().modules;
    return normalizeModules(raw === undefined ? DEFAULT_MODULES : raw);
  }

  function pins() { return readSettings().pins; }

  let classifyBusy = false;
  let classifyStarted = 0;

  // 确定性路由走完还是 unassigned 的，本地缓存命中就直接用，未命中排一次 agent 判断。
  function routeAll() {
    const mods = modules();
    const pinMap = pins();
    let changed = 0;
    for (const rec of store.agents.values()) {
      let next = routeAgent(rec, { modules: mods, pins: pinMap, title: rec.title });
      if (next.moduleId === "unassigned" && classifier !== undefined) {
        const guess = classifier.peek(rec, mods);
        if (guess !== undefined) next = { moduleId: guess.moduleId, reason: "agent:" + (guess.reason === "" ? "guess" : guess.reason), confidence: guess.confidence };
      }
      if (next.moduleId !== rec.moduleId || next.reason !== rec.routeReason) {
        applyRouting(rec, next);
        store.append("routing", { agentId: rec.id, sessionId: rec.sessionId, moduleId: next.moduleId, reason: next.reason, confidence: next.confidence });
        changed += 1;
      }
    }
    scheduleClassify(mods, pinMap);
    return changed;
  }

  // 每个 tick 最多 maxPerTick 个，未命中缓存的、还没有 pin 的、观察满 30 秒的才送模型。
  function scheduleClassify(mods, pinMap) {
    if (classifier === undefined || classifyBusy) return 0;
    const c = classifier.cfg();
    if (!c.enabled || c.maxPerTick <= 0) return 0;
    const now = Date.now();
    const pending = [];
    for (const rec of store.agents.values()) {
      if (rec.moduleId !== "unassigned") continue;
      if (rec.cwd === undefined && (rec.title === undefined || String(rec.title).trim().length < 2)) continue;
      if (pinMap[rec.id] !== undefined) continue;
      if (rec.sessionId !== undefined && pinMap[rec.sessionId] !== undefined) continue;
      if (rec.firstSeenAt !== undefined && now - rec.firstSeenAt < 30000) continue;
      if (!classifier.reserve(rec)) continue;
      if (classifier.peek(rec, mods) !== undefined) continue;
      pending.push(rec);
    }
    if (pending.length === 0) return 0;
    pending.sort((a, b) => (b.lastEventAt === undefined ? 0 : b.lastEventAt) - (a.lastEventAt === undefined ? 0 : a.lastEventAt));
    const batch = pending.slice(0, c.maxPerTick);
    classifyBusy = true;
    void (async () => {
      try {
        for (const rec of batch) {
          const decision = await classifier.classify(rec, mods, undefined);
          classifyStarted += 1;
          if (decision === undefined) continue;
          const fresh = store.agents.get(rec.id);
          if (fresh === undefined || fresh.moduleId !== "unassigned") continue;
          const cfg = readSettings();
          if (cfg.pins[fresh.id] !== undefined) continue;
          if (fresh.sessionId !== undefined && cfg.pins[fresh.sessionId] !== undefined) continue;
          applyRouting(fresh, { moduleId: decision.moduleId, reason: "agent:" + (decision.reason === "" ? "guess" : decision.reason), confidence: decision.confidence });
          store.append("routing", { agentId: fresh.id, sessionId: fresh.sessionId, moduleId: decision.moduleId, reason: "agent", confidence: decision.confidence, model: decision.model });
          store.pushAction({ kind: "route", agentId: fresh.id, ok: true, message: "agent 判断 -> " + decision.moduleId + " (" + (Math.round(decision.confidence * 100) / 100) + ") " + decision.reason });
        }
      } catch (error) {
        log("debug", "steward: classification batch failed: " + String(error));
      } finally {
        classifyBusy = false;
      }
    })();
    return batch.length;
  }

  function stewardSnapshot() {
    const snap = store.snapshot();
    return {
      at: Date.now(),
      hostId: String(readSettings().federation.hostId),
      health: health.last,
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

  // ---------- 规则 → 工作流 ----------
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
    if (evaluator === undefined) return 0;
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
      const result = evaluator.evaluate({ type: "agent/tick", subject: rec.id, at: t, facts });
      fired += fire(result, { agentId: rec.id, sessionId: rec.sessionId, moduleId: rec.moduleId, title: rec.title, silenceMs: facts.silenceMs });
    }
    return fired;
  }

  function evaluateHost() {
    if (evaluator === undefined) return 0;
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
    return fire(evaluator.evaluate({ type: "host/tick", subject: "host", at: Date.now(), facts }), {});
  }

  function evaluateSteward() {
    if (evaluator === undefined) return 0;
    const now = Date.now();
    const d = new Date(now);
    const budget = budgetView(now);
    const facts = { minuteOfHour: d.getMinutes(), budgetUsedPct: budget.pct, budgetUsed: budget.used };
    return fire(evaluator.evaluate({ type: "steward/tick", subject: "steward", at: now, facts }), {});
  }

  const RULE_EVENTS = ["agent/error", "agent/request-error", "subagent/end"];
  for (const type of RULE_EVENTS) {
    try {
      const off = scope.ctx.on(type, (payload) => {
        try {
          if (evaluator === undefined) return;
          const p = payload !== null && typeof payload === "object" ? payload : {};
          const agentId = p.agentId !== undefined ? String(p.agentId) : (p.agent !== undefined && p.agent !== null && p.agent.id !== undefined ? String(p.agent.id) : undefined);
          const rec = agentId === undefined ? undefined : store.agents.get(agentId);
          const facts = Object.assign({}, p, {
            agentId, sessionId: rec === undefined ? p.sessionId : rec.sessionId,
            moduleId: rec === undefined ? undefined : rec.moduleId,
            status: p.status === undefined && rec !== undefined ? rec.status : p.status,
            silenceMs: rec === undefined ? 0 : Date.now() - rec.lastEventAt
          });
          const result = evaluator.evaluate({ type, subject: agentId === undefined ? "host" : agentId, at: Date.now(), facts });
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
      events.started += evaluateAgents();
      events.started += evaluateHost();
      events.started += evaluateSteward();
      if (exporter !== undefined) {
        void exporter.maybePush(stewardSnapshot()).catch((error) => log("debug", "steward: exporter push failed: " + String(error)));
      }
      if (engine !== undefined) await engine.tick(Date.now());
      if (approvals !== undefined) { try { approvals.sweep(); } catch (error) { log("debug", "steward: approval sweep failed: " + String(error)); } }
      store.flush();
      events.lastError = undefined;
    } catch (error) {
      events.lastError = String(error);
      log("warn", "steward tick failed: " + events.lastError);
    }
  }

  void tick();
  const timer = setInterval(() => { void tick(); }, c.tickSec * 1000);
  if (typeof timer.unref === "function") timer.unref();
  scope.onDispose(() => {
    clearInterval(timer);
    for (const off of offs.splice(0)) { try { off(); } catch { /* ignore */ } }
    bus.dispose();
    health.dispose();
    store.flush();
    if (db !== undefined && typeof db.closeSafely === "function") { try { db.closeSafely(); } catch { /* ignore */ } }
  });

  scope.runtime = {
    store, titles, agentsSource, bus, health, events, db, engine, approvals, peer, notifier, prompter, answerer, binder,
    modulesView, agentsView, routeAll, tick, readSettings, rules: () => ruleSet, evaluator: () => evaluator, loadRules,
    budgetView, runsView, approvalsView, classifier, exporter, classifyStarted: () => classifyStarted
  };

  // ---------- 路由 ----------
  scope.route("GET", "/", (req, res) => scope.core.sendHtml(res, 200, stewardPanelHtml({ embed: true })));
  scope.route("GET", "/index.html", (req, res) => scope.core.sendHtml(res, 200, stewardPanelHtml({ embed: true })));
  scope.route("GET", "/panel", (req, res) => scope.core.sendHtml(res, 200, stewardPanelHtml({ embed: true })));
  scope.route("GET", "/api/state", (req, res) => {
    const snap = store.snapshot();
    const cfg = readSettings();
    scope.core.sendJson(res, 200, {
      ok: true,
      at: Date.now(),
      health: health.last === undefined ? null : health.last,
      agents: agentsView(),
      modules: modulesView(),
      signals: snap.signals.slice(0, 60),
      actions: snap.actions.slice(0, 40),
      counters: snap.counters,
      journal: snap.journal,
      titles: { size: titles.size(), error: titles.error() },
      runs: runsView(20),
      approvals: approvalsView(),
      budget: budgetView(Date.now()),
      rules: { count: (ruleSet.rules || []).length, hash: ruleSet.hash, stats: evaluator === undefined ? null : evaluator.stats() },
      federation: peer === undefined ? null : { hostId: peer.hostId, peers: peer.peers(), pending: peer.pending(), seen: peer.seenCount() },
      degraded: events.degraded.slice(-8),
      echoes: snap.actions.filter((a) => a.kind === "echo").slice(0, 20),
      moduleDefs: modules(),
      control: {
        autoAct: cfg.autoAct === true,
        actMode: cfg.actMode,
        classifier: classifier === undefined ? null : classifier.stats(),
        export: exporter === undefined ? null : exporter.stats(),
        classifyStarted,
        actuator: cfg.actions,
        notify: cfg.notify,
        session: cfg.session,
        federation: { hostId: cfg.federation.hostId, secret: cfg.federation.secret === "" ? "" : "set", peerUrl: cfg.federation.peerUrl },
        pins: cfg.pins,
        modules: modules().length,
        engine: engine !== undefined,
        approvals: approvals !== undefined,
        peer: peer !== undefined
      }
    });
  });
  scope.route("GET", "/api/agents", (req, res) => scope.core.sendJson(res, 200, { ok: true, agents: agentsView() }));
  scope.route("GET", "/api/modules", (req, res) => scope.core.sendJson(res, 200, { ok: true, modules: modulesView() }));
  scope.route("GET", "/api/signals", (req, res) => {
    const limit = scope.core.intOf(scope.core.queryOf(req).get("limit"), 50, 1, 400);
    scope.core.sendJson(res, 200, { ok: true, signals: store.snapshot().signals.slice(0, limit) });
  });
  scope.route("GET", "/api/health", (req, res) => scope.core.sendJson(res, 200, { ok: true, health: health.last, history: health.history.slice(-120) }));
  scope.route("GET", "/api/runs", (req, res) => {
    const limit = scope.core.intOf(scope.core.queryOf(req).get("limit"), 20, 1, 100);
    scope.core.sendJson(res, 200, { ok: true, runs: runsView(limit), engine: engine !== undefined });
  });
  scope.route("GET", "/api/approvals", (req, res) => scope.core.sendJson(res, 200, { ok: true, approvals: approvalsView() }));
  scope.route("GET", "/api/rules", (req, res) => scope.core.sendJson(res, 200, {
    ok: true, hash: ruleSet.hash, count: (ruleSet.rules || []).length,
    rules: (ruleSet.rules || []).map((r) => ({ id: r.id, title: r.title, severity: r.severity, when: r.when, enabled: r.enabled !== false && r.enabledByDefault !== false })),
    stats: evaluator === undefined ? null : evaluator.stats()
  }));
  scope.route("POST", "/api/rules/reload", (req, res) => {
    const loaded = attempt("rules.reload", () => loadRules(), ruleSet);
    scope.core.sendJson(res, 200, { ok: true, hash: loaded.hash, count: (loaded.rules || []).length, degraded: events.degraded.slice(-4) });
  });
  scope.route("GET", "/api/federation", (req, res) => {
    if (peer === undefined) { scope.core.sendJson(res, 200, { ok: true, enabled: false, reason: "federation.secret not configured" }); return; }
    scope.core.sendJson(res, 200, { ok: true, enabled: true, hostId: peer.hostId, peers: peer.peers(), pending: peer.pending(), commands: peer.commands().slice(-20), seen: peer.seenCount() });
  });
  scope.route("POST", "/api/federation/receive", async (req, res) => {
    if (peer === undefined) { scope.core.sendJson(res, 409, { ok: false, reason: "federation disabled" }); return; }
    const parsed = await scope.core.readBody(req);
    if (!parsed.ok) { scope.core.sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    const result = peer.receive(parsed.value !== null && typeof parsed.value === "object" && parsed.value.envelope !== undefined ? parsed.value.envelope : parsed.value);
    scope.core.sendJson(res, result.ok ? 200 : 400, result);
  });
  scope.route("POST", "/api/answer", async (req, res) => {
    if (approvals === undefined) { scope.core.sendJson(res, 409, { ok: false, reason: "approval store unavailable" }); return; }
    const parsed = await scope.core.readBody(req);
    if (!parsed.ok) { scope.core.sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    const body = parsed.value !== null && typeof parsed.value === "object" ? parsed.value : {};
    const result = approvals.answer(body.id, body.answer === undefined ? "approve" : body.answer, body.by === undefined ? "panel" : String(body.by), body.version === undefined ? undefined : Number(body.version));
    store.pushAction({ kind: "approval", agentId: undefined, ok: result.ok === true, message: "approval " + String(body.id) + " -> " + String(body.answer) });
    scope.core.sendJson(res, result.ok ? 200 : 409, result);
  });
  scope.route("POST", "/api/replay", async (req, res) => {
    if (engine === undefined) { scope.core.sendJson(res, 409, { ok: false, reason: "engine unavailable" }); return; }
    const parsed = await scope.core.readBody(req);
    if (!parsed.ok) { scope.core.sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    const body = parsed.value !== null && typeof parsed.value === "object" ? parsed.value : {};
    const run = engine.get(String(body.runId));
    if (run === undefined) { scope.core.sendJson(res, 404, { ok: false, reason: "no such run" }); return; }
    try {
      const next = engine.start(run.wf, { subject: run.subject, moduleId: run.module_id, vars: run.vars_json, traceId: "replay:" + run.id });
      scope.core.sendJson(res, 200, { ok: true, runId: next.id, from: run.id });
    } catch (error) {
      scope.core.sendJson(res, 500, { ok: false, error: String(error) });
    }
  });
  scope.route("GET", "/api/tick", (req, res) => {
    const snap = store.snapshot();
    scope.core.sendJson(res, 200, {
      ok: true, at: Date.now(),
      rev: [snap.agents.length, snap.signals.length, snap.counters.events, snap.journal.seq, health.last === undefined ? 0 : health.last.heapUsedMB, readSettings().autoAct === true ? 1 : 0, runsView(50).filter((r) => r.status !== "done" && r.status !== "failed").length, approvalsView().length]
    });
  });
  scope.route("GET", "/metrics", (req, res) => {
    const exp = exporter === undefined ? undefined : exporter.cfg();
    if (exp === undefined || exp.prometheus !== true) {
      scope.core.sendText(res, 404, "text/plain; charset=utf-8", "# polaris metrics disabled\n");
      return;
    }
    scope.core.sendText(res, 200, "text/plain; charset=utf-8", prometheusText(stewardSnapshot()) + "\n");
  });
  scope.route("POST", "/api/classify", async (req, res) => {
    if (classifier === undefined) { scope.core.sendJson(res, 409, { ok: false, reason: "classifier unavailable" }); return; }
    const parsed = await scope.core.readBody(req);
    if (!parsed.ok) { scope.core.sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    const body = parsed.value !== null && typeof parsed.value === "object" ? parsed.value : {};
    const key = body.agentId !== undefined ? String(body.agentId) : (body.sessionId !== undefined ? String(body.sessionId) : "");
    if (key === "") { scope.core.sendJson(res, 400, { ok: false, error: "agentId or sessionId required" }); return; }
    const rec = store.agents.get(key) !== undefined
      ? store.agents.get(key)
      : Array.from(store.agents.values()).find((a) => a.sessionId === key || String(a.sessionId).startsWith(key));
    if (rec === undefined) { scope.core.sendJson(res, 404, { ok: false, error: "no such agent " + key }); return; }
    const mods = modules();
    if (body.force === true || body.force === "true") classifier.forget(rec, mods);
    let decision = classifier.peek(rec, mods);
    const fromCache = decision !== undefined;
    if (decision === undefined) decision = await classifier.classify(rec, mods, undefined);
    if (decision === undefined) {
      scope.core.sendJson(res, 200, { ok: false, reason: "classifier gave no decision", agentId: rec.id, moduleId: rec.moduleId });
      return;
    }
    if (decision.moduleId !== "unassigned" && rec.moduleId === "unassigned") {
      applyRouting(rec, { moduleId: decision.moduleId, reason: "agent:" + decision.reason, confidence: decision.confidence });
      store.append("routing", { agentId: rec.id, sessionId: rec.sessionId, moduleId: decision.moduleId, reason: "agent", confidence: decision.confidence, model: decision.model });
    }
    classifyStarted += 1;
    scope.core.sendJson(res, 200, { ok: true, agentId: rec.id, moduleId: decision.moduleId, confidence: decision.confidence, reason: decision.reason, model: decision.model, cached: fromCache });
  });
  scope.route("POST", "/api/pin", async (req, res) => {
    const parsed = await scope.core.readBody(req);
    if (!parsed.ok) { scope.core.sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    const body = parsed.value !== null && typeof parsed.value === "object" ? parsed.value : {};
    const key = body.agentId !== undefined ? String(body.agentId) : (body.sessionId !== undefined ? String(body.sessionId) : undefined);
    if (key === undefined) { scope.core.sendJson(res, 400, { ok: false, error: "agentId or sessionId required" }); return; }
    const mod = body.module === undefined || body.module === null || body.module === "auto" ? undefined : String(body.module);
    const next = Object.assign({}, pins());
    if (mod === undefined) delete next[key]; else next[key] = mod;
    scope.settings.set({ pins: next });
    routeAll();
    scope.core.sendJson(res, 200, { ok: true, pins: next });
  });
  scope.route("POST", "/api/settings", async (req, res) => {
    const parsed = await scope.core.readBody(req);
    if (!parsed.ok) { scope.core.sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    const body = parsed.value !== null && typeof parsed.value === "object" ? parsed.value : {};
    const patch = body.patch !== null && typeof body.patch === "object" && !Array.isArray(body.patch) ? body.patch : {};
    const allow = ["autoAct", "actMode", "actions", "notify", "session", "federation", "budgetPerHour", "modules", "pins", "classifier", "export"];
    const filtered = {};
    for (const key of allow) if (patch[key] !== undefined) filtered[key] = patch[key];
    if (filtered.actions !== undefined && filtered.actions !== null) filtered.actions = Object.assign({}, readSettings().actions, filtered.actions);
    if (filtered.notify !== undefined && filtered.notify !== null) filtered.notify = Object.assign({}, readSettings().notify, filtered.notify);
    if (filtered.session !== undefined && filtered.session !== null) filtered.session = Object.assign({}, readSettings().session, filtered.session);
    if (filtered.federation !== undefined && filtered.federation !== null) filtered.federation = Object.assign({}, readSettings().federation, filtered.federation);
    if (filtered.classifier !== undefined && filtered.classifier !== null) filtered.classifier = Object.assign({}, readSettings().classifier, filtered.classifier);
    if (filtered.export !== undefined && filtered.export !== null) {
      const exp = Object.assign({}, readSettings().export, filtered.export);
      exp.otlp = Object.assign({}, readSettings().export.otlp, filtered.export.otlp !== null && typeof filtered.export.otlp === "object" ? filtered.export.otlp : {});
      filtered.export = exp;
    }
    const next = Object.keys(filtered).length === 0 ? readSettings() : scope.settings.set(filtered);
    store.pushAction({ kind: "settings", agentId: undefined, ok: true, message: "patch " + Object.keys(filtered).join(",") });
    scope.core.sendJson(res, 200, { ok: true, settings: next === undefined ? readSettings() : next });
  });
  scope.route("POST", "/api/action", async (req, res) => {
    const parsed = await scope.core.readBody(req);
    if (!parsed.ok) { scope.core.sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    const body = parsed.value !== null && typeof parsed.value === "object" ? parsed.value : {};
    const actionId = body.id === undefined ? "" : String(body.id);
    if (actionId === "collect") {
      agentsSource.sync();
      await agentsSource.refreshTitles();
      await agentsSource.refreshCwd();
      routeAll();
      health.sample();
      events.lastCollect = Date.now();
      store.pushAction({ kind: "collect", agentId: undefined, ok: true, message: "manual collect" });
      scope.core.sendJson(res, 200, { ok: true, agents: store.agents.size, modules: modulesView().length });
      return;
    }
    if (actionId === "flush") {
      store.flush();
      scope.core.sendJson(res, 200, { ok: true, journal: store.snapshot().journal });
      return;
    }
    if (actionId === "digest") {
      const rollup = buildRollup({
        agents: agentsView(), runs: runsView(10), signals: store.snapshot().signals.slice(0, 20),
        approvals: approvalsView(), health: health.last, budget: budgetView(Date.now()), now: Date.now()
      });
      const text = renderRollup(rollup);
      const sent = notifier === undefined ? { ok: false, reason: "no-notifier" } : await notifier.send({ title: "Polaris 汇报", text, level: "info", subject: "digest" });
      store.pushAction({ kind: "digest", agentId: undefined, ok: sent !== undefined && sent.ok === true, message: "manual digest" });
      scope.core.sendJson(res, 200, { ok: true, sent, text });
      return;
    }
    if (actionId === "reload-rules") {
      const loaded = loadRules();
      scope.core.sendJson(res, 200, { ok: true, hash: loaded.hash, count: (loaded.rules || []).length });
      return;
    }
    scope.core.sendJson(res, 404, { ok: false, error: "unknown action " + actionId });
  });
  scope.route("*", (req, res, sub) => { scope.core.sendJson(res, 404, { ok: false, error: "no such route", path: sub }); });

  // ---------- 工具 ----------
  function textOut(value) {
    return { schema: { type: "object", additionalProperties: true, properties: { text: { type: "string" } } }, render: (v) => ({ type: "text", text: v !== null && typeof v === "object" && typeof v.text === "string" ? v.text : String(v) }) };
  }

  scope.tool({
    name: "steward_observe",
    description: "Read-only snapshot of every agent the DSH host is running: agent id, session title, module bucket, status, silence duration, turns, pending user question, latest attention signals, open workflow runs and pending approvals. Use it to see what the steward currently knows about the fleet.",
    parameters: {},
    output: textOut(),
    execute: async () => {
      agentsSource.sync();
      routeAll();
      const rows = agentsView().slice().sort((a, b) => b.lastEventAt - a.lastEventAt).slice(0, 20);
      const lines = ["steward observe  agents " + store.agents.size + "  modules " + modulesView().length + "  signals " + store.snapshot().signals.length + "  runs " + runsView(50).length + "  approvals " + approvalsView().length];
      for (const row of rows) {
        const name = row.title === undefined ? "session " + String(row.sessionId === undefined ? row.id : row.sessionId).slice(0, 8) : row.title;
        lines.push("  [" + row.moduleId + "] " + name + "  " + row.status + (row.stalled === true ? " (stalled)" : "") + (row.attention === true ? " (attention:" + String(row.attentionReason) + ")" : "") + "  silence " + Math.round((Date.now() - row.lastEventAt) / 1000) + "s");
      }
      if (events.degraded.length > 0) lines.push("  degraded: " + events.degraded.slice(-3).join(" | "));
      return { text: lines.join("\n") };
    }
  });

  scope.tool({
    name: "steward_status",
    description: "Report the steward's own state: evaluated rules and hash, opened/finished workflow runs, pending approvals, hourly action budget, notification channels, federation peers, and any degraded subsystem. Read-only.",
    parameters: {},
    output: textOut(),
    execute: async () => {
      const cfg = readSettings();
      const stats = evaluator === undefined ? null : evaluator.stats();
      const lines = [
        "steward status  rules " + (ruleSet.rules || []).length + "  hash " + String(ruleSet.hash) + "  evaluated " + String(stats === null ? "-" : stats.evaluated) + "  matched " + String(stats === null ? "-" : stats.matched),
        "  engine " + (engine !== undefined ? "on" : "off") + "  runs open " + runsView(100).filter((r) => r.status !== "done" && r.status !== "failed").length + "  approvals open " + approvalsView().length,
        "  budget " + budgetView(Date.now()).used + "/" + budgetView(Date.now()).max + " per hour",
        "  notify minSeverity " + cfg.notify.minSeverity + "  lark " + (cfg.notify.larkEnabled === true ? "on" : "off") + "  autoAct " + (cfg.autoAct === true ? "ON" : "off") + "  stallSteer " + (cfg.actions.stallSteer === true ? "ON" : "off") + "  heapSlim " + (cfg.actions.heapSlim === true ? "ON" : "off"),
        "  actMode " + cfg.actMode + (cfg.actMode === "echo" ? " (动作只打印 message，等 ack 再切 live)" : " (真执行)") + "  classifier " + (classifier === undefined ? "off" : (cfg.classifier.enabled === true ? "on" : "off") + " model " + (cfg.classifier.model === "" ? "host-default" : cfg.classifier.model) + " cached " + classifier.stats().cached + " calls " + classifier.stats().calls + " judged " + classifyStarted),
        "  export prometheus " + (exporter === undefined ? "off" : (cfg.export.prometheus === true ? "on" : "off")) + "  otlp " + (exporter === undefined || cfg.export.otlp.enabled !== true ? "off" : cfg.export.otlp.endpoint) + "  echoes " + store.snapshot().actions.filter((a) => a.kind === "echo").length,
        "  federation " + (peer === undefined ? "off" : peer.hostId + " peers " + peer.peers().length),
        "  degraded " + (events.degraded.length === 0 ? "none" : events.degraded.slice(-5).join(" | "))
      ];
      return { text: lines.join("\n") };
    }
  });

  scope.tool({
    name: "steward_begin",
    description: "Start a durable steward workflow. Use it when a decision needs an auditable, restart-safe sequence of side effects (notify / ask / digest / protect) instead of acting directly. Returns the run id; progress continues on the steward tick, so you do not need to wait for it.",
    parameters: {
      workflow: { type: "string", description: "Workflow name: wf.notify | wf.ask | wf.digest | wf.host.protect | wf.agent.stall" },
      subject: { type: "string", description: "Subject the run is serialized on (agent id, session id, module id or 'host')." },
      text: { type: "string", description: "Human-readable text carried into the workflow." },
      vars: { type: "object", additionalProperties: true, description: "Extra variables handed to the workflow." }
    },
    output: textOut(),
    execute: async (args) => {
      if (engine === undefined) return { text: "steward_begin failed: engine unavailable (no db)" };
      const wf = String(args.workflow === undefined ? "wf.notify" : args.workflow);
      try {
        const vars = Object.assign({}, args.vars === undefined || args.vars === null ? {} : args.vars, { text: args.text === undefined ? "" : String(args.text) });
        const run = engine.start(wf, { subject: args.subject === undefined ? "host" : String(args.subject), vars, moduleId: vars.moduleId });
        store.pushAction({ kind: "tool.begin", agentId: undefined, ok: true, message: wf + " -> " + run.id });
        return { text: "steward_begin  run " + run.id + "  wf " + run.wf + "  subject " + run.subject + "  status " + run.status };
      } catch (error) {
        return { text: "steward_begin failed: " + String(error) };
      }
    }
  });

  scope.tool({
    name: "steward_report",
    description: "Report to the owner through the steward notification channels (desktop ring always, Feishu only when notify.larkEnabled is on). This is the sanctioned way for a module steward to reach the human without messaging them directly; it respects notify.minSeverity.",
    parameters: {
      text: { type: "string", description: "Report body." },
      title: { type: "string", description: "Optional title." },
      level: { type: "string", description: "info | warning | error | critical (default info)." }
    },
    output: textOut(),
    execute: async (args) => {
      if (notifier === undefined) return { text: "steward_report failed: notifier unavailable" };
      const level = String(args.level === undefined ? "info" : args.level);
      const sent = await notifier.send({ title: String(args.title === undefined ? "Polaris 汇报" : args.title), text: String(args.text === undefined ? "" : args.text), level, subject: "report" });
      store.pushAction({ kind: "tool.report", agentId: undefined, ok: sent !== undefined && sent.ok === true, message: "report " + level });
      return { text: "steward_report " + (sent !== undefined && sent.ok === true ? "sent" : "not-sent") + "  " + JSON.stringify(sent) };
    }
  });

  scope.tool({
    name: "steward_ask",
    description: "Ask the owner for a decision. Creates a durable approval row and a waiting workflow run; the answer can arrive from the panel or another device, and survives a restart. Use it instead of guessing when the choice is consequential.",
    parameters: {
      title: { type: "string", description: "What you are asking." },
      detail: { type: "string", description: "Context the owner needs to decide." },
      subject: { type: "string", description: "Subject to serialize the run on (default 'host')." },
      ttlMs: { type: "number", description: "How long to wait before expiring (default 30 minutes)." }
    },
    output: textOut(),
    execute: async (args) => {
      if (engine === undefined) return { text: "steward_ask failed: engine unavailable (no db)" };
      if (approvals === undefined) return { text: "steward_ask failed: approval store unavailable" };
      try {
        const run = engine.start("wf.ask", {
          subject: args.subject === undefined ? "host" : String(args.subject),
          vars: {
            title: String(args.title === undefined ? "请示" : args.title),
            detail: String(args.detail === undefined ? "" : args.detail),
            level: "warning",
            ttlMs: args.ttlMs === undefined ? 1_800_000 : Number(args.ttlMs)
          }
        });
        await engine.tick(Date.now());
        const fresh = engine.get(run.id);
        return { text: "steward_ask  run " + run.id + "  status " + String(fresh === undefined ? run.status : fresh.status) + "  approval " + String(fresh === undefined ? "-" : fresh.vars_json.approvalId) };
      } catch (error) {
        return { text: "steward_ask failed: " + String(error) };
      }
    }
  });
}

export async function action(scope, actionId, body) {
  const rt = scope.runtime;
  if (rt === undefined) return { ok: false, reason: "feature not started" };
  if (actionId === "collect") {
    rt.agentsSource.sync();
    await rt.agentsSource.refreshTitles();
    await rt.agentsSource.refreshCwd();
    rt.routeAll();
    rt.health.sample();
    rt.events.lastCollect = Date.now();
    return { ok: true, agents: rt.store.agents.size };
  }
  if (actionId === "flush") { rt.store.flush(); return { ok: true, journal: rt.store.snapshot().journal }; }
  if (actionId === "digest") {
    const rollup = buildRollup({
      agents: rt.agentsView(), runs: rt.runsView(10), signals: rt.store.snapshot().signals.slice(0, 20),
      approvals: rt.approvalsView(), health: rt.health.last, budget: rt.budgetView(Date.now()), now: Date.now()
    });
    const text = renderRollup(rollup);
    const sent = rt.notifier === undefined ? { ok: false, reason: "no-notifier" } : await rt.notifier.send({ title: "Polaris 汇报", text, level: "info", subject: "digest" });
    return { ok: true, sent, text };
  }
  if (actionId === "reload-rules") {
    const loaded = rt.loadRules();
    return { ok: true, hash: loaded.hash, count: (loaded.rules || []).length };
  }
  return { ok: false, reason: "unknown action " + String(actionId) };
}

export function status(scope) {
  const rt = scope.runtime;
  if (rt === undefined) return { level: "ok", headline: "未启动", lines: [] };
  try {
    const agentsRows = Array.from(rt.store.agents.values());
    const running = agentsRows.filter((rec) => rec.status === "running").length;
    const attention = agentsRows.filter((rec) => rec.attention === true || rec.stalled === true).length;
    const signals = rt.store.snapshot().signals;
    const errors = signals.filter((sig) => sig.severity === "error").length;
    const health = rt.health.last;
    const openRuns = rt.runsView(100).filter((r) => r.status !== "done" && r.status !== "failed").length;
    const openApprovals = rt.approvalsView().length;
    const level = errors > 0 ? "high" : (attention > 0 || openApprovals > 0 ? "warn" : "ok");
    const headline = "观察 " + agentsRows.length + " 个 agent（运行 " + running + "），待决 " + attention + "，待批 " + openApprovals + "，运行中流程 " + openRuns + "，信号 " + signals.length + (health === undefined ? "" : "，堆 " + health.heapUsedMB + " MB");
    return {
      level, headline,
      lines: [
        "modules: " + rt.modulesView().map((m) => m.id + " " + m.count).join(", "),
        "journal: " + rt.store.snapshot().journal.file,
        "loop p99: " + (health === undefined ? "-" : health.loop.p99Ms + " ms"),
        "degraded: " + (rt.events.degraded.length === 0 ? "none" : rt.events.degraded.slice(-2).join(" | "))
      ]
    };
  } catch (error) {
    return { level: "ok", headline: "status error: " + String(error), lines: [] };
  }
}

export default { id, title, subtitle, order, Config, settings, actions, normalize, setup, action, status };

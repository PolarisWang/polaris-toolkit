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
import { mountHttp, action, status } from "./http.js";
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

/**
 * 运行时设置的校验 schema（P1-6）。面板与 HTTP 都会先深合并再校验：
 * actMode / budgetPerHour 这类会被 actuator 直接消费的字段必须在这里挡住非法值。
 */
export const settingsSchema = z.object({
  notify: z.object({
    minSeverity: z.union(["info", "warning", "error", "critical"]).default("warning"),
    larkEnabled: z.boolean().default(false),
    larkCommand: z.string().default("lark-cli")
  }).default({}),
  actions: z.object({
    stallSteer: z.boolean().default(false),
    heapSlim: z.boolean().default(false)
  }).default({}),
  session: z.object({
    mode: z.union(["manual", "auto"]).default("manual"),
    preset: z.string().default("steward"),
    title: z.string().default("大内总管"),
    model: z.string().default("auto"),
    rotateTurns: z.natural().default(200),
    rotateTokens: z.natural().default(300000)
  }).default({}),
  federation: z.object({
    hostId: z.string().default("win-main"),
    secret: z.string().default(""),
    peerUrl: z.string().default("")
  }).default({}),
  actMode: z.union(["echo", "live"]).default("echo"),
  classifier: z.object({
    enabled: z.boolean().default(true),
    provider: z.string().default(""),
    model: z.string().default(""),
    minConfidence: z.number().min(0).max(1).default(0.55),
    maxPerTick: z.natural().max(50).default(2),
    timeoutMs: z.natural().default(12000),
    maxTokens: z.natural().default(120),
    ttlDays: z.natural().default(7)
  }).default({}),
  export: z.object({
    prometheus: z.boolean().default(true),
    intervalSec: z.natural().min(5).default(60),
    otlp: z.object({
      enabled: z.boolean().default(false),
      endpoint: z.string().default(""),
      headers: z.any().default({})
    }).default({})
  }).default({}),
  budgetPerHour: z.natural().min(1).max(100000).default(60),
  autoAct: z.boolean().default(false),
  tickSec: z.natural().min(1).max(3600).default(5),
  stallMinutes: z.natural().min(1).max(1440).default(8),
  modules: z.any().default([]),
  pins: z.any().default({})
});

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
      // capability（P1-4）：只认名字，不认 heap-guard 的内部结构；没装就返回空数组。
      const getter = scope.use("heap-guard.titles");
      const titleStore = typeof getter === "function" ? getter() : undefined;
      if (titleStore === undefined || typeof titleStore.entries !== "function") return [];
      return titleStore.entries();
    } catch { return []; }
  };
  const titles = createTitleSource({ ctx: scope.ctx, log, fallback: titlesFromHeapGuard });
  const agentsSource = createAgentsSource({ ctx: scope.ctx, store, titles, log });
  const bus = createBus({ ctx: scope.ctx, store, log });
  const health = createHealth({ host: scope.host });
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

  // ---------- 指标发布（评审 P0-2：只发布，不采样） ----------
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
    // capability（P1-4）：heap-guard 没装/没起来时优雅降级，而不是抛。
    const act = scope.use("heap-guard.action");
    if (typeof act !== "function") return { ok: false, reason: "heap-guard-unavailable" };
    try { return await act("slim-biggest", { level: level === undefined ? 3 : level }); }
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
  const counters = { classifyStarted: 0 };

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
          counters.classifyStarted += 1;
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
  // 统一调度（P2-11）：不再自己 setInterval，堆压力高时工具包会整体降频。
  const offTick = scope.every(Math.max(1000, c.tickSec * 1000), () => { void tick(); }, { jitter: 0.1 });
  scope.onDispose(() => {
    try { if (typeof offTick === "function") offTick(); } catch { /* ignore */ }
    for (const off of offs.splice(0)) { try { off(); } catch { /* ignore */ } }
    bus.dispose();
    health.dispose();
    store.flush();
    if (db !== undefined && typeof db.closeSafely === "function") { try { db.closeSafely(); } catch { /* ignore */ } }
  });

  scope.runtime = {
    store, titles, agentsSource, bus, health, events, db, engine, approvals, peer, notifier, prompter, answerer, binder,
    modulesView, agentsView, routeAll, tick, readSettings, rules: () => ruleSet, evaluator: () => evaluator, loadRules,
    budgetView, runsView, approvalsView, classifier, exporter, classifyStarted: () => counters.classifyStarted
  };

  // ---------- 路由 / 工具（实现见 http.js）----------
  mountHttp(scope, {
    agentsSource, agentsView, approvals, approvalsView, attempt, budgetView,
    classifier, counters, engine, ensureModuleGauges, events, exporter, health,
    loadRules, modules, modulesView, notifier, peer, pins, readSettings, routeAll,
    runsView, stewardSnapshot, store, titles,
    getRuleSet: () => ruleSet,
    getEvaluator: () => evaluator,
  });
}

export { action, status };

export default { id, title, subtitle, order, Config, settings, actions, normalize, setup, action, status };
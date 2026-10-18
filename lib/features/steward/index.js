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
import {
  Config, actions, DEFAULTS, settings, settingsSchema, normalize, clone, createReadSettings
} from "./config.js";
import { createStore } from "./core/store.js";
import { createGated } from "./actuators/gated.js";
import { createStewardMetrics } from "./metrics.js";
import { createViews } from "./state.js";
import { createBrain } from "./brain.js";
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

  const readSettings = createReadSettings(scope);

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

  const gated = createGated({ readSettings, store, log, notifier, prompter, answerer });
  const { echoAction } = gated;
  const gatedNotifier = gated.notifier;
  const gatedPrompter = gated.prompter;
  const gatedAnswerer = gated.answerer;

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

  const { stewardSnapshot, modulesView, agentsView, budgetView, runsView, approvalsView } = createViews({
    store, titles, health, events, modules, readSettings, approvals, engine, scope,
  });

  // 指标发布（评审 P0-2）：视图建好之后再注册 gauge，否则会踩 TDZ。
  const stewardMetrics = createStewardMetrics(scope, {
    agentsView, modulesView, approvalsView, runsView, budgetView, store, titles, readSettings,
  });

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


  // ---------- 规则 → 工作流（实现见 brain.js）----------
  const brain = createBrain(scope, {
    agentsSource, approvals, binder, budgetView, bus, c, classifier, counters, db, engine,
    events, exporter, health, loadRules, log, modulesView, notifier, offs, peer, prompter,
    readSettings, routeAll, stewardSnapshot, store, titles,
    getRuleSet: () => ruleSet,
    getEvaluator: () => evaluator,
  });
  const { tick, offTick } = brain;
  void tick();
  scope.onDispose(() => {
    try { if (typeof offTick === "function") offTick(); } catch { /* ignore */ }
    try { stewardMetrics.dispose(); } catch { /* ignore */ }
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
    classifier, counters, engine, ensureModuleGauges: stewardMetrics.ensureModuleGauges, events, exporter, health,
    loadRules, modules, modulesView, notifier, peer, pins, readSettings, routeAll,
    runsView, stewardSnapshot, store, titles,
    getRuleSet: () => ruleSet,
    getEvaluator: () => evaluator,
  });
}

export { action, status };
export { Config, actions, settings, settingsSchema, normalize };

export default { id, title, subtitle, order, Config, settings, settingsSchema, actions, normalize, setup, action, status };
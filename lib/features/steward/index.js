/**
 * Feature: Steward（大内总管 / 多会话总管团）
 *
 * P0 范围（docs/steward-design.md 14 章）：观察面 + 账本 + 面板。
 *   - 收集全部 agent 状态（事件 + 定时对账）；
 *   - 把 agent 归到模块（pin / 工作区 / 标题），LLM 兜底留到 P1；
 *   - 宿主健康（堆、事件循环、崩溃日志）与信号流；
 *   - 只读：不代答、不 steer、不发消息、不改别人的会话。
 *
 * 为什么先只读：总管一旦能动手，就必须先有工作流引擎的幂等与租约兜底，
 * 否则"重试一次"就可能给同一个 agent 发两遍消息。顺序不能倒。
 */
import z from "@deepseek-ai/schemastery";
import { createStore } from "./core/store.js";
import { createBus } from "./core/bus.js";
import { createHealth } from "./health.js";
import { createAgentsSource } from "./sources/agents.js";
import { createTitleSource } from "./sources/titles.js";
import { applyRouting, normalizeModules, routeAgent, DEFAULT_MODULES } from "./modules.js";
import { stewardPanelHtml } from "./panel.js";

export const id = "steward";
export const title = "Steward";
export const subtitle = "大内总管：观察全部 agent、归类到模块、形成待决信号";
export const order = 20;

export const Config = z.object({
  tickSec: z.natural().default(5),
  titleSec: z.natural().default(60),
  stallMinutes: z.natural().default(8),
  journalDays: z.natural().default(30)
});

export const actions = [
  { id: "collect", kind: "button", label: "强制采样", hint: "立即对账一次 agent 列表、刷新会话名与健康数据（只读）" },
  { id: "flush", kind: "button", label: "落盘 journal", hint: "把内存里待写的观察记录立刻写进 journal-YYYYMMDD.jsonl" }
];

export function settings(config) {
  const c = normalize(config);
  return {
    modules: DEFAULT_MODULES,
    pins: {},
    notify: { minSeverity: "warning", larkEnabled: false },
    autoAct: false,
    tickSec: c.tickSec,
    stallMinutes: c.stallMinutes
  };
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

export function setup(scope) {
  const c = normalize(scope.config);
  const log = (level, message) => scope.log(level, message);
  const store = createStore({ dir: scope.dir, log });
  const titles = createTitleSource({ ctx: scope.ctx, log });
  const agentsSource = createAgentsSource({ ctx: scope.ctx, store, titles, log });
  const bus = createBus({ ctx: scope.ctx, store, log });
  const health = createHealth();
  const events = { startedAt: Date.now(), lastCollect: undefined, lastError: undefined, ticks: 0 };

  function modules() {
    const raw = scope.settings.get("modules");
    return normalizeModules(raw === undefined ? DEFAULT_MODULES : raw);
  }

  function pins() {
    const raw = scope.settings.get("pins");
    return raw !== null && typeof raw === "object" ? raw : {};
  }

  function routeAll() {
    const mods = modules();
    const pinMap = pins();
    let changed = 0;
    for (const rec of store.agents.values()) {
      const next = routeAgent(rec, { modules: mods, pins: pinMap, title: rec.title });
      if (next.moduleId !== rec.moduleId || next.reason !== rec.routeReason) {
        applyRouting(rec, next);
        store.append("routing", { agentId: rec.id, sessionId: rec.sessionId, moduleId: next.moduleId, reason: next.reason, confidence: next.confidence });
        changed += 1;
      }
    }
    return changed;
  }

  function modulesView() {
    const mods = modules();
    return mods.map((mod) => {
      const rows = Array.from(store.agents.values()).filter((rec) => rec.moduleId === mod.id);
      return {
        id: mod.id,
        name: mod.name,
        host: mod.host,
        enabled: mod.enabled,
        count: rows.length,
        running: rows.filter((rec) => rec.status === "running").length,
        attention: rows.filter((rec) => rec.attention === true || rec.stalled === true).length
      };
    });
  }

  function agentsView() {
    return Array.from(store.agents.values()).map((rec) => ({
      id: rec.id,
      sessionId: rec.sessionId,
      title: rec.title,
      status: rec.status,
      statusSince: rec.statusSince,
      lastEventAt: rec.lastEventAt,
      lastEventType: rec.lastEventType,
      moduleId: rec.moduleId,
      routeReason: rec.routeReason,
      routeConfidence: rec.routeConfidence,
      stalled: rec.stalled === true,
      attention: rec.attention === true,
      attentionReason: rec.attentionReason,
      question: rec.question,
      turns: rec.turns,
      errors: rec.errors,
      events: rec.events
    }));
  }

  async function tick() {
    events.ticks += 1;
    try {
      agentsSource.sync();
      if (events.ticks % Math.max(1, Math.round(c.titleSec / c.tickSec)) === 0) await agentsSource.refreshTitles();
      routeAll();
      health.sample();
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
    bus.dispose();
    health.dispose();
    store.flush();
  });

  scope.runtime = { store, titles, agentsSource, bus, health, events, modulesView, agentsView, routeAll, tick };

  scope.route("GET", "/", (req, res) => scope.core.sendHtml(res, 200, stewardPanelHtml({ embed: true })));
  scope.route("GET", "/index.html", (req, res) => scope.core.sendHtml(res, 200, stewardPanelHtml({ embed: true })));
  scope.route("GET", "/api/state", (req, res) => {
    const snap = store.snapshot();
    scope.core.sendJson(res, 200, {
      ok: true,
      at: Date.now(),
      health: health.last,
      agents: agentsView(),
      modules: modulesView(),
      signals: snap.signals,
      actions: snap.actions,
      counters: snap.counters,
      journal: snap.journal,
      titles: { size: titles.size(), error: titles.error() },
      control: { autoAct: scope.settings.get("autoAct") === true, pins: pins(), modules: modules().length }
    });
  });
  scope.route("GET", "/api/agents", (req, res) => scope.core.sendJson(res, 200, { ok: true, agents: agentsView() }));
  scope.route("GET", "/api/modules", (req, res) => scope.core.sendJson(res, 200, { ok: true, modules: modulesView() }));
  scope.route("GET", "/api/signals", (req, res) => {
    const limit = scope.core.intOf(scope.core.queryOf(req).get("limit"), 50, 1, 400);
    scope.core.sendJson(res, 200, { ok: true, signals: store.snapshot().signals.slice(0, limit) });
  });
  scope.route("GET", "/api/health", (req, res) => scope.core.sendJson(res, 200, { ok: true, health: health.last, history: health.history.slice(-120) }));
  scope.route("GET", "/api/tick", (req, res) => {
    const snap = store.snapshot();
    scope.core.sendJson(res, 200, {
      ok: true,
      at: Date.now(),
      rev: [snap.agents.length, snap.signals.length, snap.counters.events, snap.journal.seq, health.last === undefined ? 0 : health.last.heapUsedMB, scope.settings.get("autoAct") === true ? 1 : 0]
    });
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
  scope.route("POST", "/api/action", async (req, res) => {
    const parsed = await scope.core.readBody(req);
    if (!parsed.ok) { scope.core.sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    const body = parsed.value !== null && typeof parsed.value === "object" ? parsed.value : {};
    const actionId = body.id === undefined ? "" : String(body.id);
    if (actionId === "collect") {
      agentsSource.sync();
      await agentsSource.refreshTitles();
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
    scope.core.sendJson(res, 404, { ok: false, error: "unknown action " + actionId });
  });
  scope.route("*", (req, res, sub) => { scope.core.sendJson(res, 404, { ok: false, error: "no such route", path: sub }); });

  scope.tool({
    name: "steward_observe",
    description: "Read-only snapshot of every agent the DSH host is running: agent id, session title, module bucket, status, silence duration, turns, pending user question, and the latest attention signals. Use it to see what the steward currently knows about the fleet.",
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: true, properties: { text: { type: "string" } } },
      render: (value) => ({ type: "text", text: value !== null && typeof value === "object" && typeof value.text === "string" ? value.text : String(value) })
    },
    execute: async () => {
      agentsSource.sync();
      routeAll();
      const rows = agentsView().slice().sort((a, b) => b.lastEventAt - a.lastEventAt).slice(0, 20);
      const lines = ["steward observe  agents " + store.agents.size + "  modules " + modulesView().length + "  signals " + store.snapshot().signals.length];
      for (const row of rows) {
        const name = row.title === undefined ? "session " + String(row.sessionId === undefined ? row.id : row.sessionId).slice(0, 8) : row.title;
        lines.push("  [" + row.moduleId + "] " + name + "  " + row.status + (row.stalled === true ? " (stalled)" : "") + (row.attention === true ? " (attention:" + String(row.attentionReason) + ")" : "") + "  silence " + Math.round((Date.now() - row.lastEventAt) / 1000) + "s");
      }
      return { text: lines.join("\n") };
    }
  });
}

export async function action(scope, actionId, body) {
  const rt = scope.runtime;
  if (rt === undefined) return { ok: false, reason: "feature not started" };
  if (actionId === "collect") {
    rt.agentsSource.sync();
    await rt.agentsSource.refreshTitles();
    rt.routeAll();
    rt.health.sample();
    rt.events.lastCollect = Date.now();
    return { ok: true, agents: rt.store.agents.size };
  }
  if (actionId === "flush") { rt.store.flush(); return { ok: true, journal: rt.store.snapshot().journal }; }
  return { ok: false, reason: "unknown action " + String(actionId) };
}

export function status(scope) {
  const rt = scope.runtime;
  if (rt === undefined) return { level: "ok", headline: "未启动", lines: [] };
  const agentsRows = Array.from(rt.store.agents.values());
  const running = agentsRows.filter((rec) => rec.status === "running").length;
  const attention = agentsRows.filter((rec) => rec.attention === true || rec.stalled === true).length;
  const signals = rt.store.snapshot().signals;
  const errors = signals.filter((sig) => sig.severity === "error").length;
  const health = rt.health.last;
  const level = errors > 0 ? "high" : (attention > 0 ? "warn" : "ok");
  const headline = "观察 " + agentsRows.length + " 个 agent（运行 " + running + "），待决 " + attention + "，信号 " + signals.length + (health === undefined ? "" : "，堆 " + health.heapUsedMB + " MB");
  return {
    level,
    headline,
    lines: [
      "modules: " + rt.modulesView().map((m) => m.id + " " + m.count).join(", "),
      "journal: " + rt.store.snapshot().journal.file,
      "loop p99: " + (health === undefined ? "-" : health.loop.p99Ms + " ms")
    ]
  };
}

export default { id, title, subtitle, order, Config, settings, actions, normalize, setup, action, status };

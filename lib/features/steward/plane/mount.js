/**
 * 能力平面的装配（能力平面 §5）：把 trace / 能力仓 / 载体 / 管线 / 编制 组装起来。
 *
 * index.js 只调用 createPlane(scope, S)，然后：dispatch 交给 brain 按事件跑，
 * describe/trace/catalog 交给 http 与面板。所有"薄适配"都在这里收口 ——
 * 缺宿主服务时返回 carrier-unavailable，管线记一条失败的 effect，而不是打挂 tick。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTraceStore } from "../../../core/trace.js";
import { buildRollup, renderRollup } from "../session/rollup.js";
import { createCatalog } from "./catalog.js";
import { createCarriers } from "./carriers.js";
import { createPipeline } from "./pipeline.js";
import { builtinInstances } from "./instances.js";
import { builtinStewards, normalizeStewards } from "./preset.js";
import { grantFor } from "./grants.js";

const TRACE_PRUNE = { keepDays: 30, maxRows: 5000 };

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function str(v, fallback) { return v === undefined || v === null ? fallback : String(v); }
function msgOf(error) { return String(error !== null && error !== undefined && error.message !== undefined ? error.message : error); }

export function createPlane(scope, S) {
  const services = S === undefined || S === null ? {} : S;
  const log = typeof services.log === "function" ? services.log : function () {};
  const readSettings = typeof services.readSettings === "function" ? services.readSettings : function () { return {}; };
  const db = services.db;
  const store = services.store;
  const health = services.health;
  const views = services.views === undefined || services.views === null ? {} : services.views;
  const approvals = services.approvals;
  const notifier = services.notifier;
  const prompter = services.prompter;
  const slimNow = typeof services.slimNow === "function" ? services.slimNow : undefined;
  const policyLevel = typeof services.policyLevel === "function" ? services.policyLevel : function () { return "L2"; };
  const counters = { dispatched: 0, calls: 0, previews: 0, failed: 0 };

  function safeRead(fn, fallback) {
    try { return fn(readSettings()); } catch { return fallback; }
  }

  function planeSettings() {
    const raw = safeRead(function (s) { return s; }, {});
    const p = raw !== undefined && raw !== null && raw.plane !== undefined && raw.plane !== null && typeof raw.plane === "object" ? raw.plane : {};
    return p;
  }

  const trace = createTraceStore({ db: db, log: log, clock: Date.now });
  const catalog = createCatalog({ log: log });
  let installed = { at: 0, count: 0, errors: [] };

  function installInstances() {
    const extra = planeSettings().instances;
    const list = builtinInstances().concat(Array.isArray(extra) ? extra : []);
    installed = { at: Date.now(), count: 0, errors: [] };
    catalog.clear();
    for (const spec of list) {
      try {
        catalog.define(spec);
        installed.count += 1;
      } catch (error) {
        const prefix = spec !== null && spec !== undefined && spec.id !== undefined ? String(spec.id) + ": " : "";
        installed.errors.push(prefix + msgOf(error));
      }
    }
    if (installed.errors.length > 0) log("warn", "plane: " + String(installed.errors.length) + " capability instance(s) rejected: " + installed.errors.slice(0, 3).join(" | "));
    return installed;
  }
  installInstances();

  function pruneTraces() {
    try { return trace.prune(TRACE_PRUNE); } catch (error) { log("warn", "plane: trace prune failed: " + msgOf(error)); return { removed: 0 }; }
  }
  pruneTraces();

  function minutesSince(iso) {
    const at = typeof iso === "number" ? iso : Date.parse(String(iso));
    if (!Number.isFinite(at)) return 99999;
    return Math.max(0, Math.round((Date.now() - at) / 60000));
  }

  function freeDiskMB() {
    try {
      const st = fs.statfsSync(os.homedir());
      return Math.round((num(st.bavail) * num(st.bsize)) / (1024 * 1024));
    } catch { return 999999; }
  }

  /** 判定用的宿主事实（键名与 judge.* 的规则一致）。 */
  function hostFacts(extra) {
    const h = health !== undefined && health.last !== undefined && health.last !== null ? health.last : {};
    const heapUsedMB = num(h.heapUsedMB);
    const heapLimitMB = num(h.heapLimitMB);
    const pct = heapLimitMB > 0 ? Math.round((heapUsedMB * 100 / heapLimitMB) * 10) / 10 : 0;
    const crash = h.crash !== undefined && h.crash !== null ? h.crash : {};
    const disk = freeDiskMB();
    const budget = typeof views.budgetView === "function" ? views.budgetView(Date.now()) : { used: 0, max: 0, pct: 0 };
    return Object.assign({
      host: "host", subject: "host", at: Date.now(),
      heapPct: pct, pct: pct, heapUsedMB: heapUsedMB, usedMB: heapUsedMB, limitMB: heapLimitMB,
      heapTotalMB: num(h.heapTotalMB), rssMB: num(h.rssMB),
      loopP99Ms: h.loop !== undefined && h.loop !== null ? num(h.loop.p99Ms) : 0,
      loopMaxMs: h.loop !== undefined && h.loop !== null ? num(h.loop.maxMs) : 0,
      crashLast24h: num(crash.last24h),
      crashNewestAgeMin: crash.newest === undefined || crash.newest === null ? 99999 : minutesSince(crash.newest),
      freeDiskMB: disk, diskFreeMB: disk,
      budgetUsed: num(budget.used), budgetUsedPct: num(budget.pct), budgetMax: num(budget.max),
      minuteOfHour: new Date().getMinutes(),
      autoAct: safeRead(function (s) { return s.autoAct === true; }, false),
      actLevel: str(policyLevel(), "L2")
    }, extra === undefined || extra === null ? {} : extra);
  }

  function hostService(name) {
    try { return scope.ctx.get(name); } catch { return undefined; }
  }

  async function desktopBridge(instance, params) {
    if (notifier === undefined) return { ok: false, error: "carrier-unavailable:desktop" };
    const res = await notifier.send({
      title: str(params.title, "Polaris 通知"),
      text: str(params.text, ""),
      level: str(params.level, "warning"),
      subject: str(params.subject, "")
    });
    const ok = res !== undefined && res !== null && res.ok !== false;
    return { ok: ok, extId: "desktop:" + String(Date.now()), data: res, error: ok ? "" : str(res !== undefined && res !== null ? res.reason : "notify-failed", "notify-failed") };
  }

  async function sessionBridge(instance, params) {
    const sid = str(params.sessionId, "");
    if (instance.id === "cancel.session") {
      const ctrl = hostService("sessionController");
      if (ctrl === undefined) return { ok: false, error: "carrier-unavailable:sessionController" };
      await ctrl.cancel({ sessionId: sid });
      return { ok: true, extId: "cancel:" + sid };
    }
    if (prompter === undefined) return { ok: false, error: "carrier-unavailable:session" };
    const res = await prompter.prompt(scope.ctx, {
      sessionId: sid,
      content: [{ type: "text", text: str(params.text, "") }],
      mode: str(params.mode, "followup") === "steer" ? "steer" : "followup",
      requestId: str(params.requestId, "")
    });
    const ok = res !== undefined && res !== null && res.ok !== false;
    return { ok: ok, extId: ok ? str(res.requestId, "") : "", data: res, error: ok ? "" : str(res !== undefined && res !== null ? res.reason : "prompt-failed", "prompt-failed") };
  }

  /** tool 载体的动词表（能力平面 §11）：宿主侧的真实动作都从这里进。 */
  async function toolBridge(instance, params) {
    const name = str(params.name, "");
    if (name === "approval.create") {
      if (approvals === undefined) return { ok: false, error: "carrier-unavailable:approvals" };
      const row = approvals.create({
        title: str(params.title, "请示"), detail: str(params.detail, ""), subject: str(params.subject, ""),
        moduleId: str(params.moduleId, ""), level: str(params.level, "warning"),
        ttlMs: num(params.ttlMs) > 0 ? num(params.ttlMs) : 1800000
      });
      return { ok: true, extId: "approval:" + String(row.id), data: row };
    }
    if (name === "approval.get") {
      if (approvals === undefined) return { ok: false, error: "carrier-unavailable:approvals" };
      return { ok: true, data: approvals.get(params.id) };
    }
    if (name === "heap.slim") {
      if (slimNow === undefined) return { ok: false, error: "carrier-unavailable:heap-guard" };
      const res = await slimNow(num(params.level) > 0 ? num(params.level) : 3);
      const ok = res === undefined || res === null || res.ok !== false;
      return { ok: ok, extId: "", data: res, error: ok ? "" : str(res !== undefined && res !== null ? res.reason : "slim-failed", "slim-failed") };
    }
    if (name === "digest.send") {
      if (notifier === undefined) return { ok: false, error: "carrier-unavailable:notifier" };
      const rollup = buildRollup({
        agents: typeof views.agentsView === "function" ? views.agentsView() : [],
        runs: typeof views.runsView === "function" ? views.runsView(10) : [],
        signals: store !== undefined ? store.snapshot().signals.slice(0, 20) : [],
        approvals: typeof views.approvalsView === "function" ? views.approvalsView() : [],
        health: health !== undefined ? health.last : undefined,
        budget: typeof views.budgetView === "function" ? views.budgetView(Date.now()) : undefined,
        now: Date.now()
      });
      const text = renderRollup(rollup);
      const sent = await notifier.send({ title: "Polaris 汇报", text: text, level: "info", subject: "digest" });
      const ok = sent !== undefined && sent !== null && sent.ok !== false;
      return { ok: ok, extId: "digest:" + String(Date.now()), data: { text: text, sent: sent } };
    }
    if (name === "collect.sample") {
      if (health === undefined || typeof health.sample !== "function") return { ok: false, error: "carrier-unavailable:health" };
      const sample = await health.sample();
      return { ok: true, data: sample === undefined ? health.last : sample };
    }
    if (name === "rules.reload") {
      const info = installInstances();
      return { ok: info.errors.length === 0, extId: "plane:" + String(info.count), data: info, error: info.errors.length === 0 ? "" : "invalid-capabilities" };
    }
    return { ok: false, error: "unknown-tool-verb:" + name };
  }

  const carriers = createCarriers({
    dir: path.join(scope.dir, "plane"),
    log: log,
    desktop: desktopBridge,
    session: sessionBridge,
    tool: toolBridge
  });

  const pipeline = createPipeline({
    catalog: catalog,
    carriers: carriers,
    trace: trace,
    log: log,
    clock: Date.now,
    grants: function (stewardId, spec) { return grantFor(spec, policyLevel(), undefined); },
    live: function () { return safeRead(function (s) { return s.actMode === "live"; }, false); },
    budget: {
      allow: function () {
        const b = typeof views.budgetView === "function" ? views.budgetView(Date.now()) : { pct: 0 };
        return num(b.pct) < 100;
      },
      charge: function (stewardId, cap) {
        if (store !== undefined && typeof store.pushAction === "function") store.pushAction({ kind: "act", agentId: undefined, ok: true, message: cap });
      }
    }
  });

  /** 编制表：settings.plane.stewards 里同 id 的条目覆盖预置，未知 id 追加。 */
  let stewardCache = { at: 0, list: undefined, sig: "" };
  function stewards() {
    const raw = planeSettings().stewards;
    const sig = JSON.stringify(raw === undefined || raw === null ? null : raw);
    if (stewardCache.list !== undefined && stewardCache.sig === sig && Date.now() - stewardCache.at < 1000) return stewardCache.list;
    const base = builtinStewards();
    let list = base;
    if (Array.isArray(raw) && raw.length > 0) {
      const merged = base.map(function (s) {
        const o = raw.filter(function (r) { return r !== null && typeof r === "object" && String(r.id) === s.id; })[0];
        return o === undefined ? s : Object.assign({}, s, o);
      });
      for (const r of raw) {
        if (r === null || typeof r !== "object") continue;
        if (base.every(function (s) { return s.id !== r.id; })) merged.push(r);
      }
      list = merged;
    }
    const norm = normalizeStewards(list);
    if (norm.errors.length > 0) log("warn", "plane: " + norm.errors.join(" | "));
    stewardCache = { at: Date.now(), list: norm.list, sig: sig };
    return norm.list;
  }

  /** 一个事件 → 所有启用了该事件的编制（各自一棵树），共用一条 trace。 */
  async function dispatch(event, facts, opts) {
    const o = opts === undefined || opts === null ? {} : opts;
    const subject = str(o.subject, "host");
    const active = stewards().filter(function (s) {
      return s.enabled !== false && (s.events.length === 0 || s.events.indexOf(event) >= 0);
    });
    if (active.length === 0) return { traceId: "", stewards: [], calls: 0, previews: 0, skipped: "no-steward" };
    const t = o.trace === false ? undefined : trace.begin({ trigger: event, steward: "all", subject: subject });
    const results = [];
    let calls = 0;
    let previews = 0;
    for (const s of active) {
      const ctx = {
        event: event,
        facts: facts === undefined || facts === null ? {} : facts,
        vars: Object.assign({ autoAct: safeRead(function (st) { return st.autoAct === true; }, false), actLevel: str(policyLevel(), "L2") }, o.vars),
        stewardId: s.id,
        subject: subject,
        trigger: event,
        scope: s.scope,
        selfSessionId: str(o.selfSessionId, ""),
        humanPresent: o.humanPresent === true
      };
      const res = await pipeline.runPlan(s.tree, ctx, { trace: t === undefined ? false : t });
      const bad = res.calls.filter(function (c) { return c.ok !== true; }).length;
      calls += res.calls.length;
      previews += bad;
      results.push({ steward: s.id, ok: res.ok, status: res.status, calls: res.calls.length, previews: bad, error: res.error });
    }
    if (t !== undefined) t.finish("ok", "");
    counters.dispatched += 1;
    counters.calls += calls;
    counters.previews += previews;
    return { traceId: t === undefined ? "" : t.id, stewards: results, calls: calls, previews: previews };
  }

  function describePlane() {
    const d = catalog.describe();
    return {
      installedAt: installed.at,
      count: catalog.size(),
      hash: catalog.hash(),
      errors: installed.errors.slice(0, 20),
      byPayload: d.byPayload,
      byCarrier: d.byCarrier,
      capabilities: catalog.list().map(function (c) {
        return { id: c.id, title: c.title, payload: c.payload, carrier: c.carrier, protocol: c.protocol, targets: c.targets, tags: c.tags, grant: c.grant, limits: c.limits };
      }),
      stewards: stewards().map(function (s) {
        return { id: s.id, name: s.name, enabled: s.enabled !== false, host: s.host, audience: s.audience, note: s.note, equips: s.equips, events: s.events, scope: s.scope };
      })
    };
  }

  function stats() {
    return {
      installed: installed.count,
      installedAt: installed.at,
      errors: installed.errors.length,
      capabilities: catalog.size(),
      hash: catalog.hash(),
      stewards: stewards().length,
      carriers: carriers.names(),
      counters: Object.assign({}, counters),
      pipeline: pipeline.stats(),
      trace: trace.stats()
    };
  }

  function dispose() {
    try { pipeline.reset(); } catch { /* ignore */ }
    try { trace.dispose(); } catch { /* ignore */ }
  }

  return {
    trace: trace,
    catalog: catalog,
    carriers: carriers,
    pipeline: pipeline,
    installInstances: installInstances,
    installed: function () { return installed; },
    stewards: stewards,
    dispatch: dispatch,
    hostFacts: hostFacts,
    describe: describePlane,
    stats: stats,
    pruneTraces: pruneTraces,
    dispose: dispose
  };
}

export default { createPlane };

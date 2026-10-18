/**
 * Steward HTTP 层：路由表 + 工具 + action/status（评审第 8 项拆分的产物）。
 *
 * index.js 只负责装配（把闭包里的能力打包成 S 传进来），这里只负责对外接口：
 * 23 条 scope.route、5 个 scope.tool、以及模块级的 action()/status()。
 * 可变绑定（ruleSet / evaluator / counters）必须走 S 上的 getter，
 * 否则解构会在装载规则前把 undefined 捕获死。
 */
import { applyRouting, DEFAULT_MODULES, normalizeModules } from "./modules.js";
import { stewardPanelHtml } from "./panel.js";
import { buildRollup, renderRollup } from "./session/rollup.js";
import { prometheusText } from "./export.js";
import { builtinStewards, normalizeStewards } from "./plane/preset.js";
import { normalizeRoutes } from "./plane/routes.js";

export function mountHttp(scope, S) {
  const {
    agentsSource, agentsView, approvals, approvalsView, attempt, budgetView,
    classifier, counters, engine, ensureModuleGauges, events, exporter, health,
    modules, modulesView, notifier, peer, pins, readSettings, routeAll,
    runsView, stewardSnapshot, store, titles,
    chat, detail, eventReader, policy, tasks,
  } = S;
  // 能力平面（P0-c）：/api/rules 现在是能力仓的视图，rules 引擎已废弃。
  const plane = S.plane;
  const planeInfo = () => (plane === undefined
    ? { hash: "unavailable", count: 0, capabilities: [], stewards: [], errors: [], installedAt: 0 }
    : plane.describe());
  const reloadCapabilities = () => (S.reloadCapabilities === undefined
    ? { count: 0, errors: ["plane-unavailable"], hash: "unavailable" }
    : S.reloadCapabilities());
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
      rules: { count: planeInfo().capabilities.length, hash: planeInfo().hash, installedAt: planeInfo().installedAt, errors: planeInfo().errors, stewards: planeInfo().stewards.length },
      plane: plane === undefined ? null : { ...planeInfo(), trace: plane.trace.stats(), counters: plane.stats().counters, carriers: plane.stats().carriers },
      federation: peer === undefined ? null : { hostId: peer.hostId, peers: peer.peers(), pending: peer.pending(), seen: peer.seenCount() },
      degraded: events.degraded.slice(-8),
      echoes: snap.actions.filter((a) => a.kind === "echo").slice(0, 20),
      moduleDefs: modules(),
      control: {
        autoAct: cfg.autoAct === true,
        actMode: cfg.actMode,
        classifier: classifier === undefined ? null : classifier.stats(),
        export: exporter === undefined ? null : exporter.stats(),
        classifyStarted: counters.classifyStarted,
        actuator: cfg.actions,
        notify: cfg.notify,
        session: cfg.session,
        federation: { hostId: cfg.federation.hostId, secret: cfg.federation.secret === "" ? "" : "set", peerUrl: cfg.federation.peerUrl },
        pins: cfg.pins,
        modules: modules().length,
        engine: engine !== undefined,
        approvals: approvals !== undefined,
        peer: peer !== undefined,
        chat: chat === undefined ? null : chat.state(),
        policy: policy === undefined ? null : policy.describe(),
        tasks: tasks === undefined ? null : tasks.summary()
      }
    });
  });
  scope.route("GET", "/api/agents", (req, res) => scope.core.sendJson(res, 200, { ok: true, agents: agentsView() }));
  scope.route("GET", "/api/modules", (req, res) => scope.core.sendJson(res, 200, { ok: true, modules: modulesView(), defs: modules(), pins: pins() }));
  /**
   * 模块增删改（用户要求：模块要能自己维护，判断错了要能改）。
   *   {op:"save", module:{id,name,titles,workspaces,enabled,host}}  新增或整体覆盖（id 不可改名）
   *   {op:"delete", id:"cb2"}                                      删除模块，并把指向它的 pin 清掉
   *   {op:"reset"}                                                 恢复内置默认模块
   * 落库位置仍是 settings.modules（v1 信封），改完立刻重算全部 agent 归属。
   */
  scope.route("POST", "/api/modules", async (req, res) => {
    const parsed = await scope.core.readBody(req);
    if (!parsed.ok) { scope.core.sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    const body = parsed.value !== null && typeof parsed.value === "object" ? parsed.value : {};
    const op = String(body.op === undefined ? "save" : body.op);
    const listOf = (value) => {
      if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter((x) => x.length > 0);
      if (typeof value === "string") return value.split(/[,\n]/).map((x) => x.trim()).filter((x) => x.length > 0);
      return [];
    };
    const current = modules().map((m) => Object.assign({}, m, { titles: m.titles.slice(), workspaces: m.workspaces.slice() }));
    let next = current;
    if (op === "reset") {
      next = normalizeModules(DEFAULT_MODULES);
    } else if (op === "delete") {
      const id = body.id === undefined ? "" : String(body.id);
      if (id === "") { scope.core.sendJson(res, 400, { ok: false, error: "id required" }); return; }
      if (id === "unassigned") { scope.core.sendJson(res, 400, { ok: false, error: "unassigned is reserved" }); return; }
      if (!current.some((m) => m.id === id)) { scope.core.sendJson(res, 404, { ok: false, error: "no such module: " + id }); return; }
      next = current.filter((m) => m.id !== id);
    } else {
      const raw = body.module !== null && typeof body.module === "object" ? body.module : body;
      const id = raw.id === undefined ? "" : String(raw.id).trim();
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) {
        scope.core.sendJson(res, 400, { ok: false, error: "id must match /^[a-zA-Z0-9_-]{1,32}$/" });
        return;
      }
      const entry = {
        id,
        name: typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : id,
        host: typeof raw.host === "string" && raw.host.trim() !== "" ? raw.host.trim() : "win-main",
        enabled: raw.enabled !== false,
        titles: listOf(raw.titles),
        workspaces: listOf(raw.workspaces),
      };
      const at = current.findIndex((m) => m.id === id);
      next = at >= 0 ? current.map((m, i) => (i === at ? entry : m)) : current.concat([entry]);
    }
    const nextPins = Object.assign({}, pins());
    const alive = new Set(next.map((m) => m.id));
    let dropped = 0;
    for (const key of Object.keys(nextPins)) if (!alive.has(nextPins[key])) { delete nextPins[key]; dropped += 1; }
    const saved = scope.settings.set({ modules: next, pins: nextPins });
    routeAll();
    store.pushAction({ kind: "modules", ok: true, message: op + (op === "save" ? " " + String(body.module !== null && typeof body.module === "object" ? body.module.id : body.id || "") : "") + " · " + next.length + " 个模块" });
    if (ensureModuleGauges !== undefined) { try { ensureModuleGauges(next); } catch { /* gauge 只影响指标 */ } }
    scope.core.sendJson(res, 200, { ok: true, op, modules: modulesView(), defs: modules(), pins: nextPins, droppedPins: dropped, settings: saved === undefined ? undefined : true });
  });
  scope.route("GET", "/api/signals", (req, res) => {
    const limit = scope.core.intOf(scope.core.queryOf(req).get("limit"), 50, 1, 400);
    scope.core.sendJson(res, 200, { ok: true, signals: store.snapshot().signals.slice(0, limit) });
  });
  scope.route("GET", "/api/health", (req, res) => scope.core.sendJson(res, 200, { ok: true, health: health.last, history: health.history.slice(-120) }));
  // 增量 journal：面板带上次的 seq 来，只拿新增条目（评审 P2-12）。
  scope.route("GET", "/api/journal", (req, res) => {
    const q = scope.core.queryOf(req);
    const since = scope.core.intOf(q.get("since"), 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = scope.core.intOf(q.get("limit"), 100, 1, 500);
    const page = store.since(since, limit);
    ensureModuleGauges();
    scope.core.sendJson(res, 200, { ok: true, since, latest: page.latest, truncated: page.truncated, entries: page.entries });
  });
  scope.route("GET", "/api/runs", (req, res) => {
    const limit = scope.core.intOf(scope.core.queryOf(req).get("limit"), 20, 1, 100);
    scope.core.sendJson(res, 200, { ok: true, runs: runsView(limit), engine: engine !== undefined });
  });
  scope.route("GET", "/api/approvals", (req, res) => scope.core.sendJson(res, 200, { ok: true, approvals: approvalsView() }));
  scope.route("GET", "/api/rules", (req, res) => {
    const info = planeInfo();
    scope.core.sendJson(res, 200, {
      ok: true, hash: info.hash, count: info.capabilities.length,
      installedAt: info.installedAt, errors: info.errors,
      capabilities: info.capabilities,
      rules: info.capabilities.filter((c) => c.payload === "verdict").map((c) => ({ id: c.id, title: c.title, carrier: c.carrier, targets: c.targets, enabled: true })),
      stewards: info.stewards,
      stats: plane === undefined ? null : plane.stats()
    });
  });
  scope.route("POST", "/api/rules/reload", (req, res) => {
    const loaded = attempt("rules.reload", () => reloadCapabilities(), { count: 0, errors: ["failed"], hash: "unavailable" });
    scope.core.sendJson(res, 200, { ok: true, hash: loaded.hash, count: loaded.count, errors: loaded.errors, degraded: events.degraded.slice(-4) });
  });
  scope.route("GET", "/api/trace", (req, res) => {
    if (plane === undefined) { scope.core.sendJson(res, 200, { ok: true, traces: [], stats: null }); return; }
    const q = scope.core.queryOf(req);
    const limit = scope.core.intOf(q.get("limit"), 50, 1, 500);
    const id = q.get("id");
    if (id !== undefined && id !== null && String(id) !== "") {
      const one = plane.trace.get(String(id));
      if (one === undefined) { scope.core.sendJson(res, 404, { ok: false, reason: "no such trace" }); return; }
      scope.core.sendJson(res, 200, { ok: true, trace: one, waterfall: plane.trace.waterfall(String(id)) });
      return;
    }
    const since = Number(q.get("since"));
    const query = { limit };
    if (Number.isFinite(since) && since > 0) query.since = since;
    const stewardId = q.get("steward");
    if (stewardId !== undefined && stewardId !== null && String(stewardId) !== "") query.stewardId = String(stewardId);
    const trigger = q.get("trigger");
    if (trigger !== undefined && trigger !== null && String(trigger) !== "") query.trigger = String(trigger);
    const list = plane.trace.history(query);
    scope.core.sendJson(res, 200, { ok: true, traces: list, latest: list.length > 0 ? list[0].id : "", stats: plane.trace.stats() });
  });
  // ---------- P1：编制 / 路由 / 体检 / 追查增强 ----------
  scope.route("GET", "/api/stewards", (req, res) => {
    const info = planeInfo();
    const raw = readSettings().plane !== undefined && readSettings().plane !== null ? readSettings().plane : {};
    const overrides = Array.isArray(raw.stewards) ? raw.stewards : [];
    scope.core.sendJson(res, 200, {
      ok: true,
      stewards: info.stewards,
      routes: plane === undefined ? null : plane.routes(),
      errors: info.errors,
      overrideIds: overrides.filter((s) => s !== null && typeof s === "object" && s.id !== undefined).map((s) => String(s.id)),
      builtin: builtinStewards().map((s) => ({ id: s.id, name: s.name, enabled: s.enabled !== false }))
    });
  });
  scope.route("POST", "/api/stewards", async (req, res) => {
    if (plane === undefined) { scope.core.sendJson(res, 503, { ok: false, reason: "plane-unavailable" }); return; }
    const parsed = await scope.core.readBody(req);
    if (!parsed.ok) { scope.core.sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    const body = parsed.value !== null && typeof parsed.value === "object" ? parsed.value : {};
    const raw = readSettings().plane !== undefined && readSettings().plane !== null ? readSettings().plane : {};
    const current = (Array.isArray(raw.stewards) ? raw.stewards : []).filter((s) => s !== null && typeof s === "object");
    const op = body.op === undefined || body.op === null ? "save" : String(body.op);
    const base = builtinStewards();
    const builtinOf = (id) => base.filter((s) => s.id === id)[0];
    const persist = (next) => { scope.settings.set({ plane: Object.assign({}, raw, { stewards: next }) }); };
    if (op === "reset") {
      persist([]);
      scope.core.sendJson(res, 200, { ok: true, stewards: plane.describe().stewards });
      return;
    }
    const id = body.id === undefined ? "" : String(body.id).trim();
    if (id === "") { scope.core.sendJson(res, 400, { ok: false, error: "id required" }); return; }
    if (op === "delete") {
      const kept = current.filter((s) => String(s.id) !== id);
      if (kept.length === current.length) {
        if (builtinOf(id) === undefined) { scope.core.sendJson(res, 404, { ok: false, error: "no such steward " + id }); return; }
        scope.core.sendJson(res, 200, { ok: true, reverted: true, stewards: plane.describe().stewards });
        return;
      }
      persist(kept);
      store.pushAction({ kind: "settings", ok: true, message: "steward " + id + " delete" });
      scope.core.sendJson(res, 200, { ok: true, stewards: plane.describe().stewards });
      return;
    }
    if (op !== "save" && op !== "enable" && op !== "add") { scope.core.sendJson(res, 400, { ok: false, error: "unknown op " + op }); return; }
    const prev = current.filter((s) => String(s.id) === id)[0];
    const fallback = builtinOf(id) !== undefined ? builtinOf(id) : (prev !== undefined ? prev : {});
    const rec = body.steward !== null && typeof body.steward === "object" ? body.steward : body;
    const patch = op === "enable" ? { enabled: body.enabled !== false } : rec;
    const candidate = Object.assign({}, fallback, patch, { id });
    delete candidate.op;
    const norm = normalizeStewards([candidate]);
    if (norm.errors.length > 0) { scope.core.sendJson(res, 400, { ok: false, error: norm.errors.join("; "), feature: "steward" }); return; }
    const next = current.filter((s) => String(s.id) !== id).concat([candidate]);
    persist(next);
    store.pushAction({ kind: "settings", ok: true, message: "steward " + id + " " + op });
    scope.core.sendJson(res, 200, { ok: true, steward: candidate, stewards: plane.describe().stewards });
  });
  scope.route("GET", "/api/routes", (req, res) => {
    if (plane === undefined) { scope.core.sendJson(res, 200, { ok: true, routes: null, reason: "plane-unavailable" }); return; }
    scope.core.sendJson(res, 200, { ok: true, routes: plane.routes(), actLevel: readSettings().actLevel });
  });
  scope.route("POST", "/api/routes", async (req, res) => {
    if (plane === undefined) { scope.core.sendJson(res, 503, { ok: false, reason: "plane-unavailable" }); return; }
    const parsed = await scope.core.readBody(req);
    if (!parsed.ok) { scope.core.sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    const body = parsed.value !== null && typeof parsed.value === "object" ? parsed.value : {};
    const raw = readSettings().plane !== undefined && readSettings().plane !== null ? readSettings().plane : {};
    const cur = raw.routes !== null && typeof raw.routes === "object" ? raw.routes : {};
    const incoming = body.routes !== null && typeof body.routes === "object" ? body.routes : body;
    const norm = normalizeRoutes(Object.assign({}, cur, incoming));
    if (norm.errors.length > 0) { scope.core.sendJson(res, 400, { ok: false, error: norm.errors.join("; "), feature: "steward" }); return; }
    scope.settings.set({ plane: Object.assign({}, raw, { routes: { default: norm.default, rules: norm.rules } }) });
    store.pushAction({ kind: "settings", ok: true, message: "routes " + String(norm.rules.length) + " rules" });
    scope.core.sendJson(res, 200, { ok: true, routes: plane.routes() });
  });
  scope.route("GET", "/api/doctor", (req, res) => {
    if (plane === undefined) { scope.core.sendJson(res, 200, { ok: true, healthy: true, checks: [], reason: "plane-unavailable" }); return; }
    scope.core.sendJson(res, 200, plane.doctor());
  });
  scope.route("POST", "/api/trace/replay", async (req, res) => {
    if (plane === undefined) { scope.core.sendJson(res, 503, { ok: false, reason: "plane-unavailable" }); return; }
    const parsed = await scope.core.readBody(req);
    if (!parsed.ok) { scope.core.sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    const body = parsed.value !== null && typeof parsed.value === "object" ? parsed.value : {};
    let out;
    try { out = await plane.replayTrace(String(body.id === undefined ? "" : body.id)); }
    catch (error) { out = { ok: false, error: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error) }; }
    scope.core.sendJson(res, out.ok === true ? 200 : 404, out);
  });
  scope.route("GET", "/api/trace/export", (req, res) => {
    if (plane === undefined) { scope.core.sendText(res, 404, "text/plain; charset=utf-8", "plane unavailable\n"); return; }
    const id = scope.core.queryOf(req).get("id") === null ? "" : String(scope.core.queryOf(req).get("id"));
    const out = id === "" ? undefined : plane.exportTrace(id);
    if (out === undefined) { scope.core.sendText(res, 404, "text/plain; charset=utf-8", "no such trace\n"); return; }
    scope.core.sendText(res, 200, "application/x-ndjson; charset=utf-8", out.text);
  });
  scope.route("GET", "/api/trace/diff", (req, res) => {
    if (plane === undefined) { scope.core.sendJson(res, 200, { ok: true, diff: null, reason: "plane-unavailable" }); return; }
    const q = scope.core.queryOf(req);
    const id = q.get("id") === null ? "" : String(q.get("id"));
    const against = q.get("against") === null ? "" : String(q.get("against"));
    const out = id === "" || against === "" ? undefined : plane.diffTraces(id, against);
    if (out === undefined) { scope.core.sendJson(res, 404, { ok: false, reason: "no such trace" }); return; }
    scope.core.sendJson(res, 200, out);
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
    counters.classifyStarted += 1;
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
    const allow = ["autoAct", "actMode", "actLevel", "actions", "notify", "session", "federation", "budgetPerHour", "modules", "pins", "classifier", "export", "escalation", "tasks", "plane"];
    const filtered = {};
    for (const key of allow) if (patch[key] !== undefined) filtered[key] = patch[key];
    if (filtered.actions !== undefined && filtered.actions !== null) filtered.actions = Object.assign({}, readSettings().actions, filtered.actions);
    if (filtered.notify !== undefined && filtered.notify !== null) filtered.notify = Object.assign({}, readSettings().notify, filtered.notify);
    if (filtered.session !== undefined && filtered.session !== null) filtered.session = Object.assign({}, readSettings().session, filtered.session);
    if (filtered.federation !== undefined && filtered.federation !== null) filtered.federation = Object.assign({}, readSettings().federation, filtered.federation);
    if (filtered.classifier !== undefined && filtered.classifier !== null) filtered.classifier = Object.assign({}, readSettings().classifier, filtered.classifier);
    if (filtered.escalation !== undefined && filtered.escalation !== null) filtered.escalation = Object.assign({}, readSettings().escalation, filtered.escalation);
    if (filtered.tasks !== undefined && filtered.tasks !== null) filtered.tasks = Object.assign({}, readSettings().tasks, filtered.tasks);
    if (filtered.export !== undefined && filtered.export !== null) {
      const exp = Object.assign({}, readSettings().export, filtered.export);
      exp.otlp = Object.assign({}, readSettings().export.otlp, filtered.export.otlp !== null && typeof filtered.export.otlp === "object" ? filtered.export.otlp : {});
      filtered.export = exp;
    }
    let next;
    try {
      next = Object.keys(filtered).length === 0 ? readSettings() : scope.settings.set(filtered);
    } catch (error) {
      // schema 校验失败：400 且不落盘（与工具包级 /api/settings 的契约一致）。
      const code = error !== null && error !== undefined && error.code !== undefined ? String(error.code) : "invalid-settings";
      scope.core.sendJson(res, 400, { ok: false, error: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error), code, feature: "steward" });
      return;
    }
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
      const loaded = reloadCapabilities();
      scope.core.sendJson(res, 200, { ok: loaded.errors.length === 0, count: loaded.count, errors: loaded.errors });
      return;
    }
    scope.core.sendJson(res, 404, { ok: false, error: "unknown action " + actionId });
  });
  // ---------- C 指挥台：主管对话 ----------
  scope.route("GET", "/api/chat", async (req, res) => {
    const limit = scope.core.intOf(scope.core.queryOf(req).get("limit"), 60, 1, 200);
    if (chat === undefined) {
      scope.core.sendJson(res, 200, { ok: true, chat: null, transcript: { ok: false, reason: "chat-unavailable", entries: [] } });
      return;
    }
    let transcript;
    try { transcript = await chat.transcript({ limit }); }
    catch (error) { transcript = { ok: false, reason: String(error), entries: [] }; }
    scope.core.sendJson(res, 200, { ok: true, chat: chat.state(), transcript });
  });
  scope.route("POST", "/api/chat", async (req, res) => {
    const parsed = await scope.core.readBody(req);
    if (!parsed.ok) { scope.core.sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    const body = parsed.value !== null && typeof parsed.value === "object" ? parsed.value : {};
    if (chat === undefined) { scope.core.sendJson(res, 503, { ok: false, reason: "chat-unavailable" }); return; }
    const op = body.op === undefined || body.op === null ? "send" : String(body.op);
    try {
      if (op === "send") {
        const out = await chat.send({ text: body.text, mode: body.mode });
        scope.core.sendJson(res, out.ok === true ? 200 : 400, out);
        return;
      }
      if (op === "create") {
        const out = await chat.create({ cwd: body.cwd, bootstrap: body.bootstrap });
        scope.core.sendJson(res, out.ok === true ? 200 : 400, out);
        return;
      }
      if (op === "bind") {
        const out = chat.bind(body.sessionId);
        scope.core.sendJson(res, out.ok === true ? 200 : 400, out);
        return;
      }
      if (op === "unbind") {
        scope.core.sendJson(res, 200, chat.unbind());
        return;
      }
      if (op === "transcript") {
        const limit = Number(body.limit) > 0 ? Math.min(200, Math.floor(Number(body.limit))) : 60;
        scope.core.sendJson(res, 200, await chat.transcript({ limit }));
        return;
      }
      scope.core.sendJson(res, 400, { ok: false, error: "unknown op " + op });
    } catch (error) {
      scope.core.sendJson(res, 500, { ok: false, reason: String(error) });
    }
  });

  // ---------- C 指挥台：交办单 ----------
  scope.route("GET", "/api/tasks", (req, res) => {
    const q = scope.core.queryOf(req);
    const status = q.get("status") === null ? "" : String(q.get("status"));
    const limit = scope.core.intOf(q.get("limit"), 50, 1, 200);
    if (tasks === undefined) { scope.core.sendJson(res, 200, { ok: true, tasks: [], summary: null, reason: "tasks-unavailable" }); return; }
    scope.core.sendJson(res, 200, { ok: true, tasks: tasks.list({ status, limit }), summary: tasks.summary() });
  });
  scope.route("POST", "/api/tasks", async (req, res) => {
    const parsed = await scope.core.readBody(req);
    if (!parsed.ok) { scope.core.sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    const body = parsed.value !== null && typeof parsed.value === "object" ? parsed.value : {};
    if (tasks === undefined) { scope.core.sendJson(res, 503, { ok: false, reason: "tasks-unavailable" }); return; }
    const op = body.op === undefined || body.op === null ? "create" : String(body.op);
    try {
      if (op === "create") {
        const out = tasks.create(body.task !== null && typeof body.task === "object" ? body.task : body);
        scope.core.sendJson(res, out.ok === true ? 200 : 400, out);
        return;
      }
      if (op === "update") {
        const out = tasks.update(body.id, body.patch);
        scope.core.sendJson(res, out.ok === true ? 200 : 400, out);
        return;
      }
      if (op === "dispatch") {
        const out = await tasks.dispatch(body.id, { manual: true });
        scope.core.sendJson(res, out.ok === true ? 200 : 400, out);
        return;
      }
      if (op === "complete") {
        const out = tasks.complete(body.id, { result: body.result });
        scope.core.sendJson(res, out.ok === true ? 200 : 400, out);
        return;
      }
      if (op === "fail") {
        const out = tasks.fail(body.id, { reason: body.reason });
        scope.core.sendJson(res, out.ok === true ? 200 : 400, out);
        return;
      }
      if (op === "cancel") {
        const out = tasks.cancel(body.id);
        scope.core.sendJson(res, out.ok === true ? 200 : 400, out);
        return;
      }
      scope.core.sendJson(res, 400, { ok: false, error: "unknown op " + op });
    } catch (error) {
      scope.core.sendJson(res, 500, { ok: false, reason: String(error) });
    }
  });

  // ---------- C 指挥台：带队视图（单个会话的目标/进度/卡点） ----------
  scope.route("GET", "/api/detail", async (req, res) => {
    const q = scope.core.queryOf(req);
    const sessionId = q.get("session") === null ? "" : String(q.get("session")).trim();
    if (sessionId === "") { scope.core.sendJson(res, 400, { ok: false, error: "session required" }); return; }
    if (detail === undefined) { scope.core.sendJson(res, 200, { ok: false, reason: "detail-unavailable" }); return; }
    try {
      const value = await detail.of(sessionId);
      if (value === undefined) { scope.core.sendJson(res, 200, { ok: false, reason: "no-events", sessionId }); return; }
      scope.core.sendJson(res, 200, { ok: true, detail: value });
    } catch (error) {
      scope.core.sendJson(res, 500, { ok: false, reason: String(error) });
    }
  });

  // ---------- C 指挥台：分级授权 ----------
  scope.route("GET", "/api/policy", (req, res) => {
    scope.core.sendJson(res, 200, {
      ok: true,
      policy: policy === undefined ? null : policy.describe(),
      actMode: readSettings().actMode,
      actLevel: readSettings().actLevel,
      escalation: readSettings().escalation
    });
  });

  scope.route("*", (req, res, sub) => { scope.core.sendJson(res, 404, { ok: false, error: "no such route", path: sub }); });

  // ---------- 工具 ----------
  // render(args, value) 必须返回 content 块数组（DSH defineTool 的约定）。
  // 旧实现返回单个对象，调用侧 content.some(...) 抛 "content.some is not a function"，
  // 导致 steward_* 五个工具在 agent 侧全部不可用（堆工具用的是数组形式，所以没暴露）。
  function textOut() {
    return {
      schema: { type: "object", additionalProperties: true, properties: { text: { type: "string" } } },
      render: (_args, value) => [{ type: "text", text: value !== null && typeof value === "object" && typeof value.text === "string" ? value.text : String(value) }]
    };
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
    description: "Report the steward's own state: installed capability instances and their hash, the stewards (equipped capability sets) and their decision trees, opened/finished runs, pending approvals, hourly action budget, notification channels, federation peers, and any degraded subsystem. Read-only.",
    parameters: {},
    output: textOut(),
    execute: async () => {
      const cfg = readSettings();
      const info = planeInfo();
      const planeStats = plane === undefined ? null : plane.stats();
      const lines = [
        "steward status  capabilities " + info.capabilities.length + "  stewards " + info.stewards.length + "  hash " + String(info.hash) + (info.errors.length === 0 ? "" : "  rejected " + String(info.errors.length)) + (planeStats === null ? "" : "  traced " + String(planeStats.trace.traces) + "  effects " + String(planeStats.trace.effects)),
        "  engine " + (engine !== undefined ? "on" : "off") + "  runs open " + runsView(100).filter((r) => r.status !== "done" && r.status !== "failed").length + "  approvals open " + approvalsView().length,
        "  budget " + budgetView(Date.now()).used + "/" + budgetView(Date.now()).max + " per hour",
        "  notify minSeverity " + cfg.notify.minSeverity + "  lark " + (cfg.notify.larkEnabled === true ? "on" : "off") + "  autoAct " + (cfg.autoAct === true ? "ON" : "off") + "  stallSteer " + (cfg.actions.stallSteer === true ? "ON" : "off") + "  heapSlim " + (cfg.actions.heapSlim === true ? "ON" : "off"),
        "  actMode " + cfg.actMode + (cfg.actMode === "echo" ? " (动作只打印 message，等 ack 再切 live)" : " (真执行)") + "  classifier " + (classifier === undefined ? "off" : (cfg.classifier.enabled === true ? "on" : "off") + " model " + (cfg.classifier.model === "" ? "host-default" : cfg.classifier.model) + " cached " + classifier.stats().cached + " calls " + classifier.stats().calls + " judged " + counters.classifyStarted),
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
    if (rt.plane === undefined) return { ok: false, reason: "plane-unavailable" };
    const info = rt.plane.installInstances();
    return { ok: info.errors.length === 0, count: info.count, errors: info.errors };
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
    const planeStats = rt.plane === undefined ? null : rt.plane.stats();
    const level = errors > 0 ? "high" : (attention > 0 || openApprovals > 0 ? "warn" : "ok");
    const headline = "观察 " + agentsRows.length + " 个 agent（运行 " + running + "），待决 " + attention + "，待批 " + openApprovals + "，运行中流程 " + openRuns + "，信号 " + signals.length + (health === undefined ? "" : "，堆 " + health.heapUsedMB + " MB");
    return {
      level, headline,
      lines: [
        "modules: " + rt.modulesView().map((m) => m.id + " " + m.count).join(", "),
        "journal: " + rt.store.snapshot().journal.file,
        "loop p99: " + (health === undefined ? "-" : health.loop.p99Ms + " ms"),
        "plane: " + (planeStats === null ? "off" : planeStats.capabilities + " capabilities, " + planeStats.stewards + " stewards, " + planeStats.trace.traces + " traces, " + planeStats.pipeline.effects + " effects"),
        "degraded: " + (rt.events.degraded.length === 0 ? "none" : rt.events.degraded.slice(-2).join(" | "))
      ]
    };
  } catch (error) {
    return { level: "ok", headline: "status error: " + String(error), lines: [] };
  }
}

/**
 * Steward HTTP 层：路由表 + 工具 + action/status（评审第 8 项拆分的产物）。
 *
 * index.js 只负责装配（把闭包里的能力打包成 S 传进来），这里只负责对外接口：
 * 23 条 scope.route、5 个 scope.tool、以及模块级的 action()/status()。
 * 可变绑定（ruleSet / evaluator / counters）必须走 S 上的 getter，
 * 否则解构会在装载规则前把 undefined 捕获死。
 */
import { applyRouting } from "./modules.js";
import { stewardPanelHtml } from "./panel.js";
import { buildRollup, renderRollup } from "./session/rollup.js";
import { prometheusText } from "./export.js";

export function mountHttp(scope, S) {
  const {
    agentsSource, agentsView, approvals, approvalsView, attempt, budgetView,
    classifier, counters, engine, ensureModuleGauges, events, exporter, health,
    loadRules, modules, modulesView, notifier, peer, pins, readSettings, routeAll,
    runsView, stewardSnapshot, store, titles,
  } = S;
  const getRuleSet = () => S.getRuleSet();
  const getEvaluator = () => S.getEvaluator();
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
      rules: { count: (getRuleSet().rules || []).length, hash: getRuleSet().hash, stats: getEvaluator() === undefined ? null : getEvaluator().stats() },
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
  scope.route("GET", "/api/rules", (req, res) => scope.core.sendJson(res, 200, {
    ok: true, hash: getRuleSet().hash, count: (getRuleSet().rules || []).length,
    rules: (getRuleSet().rules || []).map((r) => ({ id: r.id, title: r.title, severity: r.severity, when: r.when, enabled: r.enabled !== false && r.enabledByDefault !== false })),
    stats: getEvaluator() === undefined ? null : getEvaluator().stats()
  }));
  scope.route("POST", "/api/rules/reload", (req, res) => {
    const loaded = attempt("rules.reload", () => loadRules(), getRuleSet());
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
      const stats = getEvaluator() === undefined ? null : getEvaluator().stats();
      const lines = [
        "steward status  rules " + (getRuleSet().rules || []).length + "  hash " + String(getRuleSet().hash) + "  evaluated " + String(stats === null ? "-" : stats.evaluated) + "  matched " + String(stats === null ? "-" : stats.matched),
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

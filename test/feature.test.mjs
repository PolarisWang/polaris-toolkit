/**
 * 集成测试：把整个工具包挂到假 ctx 上，走真实 HTTP handler 形状。
 *
 * 重点不是覆盖业务细节（那是 db/wf/rules/session 等单测的事），而是
 * 保证「挂载不崩、路由可用、事件能落到账本、dispose 干净」。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-home-"));
process.env.DSH_HOME = HOME;

const { FEATURES } = await import("../lib/features/index.js");
const { mountToolkit } = await import("../lib/core/host.js");

function makeCtx(overrides = {}) {
  const effects = [];
  const routes = [];
  const tools = [];
  const logs = [];
  const listeners = new Map();
  const ctx = {
    on(event, fn) {
      const arr = listeners.get(event) || [];
      arr.push(fn);
      listeners.set(event, arr);
      return () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };
    },
    emit(event, payload) { for (const fn of (listeners.get(event) || []).slice()) fn(payload); },
    logger: {
      info: (m) => logs.push("info " + m),
      warn: (m) => logs.push("warn " + m),
      error: (m) => logs.push("error " + m)
    },
    effect(fn) { const off = fn(); effects.push(off); return () => {}; },
    webServer: { register(opts) { routes.push(opts); return () => {}; } },
    tools: { register(tool) { tools.push(tool); return () => {}; } },
    agents: { list: () => [], get: () => undefined },
    get: () => undefined,
    ...overrides
  };
  return { ctx, effects, routes, tools, logs };
}

function mount(overrides) {
  const env = makeCtx(overrides);
  const result = mountToolkit(env.ctx, { features: {} }, {
    name: "polaris-toolkit",
    prefix: "/__polaris",
    displayName: "Polaris Toolkit",
    features: FEATURES
  });
  TOKEN = result.token;
  const handler = (name) => env.routes.filter((r) => r.path === "/__polaris/" + name)[0].handler;
  const toolkit = env.routes.filter((r) => r.path === "/__polaris")[0].handler;
  return { ...env, result, handler, toolkit };
}

function fakeRes() {
  return {
    statusCode: 0, headers: {}, body: "",
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(body) { this.body = body === undefined ? "" : String(body); }
  };
}

let TOKEN = "";

function fakeReq(method, url, body) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1:1" };
  if (TOKEN !== "") req.headers["x-polaris-token"] = TOKEN;
  if (body !== undefined) req.push(Buffer.from(JSON.stringify(body), "utf8"));
  req.push(null);
  return req;
}

async function call(handler, method, url, body) {
  const res = fakeRes();
  await handler(fakeReq(method, url, body), res);
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

async function json(res) { return JSON.parse(res.body); }

test("mounts both features without throwing", () => {
  const m = mount();
  assert.deepEqual(m.result.features, ["heap-guard", "steward"]);
  assert.equal(m.routes.length, 3);
  assert.equal(m.tools.length, 9);
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("state endpoint answers and carries every section", async () => {
  const m = mount();
  const res = await call(m.handler("steward"), "GET", "/__polaris/steward/api/state");
  assert.equal(res.statusCode, 200);
  const s = await json(res);
  assert.equal(s.ok, true);
  for (const key of ["health", "agents", "modules", "signals", "counters", "runs", "approvals", "rules", "control"]) {
    assert.ok(key in s, "state has " + key);
  }
  assert.ok(s.modules.length >= 5, "module buckets");
  assert.ok(s.rules.count >= 13, "builtin rules");
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("observed agents land in the ledger and errors fire a rule", async () => {
  const m = mount();
  m.ctx.emit("agent/created", { agentId: "a1", sessionId: "session-x", status: "idle" });
  m.ctx.emit("agent/status", { agent: { id: "a1" }, status: "running" });
  let s = await json(await call(m.handler("steward"), "GET", "/__polaris/steward/api/state"));
  assert.equal(s.agents.length, 1);
  assert.equal(s.agents[0].status, "running");

  m.ctx.emit("agent/error", { agentId: "a1", message: "boom" });
  s = await json(await call(m.handler("steward"), "GET", "/__polaris/steward/api/state"));
  assert.ok(s.signals.some((x) => x.kind === "agent/error"), "error signal");

  const runs = await json(await call(m.handler("steward"), "GET", "/__polaris/steward/api/runs"));
  assert.ok(runs.runs.some((r) => String(r.subject) === "a1"), "rule started a workflow for the agent");
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("settings patch round-trips through the panel api", async () => {
  const m = mount();
  const set = await json(await call(m.handler("steward"), "POST", "/__polaris/steward/api/settings", { patch: { autoAct: true, notify: { larkEnabled: false } } }));
  assert.equal(set.ok, true);
  assert.equal(set.settings.autoAct, true);
  const back = await json(await call(m.handler("steward"), "GET", "/__polaris/steward/api/state"));
  assert.equal(back.control.autoAct, true);
  const off = await json(await call(m.handler("steward"), "POST", "/__polaris/steward/api/settings", { patch: { autoAct: false } }));
  assert.equal(off.settings.autoAct, false);
  for (const off1 of m.effects) { try { off1(); } catch { /* ignore */ } }
});

test("hostile host services degrade instead of crashing", async () => {
  const m = mount({
    get: () => { throw new Error("service lookup exploded"); },
    agents: { list: () => { throw new Error("agents exploded"); }, get: () => { throw new Error("get exploded"); } },
    on: () => { throw new Error("event bus exploded"); }
  });
  const res = await call(m.handler("steward"), "GET", "/__polaris/steward/api/state");
  assert.equal(res.statusCode, 200, "state still answers");
  const s = await json(res);
  assert.equal(s.ok, true);
  assert.ok(Array.isArray(s.degraded), "degraded list present");
  const tick = await call(m.handler("steward"), "GET", "/__polaris/steward/api/tick");
  assert.equal(tick.statusCode, 200, "tick still answers");
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("panel html contains the pyramid and the control buttons", async () => {
  const m = mount();
  const res = await call(m.handler("steward"), "GET", "/__polaris/steward/");
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes("大内总管"));
  assert.ok(res.body.includes("自动动作"), "auto toggle");
  assert.ok(res.body.includes("飞书通知"), "lark toggle");
  assert.ok(res.body.includes("待批"), "approvals section");
  assert.ok(res.body.includes("工作流"), "runs section");
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("dispose is safe to call twice and stops the tick loop", () => {
  const m = mount();
  for (const off of m.effects) { assert.doesNotThrow(() => off()); }
  for (const off of m.effects) { assert.doesNotThrow(() => off()); }
});

test("remounting in the same process keeps working", async () => {
  const a = mount();
  for (const off of a.effects) { try { off(); } catch { /* ignore */ } }
  const b = mount();
  const res = await call(b.handler("steward"), "GET", "/__polaris/steward/api/state");
  assert.equal(res.statusCode, 200);
  assert.equal((await json(res)).ok, true);
  for (const off of b.effects) { try { off(); } catch { /* ignore */ } }
});

test("toolkit metrics endpoint exports host and feature gauges", async () => {
  const m = mount();
  const res = await call(m.toolkit, "GET", "/__polaris/metrics");
  assert.equal(res.statusCode, 200);
  assert.ok(String(res.headers["content-type"]).includes("text/plain"), "prometheus content type");
  for (const name of ["polaris_heap_used_mb", "polaris_features_total", "polaris_heap_guard_used_pct", "polaris_steward_agents_total"]) {
    assert.ok(res.body.includes(name), "metric " + name);
  }
  assert.ok(/# TYPE polaris_heap_used_mb gauge/.test(res.body), "type lines present");
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("write routes need the install token, read routes stay open", async () => {
  const m = mount();
  const saved = TOKEN;
  TOKEN = "";
  const denied = await call(m.toolkit, "POST", "/__polaris/api/settings", { feature: "heap-guard", patch: { autoSlim: true } });
  assert.ok(denied.statusCode === 401 || denied.statusCode === 403, "write refused, got " + denied.statusCode);
  const read = await call(m.toolkit, "GET", "/__polaris/api/features");
  assert.equal(read.statusCode, 200, "read stays open");
  TOKEN = saved;
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("invalid settings patches are rejected with 400", async () => {
  const m = mount();
  const bad = await call(m.toolkit, "POST", "/__polaris/api/settings", { feature: "heap-guard", patch: { slimLevel: 99 } });
  assert.equal(bad.statusCode, 400);
  const body = await json(bad);
  assert.equal(body.code, "invalid-settings");
  const ok = await call(m.toolkit, "POST", "/__polaris/api/settings", { feature: "heap-guard", patch: { slimLevel: 2 } });
  assert.equal(ok.statusCode, 200, "valid nested patch still applies");
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("features endpoint exposes install, capabilities, bus and scheduler", async () => {
  const m = mount();
  const f = await json(await call(m.toolkit, "GET", "/__polaris/api/features"));
  assert.equal(typeof f.install, "object");
  assert.equal(f.install.version, "0.3.0");
  assert.ok(f.capabilities.includes("heap-guard.action"), "capability registry published");
  assert.ok(Array.isArray(f.scheduler) && f.scheduler.length >= 2, "scheduler tasks listed");
  assert.ok(Array.isArray(f.bus) && f.bus.includes("heap/critical"), "bus topics listed");
  assert.ok(typeof f.metrics === "number" && f.metrics > 0, "metric count reported");
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("journal supports incremental pull with since", async () => {
  const m = mount();
  m.ctx.emit("agent/error", { agentId: "a2", message: "boom" });
  const first = await json(await call(m.handler("steward"), "GET", "/__polaris/steward/api/journal?since=0"));
  assert.equal(first.ok, true);
  assert.ok(first.entries.length > 0, "entries returned");
  assert.ok(first.latest > 0, "cursor returned");
  const second = await json(await call(m.handler("steward"), "GET", "/__polaris/steward/api/journal?since=" + first.latest));
  assert.equal(second.ok, true);
  assert.ok(second.entries.every((e) => e.seq > first.latest), "only entries past the cursor");
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("modules can be created, edited, deleted and reset from the panel", async () => {
  const m = mount();
  const h = m.handler("steward");
  const save = async (module) => json(await call(h, "POST", "/__polaris/steward/api/modules", { op: "save", module }));
  const defs = async () => (await json(await call(h, "GET", "/__polaris/steward/api/modules"))).defs;
  const created = await save({ id: "cbtest", name: "CB 测试", workspaces: "D:/agent/cb2, D:/agent/cb3", titles: "cb2, cb3", enabled: true });
  assert.equal(created.ok, true);
  let list = await defs();
  const found = list.filter((x) => x.id === "cbtest")[0];
  assert.ok(found !== undefined, "module saved");
  assert.deepEqual(found.workspaces, ["D:/agent/cb2", "D:/agent/cb3"], "workspaces split on commas");
  assert.deepEqual(found.titles, ["cb2", "cb3"], "titles split on commas");

  const edited = await save({ id: "cbtest", name: "CB 改名", workspaces: ["D:/agent/cb2"], titles: [], enabled: false });
  assert.equal(edited.ok, true);
  list = await defs();
  const again = list.filter((x) => x.id === "cbtest")[0];
  assert.equal(again.name, "CB 改名", "save overwrites in place");
  assert.equal(again.enabled, false);
  assert.equal(again.workspaces.length, 1);

  const badId = await call(h, "POST", "/__polaris/steward/api/modules", { op: "save", module: { id: "bad id!", name: "x" } });
  assert.equal(badId.statusCode, 400, "illegal id refused");
  const reserved = await call(h, "POST", "/__polaris/steward/api/modules", { op: "delete", id: "unassigned" });
  assert.equal(reserved.statusCode, 400, "unassigned is reserved");

  await json(await call(h, "POST", "/__polaris/steward/api/pin", { agentId: "agent-cb", module: "cbtest" }));
  const del = await json(await call(h, "POST", "/__polaris/steward/api/modules", { op: "delete", id: "cbtest" }));
  assert.equal(del.ok, true);
  assert.equal(del.droppedPins, 1, "pins pointing at a deleted module are dropped");
  assert.equal(del.pins["agent-cb"], undefined, "the stale pin is gone");
  list = await defs();
  assert.equal(list.filter((x) => x.id === "cbtest").length, 0, "module removed");
  const missing = await call(h, "POST", "/__polaris/steward/api/modules", { op: "delete", id: "cbtest" });
  assert.equal(missing.statusCode, 404, "deleting a missing module is 404");

  const reset = await json(await call(h, "POST", "/__polaris/steward/api/modules", { op: "reset" }));
  assert.equal(reset.ok, true);
  list = await defs();
  assert.ok(list.length >= 5, "builtin modules restored");
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

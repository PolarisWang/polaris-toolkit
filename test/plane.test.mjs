import test from "node:test";
import assert from "node:assert/strict";
import { createCatalog, targetMatches, parseTarget } from "../lib/features/steward/plane/catalog.js";
import { validateTree, evalTree } from "../lib/features/steward/plane/tree.js";
import { createCarriers } from "../lib/features/steward/plane/carriers.js";
import { createPipeline } from "../lib/features/steward/plane/pipeline.js";
import { createTraceStore } from "../lib/core/trace.js";
import { builtinInstances, RULE_MIGRATION, WORKFLOW_MIGRATION } from "../lib/features/steward/plane/instances.js";

const INSTANCES = [
  { id: "notify.desktop", title: "通知主人", payload: "notice", carrier: "desktop", target: "owner", protocol: "fire", grant: "act" },
  {
    id: "judge.heap.critical", title: "堆危急", payload: "verdict", carrier: "expr", target: "host:*", protocol: "ack",
    params: { rules: [{ id: "heap.critical", if: { gte: ["heapPct", 92] }, level: "critical", reason: "堆占用过高" }] }
  },
  {
    id: "plan.notify", title: "通知片段", payload: "plan", carrier: "tree", target: "*", protocol: "ack",
    plan: { seq: [{ call: "notify.desktop", params: { text: "{text}" }, save: "sent" }] }
  },
  { id: "steer.session", title: "催会话", payload: "directive", carrier: "session", target: "session:*", protocol: "fire", limits: { cooldownSec: 60 } }
];

function makeCatalog() {
  const cat = createCatalog();
  cat.defineAll(INSTANCES);
  return cat;
}

test("catalog: define/list/pick/describe and validation", () => {
  const cat = makeCatalog();
  assert.equal(cat.size(), 4);
  assert.equal(cat.get("notify.desktop").payload, "notice");
  assert.equal(cat.pick("verdict", "expr").id, "judge.heap.critical");
  assert.deepEqual(cat.list({ carrier: "session" }).map((s) => s.id), ["steer.session"]);
  const d = cat.describe();
  assert.equal(d.count, 4);
  assert.equal(d.byPayload.notice, 1);
  assert.equal(d.byCarrier.expr, 1);
  assert.throws(() => cat.define({ id: "bad.id!", payload: "notice", carrier: "desktop", target: "owner", protocol: "fire" }), /invalid capability/);
  assert.throws(() => cat.define({ id: "x.y", payload: "nope", carrier: "desktop", target: "owner", protocol: "fire" }), /bad payload/);
  assert.throws(() => cat.define({ id: "x.y", payload: "notice", carrier: "desktop", target: "planet:mars", protocol: "fire" }), /bad target kind/);
  assert.throws(() => cat.define(INSTANCES[0]), /duplicate capability/);
  assert.equal(targetMatches("host:*", "host:win-main"), true);
  assert.equal(targetMatches("session:*", "host:win-main"), false);
  assert.deepEqual(parseTarget("session:abc"), { kind: "session", id: "abc" });
});

test("catalog: validateParams honors a schema function", () => {
  const cat = createCatalog();
  cat.define({
    id: "text.out", payload: "notice", carrier: "file", target: "text:*", protocol: "fire",
    schema: (params) => {
      if (typeof params.text !== "string") throw new Error("text required");
      return { text: params.text };
    }
  });
  assert.equal(cat.validateParams("text.out", { text: "hi" }).ok, true);
  assert.equal(cat.validateParams("text.out", { text: 5 }).ok, false);
  assert.equal(cat.validateParams("missing.cap", {}).ok, false);
});

test("tree: validation catches unknown equips and shape errors", () => {
  const plan = {
    when: "host/tick",
    do: {
      seq: [
        { if: { gte: ["heapPct", 92] }, then: { call: "judge.heap.critical" }, else: { noop: true } },
        { choose: [{ if: { lt: ["freeDiskMB", 2048] }, do: { call: "notify.desktop" } }], fallback: { noop: true } }
      ]
    }
  };
  const ok = validateTree(plan, { equips: ["judge.heap.critical", "notify.desktop"] });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.warnings.length, 0);
  assert.ok(ok.nodes >= 6);

  const bad = validateTree({ call: "not.equipped" }, { equips: ["notify.desktop"] });
  assert.equal(bad.ok, true);
  assert.equal(bad.warnings.length, 1);
  assert.match(bad.warnings[0], /capability not equipped/);

  const worse = validateTree({ seq: [{ choose: [{ if: { const: true }, do: { noop: true } }] }, { wait: 5 }] });
  assert.equal(worse.ok, false);
  assert.ok(worse.errors.some((e) => e.indexOf("fallback") >= 0));
  assert.ok(worse.warnings.some((w) => w.indexOf("park forever") >= 0));

  const unknown = validateTree({ nope: 1 });
  assert.equal(unknown.ok, false);
});

test("tree: evalTree runs branches, saves vars and records calls", async () => {
  const calls = [];
  const plan = {
    seq: [
      { when: "host/tick", do: { set: "greeting", value: "hello {name}" } },
      {
        choose: [
          { if: { gte: ["heapPct", 92] }, do: { call: "judge.heap.critical", save: "verdict" } },
          { if: { gte: ["heapPct", 80] }, do: { call: "notify.desktop", params: { text: "{greeting}" } } }
        ],
        fallback: { noop: true }
      }
    ]
  };
  const res = await evalTree(plan, {
    event: "host/tick",
    facts: { heapPct: 95, name: "win-main" },
    call: async (cap, params) => { calls.push({ cap, params }); return { ok: true, data: { hit: true, level: "critical" } }; }
  });
  assert.equal(res.ok, true);
  assert.equal(res.status, "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cap, "judge.heap.critical");
  assert.deepEqual(res.vars.verdict, { hit: true, level: "critical" });
  assert.deepEqual(res.vars.greeting, "hello win-main");

  const skipped = await evalTree({ when: "agent/stalled", do: { call: "notify.desktop" } }, { event: "host/tick", call: async () => ({ ok: true }) });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.calls.length, 0);

  const gate = await evalTree({ all: [{ lt: ["heapPct", 50] }] }, { event: "host/tick", facts: { heapPct: 95 } });
  assert.equal(gate.status, "skipped");
  assert.match(gate.error, /condition-false/);

  const failed = await evalTree({ call: "notify.desktop" }, { event: "x", call: async () => ({ ok: false, error: "boom" }) });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /call-failed:notify.desktop/);
});

test("expr carrier: judge capability returns verdicts by severity", async () => {
  const cat = makeCatalog();
  const carriers = createCarriers({});
  const adapter = carriers.get("expr");
  const spec = cat.get("judge.heap.critical");
  const hot = await adapter.run(spec, {}, { facts: { heapPct: 95 } });
  assert.equal(hot.ok, true);
  assert.equal(hot.data.hit, true);
  assert.equal(hot.data.level, "critical");
  assert.equal(hot.data.reason, "堆占用过高");
  const cold = await adapter.run(spec, {}, { facts: { heapPct: 20 } });
  assert.equal(cold.data.hit, false);
  assert.equal(cold.data.level, "ok");
});

test("pipeline: order of gates (route, grant, idempotency, budget, cooldown, echo)", async () => {
  const cat = makeCatalog();
  const calls = [];
  const carriers = createCarriers({
    carriers: [
      { carrier: "desktop", run: async (spec, params) => { calls.push(params); return { ok: true, extId: "msg-1" }; }, preview: (spec, params) => "通知 " + String(params.text) },
      { carrier: "session", run: async () => { calls.push("session"); return { ok: true, extId: "prompt-1" }; } }
    ]
  });
  let allowBudget = true;
  const pipe = createPipeline({
    catalog: cat,
    carriers,
    trace: createTraceStore({}),
    routes: { decide: (steward, cap) => (cap === "judge.heap.critical" ? "deny" : "allow") },
    budget: { allow: () => allowBudget },
    live: (ctx) => ctx.live === true
  });

  const routed = await pipe.act({ cap: "judge.heap.critical", target: "host:win-main" }, { stewardId: "s1", subject: "host:win-main", live: true });
  assert.equal(routed.decision, "deny");
  assert.equal(routed.reason, "route-denied");

  const echo = await pipe.act({ cap: "notify.desktop", params: { text: "hi" } }, { stewardId: "s1", subject: "host:win-main" });
  assert.equal(echo.decision, "preview");
  assert.equal(echo.reason, "echo");
  assert.match(echo.preview, /通知 hi/);
  assert.equal(calls.length, 0);

  const live = await pipe.act({ cap: "notify.desktop", params: { text: "hi" } }, { stewardId: "s1", subject: "host:win-main", live: true });
  assert.equal(live.decision, "run");
  assert.equal(live.extId, "msg-1");
  assert.equal(calls.length, 1);

  const idem = await pipe.act({ cap: "notify.desktop", params: { text: "hi" }, idemKey: "k1" }, { stewardId: "s1", live: true });
  assert.equal(idem.decision, "run");
  const again = await pipe.act({ cap: "notify.desktop", params: { text: "hi" }, idemKey: "k1" }, { stewardId: "s1", live: true });
  assert.equal(again.decision, "skip");
  assert.equal(again.reason, "idempotent");

  const cold = await pipe.act({ cap: "steer.session", params: { text: "wake up" } }, { stewardId: "s1", subject: "session:a", live: true });
  assert.equal(cold.decision, "run");
  const cooling = await pipe.act({ cap: "steer.session", params: { text: "wake up" } }, { stewardId: "s1", subject: "session:a", live: true });
  assert.equal(cooling.decision, "skip");
  assert.equal(cooling.reason, "cooldown");

  allowBudget = false;
  const poor = await pipe.act({ cap: "steer.session", params: { text: "x" } }, { stewardId: "s1", subject: "session:b", live: true });
  assert.equal(poor.decision, "deny");
  assert.equal(poor.reason, "budget-exhausted");

  const stats = pipe.stats();
  assert.equal(stats.run, 3);
  assert.equal(stats.deny, 2);
  assert.equal(stats.preview, 1);
  assert.equal(pipe.reasons()["route-denied"], 1);
  assert.equal(pipe.reasons()["budget-exhausted"], 1);
});

test("pipeline: scope, self-target, human present, grants and invalid params", async () => {
  const cat = makeCatalog();
  const carriers = createCarriers({
    carriers: [
      { carrier: "desktop", run: async () => ({ ok: true }) },
      { carrier: "session", run: async () => ({ ok: true }) }
    ]
  });
  const pipe = createPipeline({ catalog: cat, carriers, live: () => true });
  const scope = ["host:win-main", "session:allowed"];

  assert.equal((await pipe.act({ cap: "notify.desktop" }, { stewardId: "s1", subject: "session:nope", scope })).reason, "out-of-scope");
  assert.equal((await pipe.act({ cap: "steer.session" }, { stewardId: "s1", subject: "session:allowed", selfSessionId: "allowed" })).reason, "self-target");
  assert.equal((await pipe.act({ cap: "steer.session" }, { stewardId: "s1", subject: "session:allowed", humanPresent: true })).reason, "human-present");
  assert.equal((await pipe.act({ cap: "steer.session", by: "owner" }, { stewardId: "s1", subject: "session:allowed", humanPresent: true })).decision, "run");

  const denied = createPipeline({ catalog: cat, carriers, live: () => true, grants: { s1: { "notify.desktop": "denied", "steer.session": "dry-run" } } });
  assert.equal((await denied.act({ cap: "notify.desktop" }, { stewardId: "s1", subject: "host:win-main" })).reason, "need-grant");
  const dry = await denied.act({ cap: "steer.session" }, { stewardId: "s1", subject: "session:a" });
  assert.equal(dry.decision, "preview");
  assert.equal(dry.reason, "grant-dry-run");

  const cat2 = createCatalog();
  cat2.define({ id: "need.text", payload: "notice", carrier: "desktop", target: "owner", protocol: "fire", schema: (p) => { if (typeof p.text !== "string") throw new Error("text required"); return p; } });
  const strict = createPipeline({ catalog: cat2, carriers, live: () => true });
  const bad = await strict.act({ cap: "need.text", params: {} }, { stewardId: "s1" });
  assert.equal(bad.reason, "invalid-params:text required");
});

test("pipeline: runPlan executes a plan fragment and records spans/effects on one trace", async () => {
  const cat = makeCatalog();
  const seen = [];
  const carriers = createCarriers({
    carriers: [{ carrier: "desktop", run: async (spec, params) => { seen.push(params.text); return { ok: true, extId: "om_9" }; } }]
  });
  const trace = createTraceStore({});
  const pipe = createPipeline({ catalog: cat, carriers, trace, live: () => true });
  const res = await pipe.runPlan(cat.get("plan.notify").plan, { facts: { text: "堆危急" }, subject: "host:win-main", stewardId: "s1" });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(seen, ["堆危急"]);
  const w = trace.waterfall(res.traceId);
  assert.ok(w !== undefined);
  assert.equal(w.spans.length >= 2, true);
  assert.equal(w.effects.length, 1);
  assert.equal(w.effects[0].extId, "om_9");
  assert.equal(w.effects[0].cap, "notify.desktop");
  assert.equal(trace.byExtId("om_9").length, 1);

  const auto = await pipe.run([{ cap: "notify.desktop", params: { text: "batch" } }], { stewardId: "s1", subject: "host:win-main" });
  assert.equal(auto.ok, true);
  assert.equal(auto.traceId, "t-" + String(Number(res.traceId.slice(2)) + 1));
  assert.equal(auto.results[0].decision, "run");
});

test("instances: builtin batch loads, validates and covers the old rules and workflows", () => {
  const cat = createCatalog();
  cat.defineAll(builtinInstances());
  const ids = cat.ids();
  assert.equal(new Set(ids).size, ids.length);
  const judges = cat.list({ payload: "verdict" });
  assert.equal(judges.length, 6);
  assert.deepEqual(judges.map((j) => j.id).sort(), [
    "judge.agent.stalled", "judge.host.crash.new", "judge.host.disk.low", "judge.host.heap.critical", "judge.host.heap.high", "judge.host.loop.lag"
  ]);
  assert.equal(cat.list({ payload: "plan" }).length, 5);
  assert.equal(RULE_MIGRATION.length, 5);
  assert.equal(WORKFLOW_MIGRATION.length, 5);
  for (const m of RULE_MIGRATION) assert.ok(cat.has(m.capability), m.capability);
  for (const m of WORKFLOW_MIGRATION) assert.ok(cat.has(m.capability), m.capability);
  const byId = {};
  for (const inst of cat.list()) byId[inst.id] = inst;
  for (const m of RULE_MIGRATION) {
    const plan = byId[m.plan].plan;
    assert.equal(byId[m.plan].payload, "plan");
    assert.ok(plan !== undefined);
  }
  for (const inst of cat.list({ payload: "plan" })) {
    const v = validateTree(inst.plan, { equips: ids });
    assert.equal(v.ok, true, inst.id + ": " + JSON.stringify(v.errors));
    assert.equal(v.warnings.length, 0, inst.id + ": " + JSON.stringify(v.warnings));
  }
});

test("instances: each judge fires on its own threshold and stays quiet below it", async () => {
  const cat = createCatalog();
  cat.defineAll(builtinInstances());
  const carriers = createCarriers({ carriers: [{ carrier: "expr", run: (await import("../lib/features/steward/plane/carriers.js")).builtinCarriers({}).find((c) => c.carrier === "expr").run }] });
  const cases = [
    { id: "judge.host.heap.high", hot: { heapPct: 90 }, cold: { heapPct: 20 }, level: "warning" },
    { id: "judge.host.heap.critical", hot: { heapPct: 95 }, cold: { heapPct: 30 }, level: "critical" },
    { id: "judge.host.loop.lag", hot: { loopP99Ms: 400 }, cold: { loopP99Ms: 10 }, level: "warning" },
    { id: "judge.host.disk.low", hot: { freeDiskMB: 100 }, cold: { freeDiskMB: 50000 }, level: "error" },
    { id: "judge.host.crash.new", hot: { crashNewestAgeMin: 5 }, cold: { crashNewestAgeMin: 5000 }, level: "critical" }
  ];
  for (const c of cases) {
    const spec = cat.get(c.id);
    const hot = await carriers.get("expr").run(spec, {}, { facts: c.hot });
    assert.equal(hot.data.hit, true, c.id);
    assert.equal(hot.data.level, c.level, c.id);
    const cold = await carriers.get("expr").run(spec, {}, { facts: c.cold });
    assert.equal(cold.data.hit, false, c.id);
    assert.equal(cold.data.level, "ok", c.id);
  }
});

test("instances: plan.agent.stall steers only when autoAct is on", async () => {
  const cat = createCatalog();
  cat.defineAll(builtinInstances());
  const seen = [];
  const carriers = createCarriers({
    carriers: [
      { carrier: "desktop", run: async (i, p) => { seen.push(["notify", p.text]); return { ok: true }; } },
      { carrier: "session", run: async (i, p) => { seen.push(["steer", p.sessionId, p.text]); return { ok: true, extId: "prompt-1" }; } }
    ]
  });
  const trace = createTraceStore({});
  const pipe = createPipeline({ catalog: cat, carriers, trace, live: () => true });
  const plan = cat.get("plan.agent.stall").plan;
  const off = await pipe.runPlan(plan, { facts: { autoAct: false, title: "net", text: "已静默 9 分钟", parentSessionId: "sess-1" }, subject: "session-aaa", stewardId: "st1" });
  assert.equal(off.ok, true, off.error);
  assert.deepEqual(seen, [["notify", "已静默 9 分钟"]]);
  seen.length = 0;
  const on = await pipe.runPlan(plan, { facts: { autoAct: true, title: "net", text: "已静默 9 分钟", parentSessionId: "sess-1" }, subject: "session-aaa", stewardId: "st1" });
  assert.equal(on.ok, true, on.error);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], ["steer", "sess-1", "子系统静默，请确认进度"]);
  const w = trace.waterfall(on.traceId);
  assert.equal(w.effects.length, 2);
});

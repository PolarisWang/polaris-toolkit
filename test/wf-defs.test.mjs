import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "../lib/features/steward/core/db.js";
import { createEngine } from "../lib/features/steward/wf/engine.js";
import { createApprovalStore } from "../lib/features/steward/core/approvals.js";
import { defineWorkflows } from "../lib/features/steward/wf/defs.js";

const NOW = 1_700_000_000_000;

function setup(options) {
  const o = options === undefined ? {} : options;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-wf-"));
  const db = createDb({ dir, backend: "json" });
  let clockValue = NOW;
  const clock = () => clockValue;
  const sent = [];
  const engine = createEngine({ db, clock, owner: "test" });
  const approval = createApprovalStore({ db, clock });
  const notify = { async send(message) { sent.push(message); return { ok: true, channel: "desktop" }; } };
  defineWorkflows({
    engine,
    notify,
    actions: Object.assign({ approval }, o.actions === undefined ? {} : o.actions),
    settings: () => (o.settings === undefined ? {} : o.settings),
    hostCtx: () => ({}),
    log: () => {}
  });
  return { dir, db, engine, approval, sent, clock, advance(ms) { clockValue += ms; return clockValue; }, now: () => clockValue };
}

test("wf.notify sends once and records the effect", async () => {
  const env = setup();
  const run = env.engine.start("wf.notify", { id: "run-n1", subject: "s1", vars: { title: "T", text: "hello", level: "warning" } });
  assert.equal(run.status, "pending");
  const summary = await env.engine.tick(env.now());
  assert.equal(summary.done, 1);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].text, "hello");
  assert.equal(env.engine.get("run-n1").status, "done");
  const actions = env.db.all("actions");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, "notify");
  assert.equal(actions[0].result.includes("desktop"), true);
  assert.equal(env.engine.start("wf.notify", { id: "run-n1", subject: "s1" }).id, "run-n1");
  await env.engine.tick(env.now());
  assert.equal(env.sent.length, 1);
});

test("wf.notify respects the notifier threshold", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-wf-"));
  const db = createDb({ dir, backend: "json" });
  const engine = createEngine({ db, clock: () => NOW });
  const sent = [];
  defineWorkflows({
    engine,
    notify: { async send(m) { sent.push(m); return { ok: true, skipped: "below-threshold" }; } },
    settings: () => ({ notify: { minSeverity: "warning" } })
  });
  engine.start("wf.notify", { id: "run-n2", vars: { title: "i", text: "x", level: "info" } });
  await engine.tick(NOW);
  const row = db.get("runs", { id: "run-n2" });
  assert.equal(row.status, "done");
  assert.equal(row.vars_json === null, false);
});

test("wf.ask waits for an answer and finishes", async () => {
  const env = setup();
  env.engine.start("wf.ask", { id: "run-a1", subject: "host", vars: { title: "重启吗", detail: "堆高", ttlMs: 60_000 } });
  await env.engine.tick(env.now());
  const waiting = env.engine.get("run-a1");
  assert.equal(waiting.status, "waiting");
  assert.equal(env.approval.listOpen().length, 1);
  const approval = env.approval.listOpen()[0];
  assert.equal(approval.title, "重启吗");
  env.approval.answer(approval.id, "approve", "me");
  env.engine.deliver("run-a1", "approval", { answer: "approve" });
  await env.engine.tick(env.now());
  const done = env.engine.get("run-a1");
  assert.equal(done.status, "done");
  assert.equal(env.approval.get(approval.id).status, "approved");
});

test("wf.ask expires on its deadline", async () => {
  const env = setup();
  env.engine.start("wf.ask", { id: "run-a2", subject: "host", vars: { title: "t", ttlMs: 10_000 } });
  await env.engine.tick(env.now());
  const approval = env.approval.listOpen()[0];
  await env.engine.tick(env.now() + 20_000);
  assert.equal(env.engine.get("run-a2").status, "done");
  assert.equal(env.approval.get(approval.id).status, "expired");
});

test("wf.ask without an approval store is a no-op", async () => {
  const env = setup({ actions: { approval: undefined } });
  env.engine.start("wf.ask", { id: "run-a3", vars: { title: "t" } });
  await env.engine.tick(env.now());
  assert.equal(env.engine.get("run-a3").status, "done");
});

test("wf.agent.stall only notifies by default", async () => {
  const env = setup();
  env.engine.start("wf.agent.stall", { id: "run-s1", subject: "a1", vars: { title: "ev", moduleId: "ev", silenceMs: 600_000 } });
  await env.engine.tick(env.now());
  assert.equal(env.engine.get("run-s1").status, "done");
  assert.equal(env.sent.length, 1);
  assert.match(env.sent[0].title, /agent 卡住/);
  assert.match(env.sent[0].text, /10 分钟/);
});

test("wf.agent.stall steers the parent when explicitly enabled", async () => {
  const prompted = [];
  const env = setup({
    settings: { autoAct: true, actions: { stallSteer: true } },
    actions: { prompt: { async prompt(ctx, request) { prompted.push(request); return { ok: true }; } } }
  });
  env.engine.start("wf.agent.stall", { id: "run-s2", subject: "a1", vars: { title: "ev", silenceMs: 600_000, parentSessionId: "parent-1" } });
  await env.engine.tick(env.now());
  assert.equal(prompted.length, 1);
  assert.equal(prompted[0].sessionId, "parent-1");
  assert.match(prompted[0].requestId, /^stall:a1:/);
});

test("wf.agent.stall skips steering when autoAct is off", async () => {
  const prompted = [];
  const env = setup({ settings: { autoAct: false, actions: { stallSteer: true } }, actions: { prompt: { async prompt() { prompted.push(1); return { ok: true }; } } } });
  env.engine.start("wf.agent.stall", { id: "run-s3", subject: "a1", vars: { silenceMs: 0, parentSessionId: "p" } });
  await env.engine.tick(env.now());
  assert.equal(prompted.length, 0);
});

test("wf.host.protect notifies and never slims by default", async () => {
  const env = setup();
  env.engine.start("wf.host.protect", { id: "run-h1", vars: { usedMB: 3800, limitMB: 4192, pct: 90.6 } });
  await env.engine.tick(env.now());
  assert.equal(env.engine.get("run-h1").status, "done");
  assert.equal(env.sent.length, 1);
  assert.match(env.sent[0].text, /3800MB/);
});

test("wf.host.protect slims when enabled", async () => {
  const slimmed = [];
  const env = setup({ settings: { autoAct: true, actions: { heapSlim: true } }, actions: { slim: async (level) => { slimmed.push(level); return { ok: true }; } } });
  env.engine.start("wf.host.protect", { id: "run-h2", vars: { usedMB: 4000, limitMB: 4192, pct: 95 } });
  await env.engine.tick(env.now());
  assert.deepEqual(slimmed, [3]);
});

test("wf.digest renders a rollup and notifies", async () => {
  const env = setup();
  env.engine.start("wf.digest", {
    id: "run-d1",
    vars: { agents: [{ id: "a1", title: "ev", moduleId: "ev", status: "running" }], runs: [], signals: [], approvals: [] }
  });
  await env.engine.tick(env.now());
  assert.equal(env.engine.get("run-d1").status, "done");
  assert.equal(env.sent.length, 1);
  assert.match(env.sent[0].text, /agent 1/);
});
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "../lib/features/steward/core/db.js";
import { createEngine } from "../lib/features/steward/wf/engine.js";

function clockAt(start) {
  let now = start;
  return { now: () => now, set: (v) => { now = v; }, add: (ms) => { now += ms; } };
}

function makeEngine(options) {
  const o = options === undefined ? {} : options;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-wf-"));
  const db = createDb({ dir, backend: o.backend === undefined ? "json" : o.backend, log: () => {} });
  const clock = clockAt(1_000_000);
  const engine = createEngine({ db, clock: clock.now, maxAttempts: o.maxAttempts === undefined ? 3 : o.maxAttempts, backoffMs: 100, recovery: o.recovery, onFinish: o.onFinish, log: () => {} });
  return { db, clock, engine, dir };
}

test("linear workflow runs to done and records its effect once", async () => {
  const { db, engine, clock } = makeEngine();
  let effects = 0;
  engine.define({
    name: "wf.linear",
    start: "a",
    steps: {
      a: { kind: "call", effect: true, next: "b", run: (ctx) => { ctx.effect("notify", "user", { text: "hi" }, () => { effects += 1; return "sent"; }); return { output: "a-done" }; } },
      b: { kind: "call", run: () => ({ output: "b-done" }) }
    }
  });
  const run = engine.start("wf.linear", { subject: "agent-1" });
  assert.equal(run.status, "pending");
  const summary = await engine.tick(clock.now());
  assert.equal(summary.done, 1);
  const after = engine.get(run.id);
  assert.equal(after.status, "done");
  assert.equal(effects, 1);
  const actions = db.all("actions");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, "notify");
  assert.equal(JSON.parse(actions[0].result), "sent");
  assert.equal(db.all("steps").filter((s) => s.run_id === run.id).length, 2);
});

test("wait step parks the run until its timer fires", async () => {
  const { engine, clock, db } = makeEngine();
  engine.define({ name: "wf.wait", start: "pause", steps: { pause: { kind: "wait", waitMs: 5000, run: (ctx) => (ctx.resumed ? { output: "resumed" } : { wait: 5000 }) } } });
  const run = engine.start("wf.wait", { subject: "s1" });
  await engine.tick(clock.now());
  let row = engine.get(run.id);
  assert.equal(row.status, "waiting");
  assert.equal(row.wake_at, clock.now() + 5000);
  assert.equal(db.all("timers").length, 1);
  await engine.tick(clock.now() + 1000);
  assert.equal(engine.get(run.id).status, "waiting");
  clock.add(6000);
  await engine.tick(clock.now());
  row = engine.get(run.id);
  assert.equal(db.all("timers").length, 0);
  assert.equal(row.wake_at, null);
});

test("a waiting run resumes exactly once per timer", async () => {
  const { engine, clock, db } = makeEngine();
  let rounds = 0;
  engine.define({ name: "wf.wait2", start: "s", steps: { s: { kind: "wait", run: (ctx) => { rounds += 1; return ctx.vars.signals === undefined && !ctx.resumed ? { wait: 1000 } : { output: "got-signal" }; } } } });
  const run = engine.start("wf.wait2", { subject: "s2" });
  await engine.tick(clock.now());
  assert.equal(engine.get(run.id).status, "waiting");
  engine.deliver(run.id, "approved", { by: "user" });
  await engine.tick(clock.now());
  assert.equal(engine.get(run.id).status, "done");
  assert.equal(db.all("timers").length, 0);
  assert.ok(rounds >= 2);
});

test("failing step retries with backoff and lands in the dlq", async () => {
  const { engine, clock, db } = makeEngine({ maxAttempts: 3 });
  let calls = 0;
  engine.define({ name: "wf.fail", start: "boom", steps: { boom: { kind: "call", run: () => { calls += 1; return { fail: "nope" }; } } } });
  const run = engine.start("wf.fail", { subject: "s3" });
  await engine.tick(clock.now());
  assert.equal(calls, 1);
  assert.equal(engine.get(run.id).status, "waiting");
  await engine.tick(clock.now() + 200);
  assert.equal(calls, 2);
  await engine.tick(clock.now() + 2000);
  assert.equal(calls, 3);
  const row = engine.get(run.id);
  assert.equal(row.status, "failed");
  assert.match(row.error, /nope/);
  const dlq = db.all("dlq");
  assert.equal(dlq.length, 1);
  assert.equal(dlq[0].reason, "nope");
});

test("a retried step does not re-run its side effect", async () => {
  const { engine, clock, db } = makeEngine({ maxAttempts: 3 });
  let effects = 0;
  let attempt = 0;
  engine.define({
    name: "wf.idem", start: "s",
    steps: { s: { kind: "call", effect: true, run: (ctx) => {
      ctx.effect("prompt", "session-1", { text: "go" }, () => { effects += 1; return { delivered: true }; });
      attempt += 1;
      return attempt < 3 ? { fail: "flaky" } : { output: "ok" };
    } } }
  });
  const run = engine.start("wf.idem", { subject: "s4" });
  await engine.tick(clock.now());
  await engine.tick(clock.now() + 200);
  await engine.tick(clock.now() + 2000);
  assert.equal(effects, 1);
  assert.equal(engine.get(run.id).status, "done");
  const actions = db.all("actions");
  assert.equal(actions.length, 1);
});

test("start is idempotent for a given id", async () => {
  const { engine } = makeEngine();
  engine.define({ name: "wf.simple", start: "s", steps: { s: { run: () => ({}) } } });
  const a = engine.start("wf.simple", { id: "run-fixed", subject: "x" });
  const b = engine.start("wf.simple", { id: "run-fixed", subject: "x" });
  assert.equal(a.id, b.id);
  assert.equal(b.status, "pending");
});

test("shadow runs record the action without executing it", async () => {
  const { engine, db, clock } = makeEngine();
  let effects = 0;
  engine.define({ name: "wf.shadow", start: "s", steps: { s: { kind: "call", effect: true, run: (ctx) => { const r = ctx.effect("prompt", "target", {}, () => { effects += 1; return { sent: true }; }); return { output: r }; } } } });
  const run = engine.start("wf.shadow", { subject: "s5", shadow: true });
  await engine.tick(clock.now());
  assert.equal(effects, 0);
  assert.equal(engine.get(run.id).shadow, 1);
  const action = db.all("actions")[0];
  assert.deepEqual(JSON.parse(action.result), { shadow: true });
});

test("ambiguous intent rows are settled by the recovery hook", async () => {
  const seen = [];
  const { engine, db, clock } = makeEngine({
    recovery: ({ run, step }) => { seen.push(step.step_id); return "done"; }
  });
  engine.define({ name: "wf.recover", start: "s1", steps: { s1: { kind: "call", effect: true, next: "s2", run: () => ({ done: true }) }, s2: { run: () => ({ done: true }) } } });
  const run = engine.start("wf.recover", { subject: "s6" });
  db.insert("steps", { run_id: run.id, step_id: "s1", attempt: 1, kind: "call", status: "intent", intent_at: clock.now() - 60_000, input_json: null, output_json: null, idem_key: "k" });
  db.update("runs", { id: run.id }, { status: "running", current_step: "s1" });
  await engine.tick(clock.now());
  assert.deepEqual(seen, ["s1"]);
  assert.equal(engine.get(run.id).status, "done");
});

test("deadline turns into a failed run and a dlq row", async () => {
  const { engine, clock, db } = makeEngine();
  engine.define({ name: "wf.deadline", start: "s", steps: { s: { run: () => ({ wait: 60_000 }) } } });
  const run = engine.start("wf.deadline", { subject: "s7", deadline: clock.now() + 1000 });
  await engine.tick(clock.now());
  assert.equal(engine.get(run.id).status, "waiting");
  clock.add(2000);
  await engine.tick(clock.now());
  assert.equal(engine.get(run.id).status, "failed");
  assert.match(engine.get(run.id).error, /deadline/);
  assert.equal(db.all("dlq").length, 1);
});

test("cancel stops a run and drops its timers", async () => {
  const { engine, clock, db } = makeEngine();
  engine.define({ name: "wf.cancel", start: "s", steps: { s: { run: () => ({ wait: 10_000 }) } } });
  const run = engine.start("wf.cancel", { subject: "s8" });
  await engine.tick(clock.now());
  assert.equal(db.all("timers").length, 1);
  engine.cancel(run.id, "user asked");
  assert.equal(engine.get(run.id).status, "cancelled");
  assert.equal(db.all("timers").length, 0);
});

test("two runs on the same subject both progress without deadlock", async () => {
  const { engine, clock } = makeEngine();
  engine.define({ name: "wf.multi", start: "s", steps: { s: { run: () => ({ done: true }) } } });
  const a = engine.start("wf.multi", { subject: "same" });
  const b = engine.start("wf.multi", { subject: "same" });
  await engine.tick(clock.now());
  assert.equal(engine.get(a.id).status, "done");
  assert.equal(engine.get(b.id).status, "done");
});

test("stats counts runs by status and unresolved dlq", async () => {
  const { engine, clock } = makeEngine({ maxAttempts: 1 });
  engine.define({ name: "wf.ok", start: "s", steps: { s: { run: () => ({}) } } });
  engine.define({ name: "wf.bad", start: "s", steps: { s: { run: () => ({ fail: "x" }) } } });
  engine.start("wf.ok", { subject: "a" });
  engine.start("wf.bad", { subject: "b" });
  await engine.tick(clock.now());
  const stats = engine.stats();
  assert.equal(stats.done, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.dlq, 1);
});
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "../lib/features/steward/core/db.js";
import { createTraceStore } from "../lib/core/trace.js";

function tmpBase() {
  const t = process.env.TEMP || process.env.TMP;
  if (t !== undefined && path.isAbsolute(t)) return t;
  const home = process.env.USERPROFILE || os.homedir() || ".";
  return path.join(home, "AppData", "Local", "Temp");
}

function tmpdir() {
  const base = tmpBase();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "polaris-trace-"));
}

test("memory-only trace: begin/span/effect/finish/list/waterfall", () => {
  const store = createTraceStore({ clock: () => 1000 });
  const t = store.begin({ trigger: "host/tick", steward: "win-main", subject: "host" });
  assert.equal(t.id, "t-1");
  assert.equal(t.status, "running");
  const s = t.span({ kind: "cap", ref: "judge.heap.critical" });
  const sp = s.end("ok", 7, { heapPct: 93 });
  assert.equal(sp.ms, 7);
  assert.deepEqual(sp.attrs, { heapPct: 93 });
  const e = t.effect(sp.id, { cap: "judge.heap.critical", params: { facts: { heapPct: 93 } }, ok: true, ms: 7 });
  assert.equal(e.cap, "judge.heap.critical");
  const finished = t.finish("ok");
  assert.equal(finished.spanCount, 1);
  assert.equal(finished.ok, true);

  const list = store.list({});
  assert.equal(list.length, 1);
  assert.equal(list[0].trigger, "host/tick");
  assert.equal(list[0].stewardId, "win-main");

  const w = store.waterfall("t-1");
  assert.equal(w.spans.length, 1);
  assert.equal(w.spans[0].effects.length, 1);
  assert.equal(w.effects.length, 1);

  const stats = store.stats();
  assert.equal(stats.backend, "memory");
  assert.equal(stats.traces, 1);
  assert.equal(stats.spans, 1);
  assert.equal(stats.effects, 1);

  store.begin({ trigger: "host/tick" });
  const done = store.begin({ trigger: "manual" });
  done.finish("failed", "boom");
  assert.equal(store.list({ ok: true }).length, 2);
  assert.equal(store.list({ status: "failed" }).length, 1);
  assert.equal(store.since("t-1", 10).length, 2);
  assert.equal(store.get("t-1").trigger, "host/tick");
  store.dispose();
});

test("persistent trace store hydrates spans and effects", () => {
  const dir = tmpdir();
  const db = createDb({ dir, log: () => {}, backend: "json" });
  const store = createTraceStore({ db, clock: () => 2000 });
  const t = store.begin({ trigger: "wf.host.protect", steward: "win-main", subject: "host" });
  const s = t.span({ kind: "tree", ref: "plan.host.protect" });
  t.effect(s.id, { cap: "notify.lark", extId: "om_123", ok: true, ms: 312 });
  t.intent({ cap: "notify.lark", carrier: "lark.im", payload: "notice", target: "owner", protocol: "fire", route: "allow", grant: "act", decision: "run", ok: true });
  s.end("ok", 320);
  t.finish("ok");
  assert.equal(store.stats().persisted > 0, true);
  store.dispose();
  db.close();

  const db2 = createDb({ dir, log: () => {}, backend: "json" });
  const store2 = createTraceStore({ db: db2, clock: () => 3000 });
  const w = store2.waterfall("t-1");
  assert.ok(w !== undefined);
  assert.equal(w.spans.length, 1);
  assert.equal(w.spans[0].kind, "tree");
  assert.equal(w.effects.length, 1);
  assert.equal(w.effects[0].extId, "om_123");
  assert.equal(w.intents.length, 1);
  assert.equal(w.intents[0].grant, "act");
  assert.equal(store2.list({}).length, 1);
  const found = store2.byExtId("om_123");
  assert.equal(found.length, 1);
  assert.equal(found[0].trace.id, "t-1");
  assert.equal(store2.history({ limit: 10 }).length, 1);
  // new traces must not reuse ids of hydrated ones
  const fresh = store2.begin({ trigger: "host/tick" });
  assert.equal(fresh.id, "t-2");
  store2.dispose();
  db2.close();
});

test("prune drops old traces with their spans and effects", () => {
  const dir = tmpdir();
  const db = createDb({ dir, log: () => {}, backend: "json" });
  const old = createTraceStore({ db, clock: () => 1000 });
  const t1 = old.begin({ trigger: "old" });
  const s1 = t1.span({ kind: "cap", ref: "x" });
  t1.effect(s1.id, { cap: "x", ok: true });
  s1.end("ok", 1);
  t1.finish("ok");
  old.dispose();
  db.close();

  const db2 = createDb({ dir, log: () => {}, backend: "json" });
  // backdate the persisted row so the retention window catches it
  const row = db2.get("traces", { id: "t-1" });
  db2.update("traces", { id: "t-1" }, { started_at: Date.now() - 40 * 86400000 });
  const store = createTraceStore({ db: db2, clock: () => 5000 });
  assert.equal(row.id, "t-1");
  const result = store.prune({ keepDays: 30 });
  assert.equal(result.removed, 1);
  assert.equal(db2.all("traces").length, 0);
  assert.equal(db2.all("spans").length, 0);
  assert.equal(db2.all("effects").length, 0);
  store.dispose();
  db2.close();
});

test("trace ids sort by numeric suffix and intents are queryable", () => {
  const store = createTraceStore({});
  for (let i = 0; i < 12; i += 1) {
    const t = store.begin({ trigger: "host/tick" });
    t.intent({ cap: "query.host", payload: "query", ok: i % 2 === 0, preview: false, reason: i % 2 === 0 ? "" : "budget-exhausted" });
    t.finish(i % 2 === 0 ? "ok" : "denied");
  }
  assert.equal(store.since("t-9", 50).length, 3);
  const all = store.list({ limit: 50 });
  assert.equal(all[0].id, "t-12");
  const w = store.waterfall("t-4");
  assert.equal(w.trace.ok, false);
  assert.equal(w.trace.status, "denied");
  assert.equal(w.intents.length, 1);
  store.dispose();
});

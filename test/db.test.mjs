import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "../lib/features/steward/core/db.js";
import { TABLES } from "../lib/features/steward/core/schema.js";

const BACKENDS = ["sqlite", "json"];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "polaris-db-"));
}

test("schema lists the design tables plus the task queue", () => {
  assert.equal(Object.keys(TABLES).length, 17);
  for (const name of ["hosts", "modules", "subjects", "signals", "routing", "runs", "steps", "timers", "actions", "approvals", "dlq", "settings_history", "tasks", "intents", "traces", "spans", "effects"]) {
    assert.ok(TABLES[name] !== undefined, name + " missing");
  }
});

for (const backend of BACKENDS) {
  test(backend + ": insert auto id, get, update, find, remove", () => {
    const db = createDb({ dir: tmpDir(), backend, log: () => {} });
    assert.equal(db.backend, backend);
    const first = db.insert("signals", { host_id: "h1", kind: "agent/stall", subject: "a1", severity: "warning", at: 100 });
    const second = db.insert("signals", { host_id: "h1", kind: "agent/error", subject: "a2", severity: "error", at: 101 });
    assert.equal(first.id, 1);
    assert.equal(second.id, 2);
    assert.equal(db.get("signals", { id: 1 }).kind, "agent/stall");
    db.update("signals", { id: 1 }, { severity: "error", consumed_by: "run-1" });
    const updated = db.get("signals", { id: 1 });
    assert.equal(updated.severity, "error");
    assert.equal(updated.consumed_by, "run-1");
    assert.equal(db.find("signals", { subject: "a2" }).length, 1);
    assert.equal(db.all("signals").length, 2);
    db.remove("signals", { id: 2 });
    assert.equal(db.all("signals").length, 1);
    db.closeSafely();
  });

  test(backend + ": objects and booleans survive a round trip", () => {
    const dir = tmpDir();
    const db = createDb({ dir, backend, log: () => {} });
    db.insert("runs", {
      id: "r1", wf: "wf.test", wf_version: 1, trace_id: "t1", host_id: "h1", module_id: "ev",
      subject: "a1", status: "running", vars_json: { count: 2, nested: { ok: true } }, current_step: "s1",
      shadow: 1, created_at: 1, updated_at: 2
    });
    const row = db.get("runs", { id: "r1" });
    assert.deepEqual(row.vars_json, { count: 2, nested: { ok: true } });
    assert.equal(row.shadow, 1);
    assert.deepEqual(row.trace_id, "t1");
    db.flush();
    db.closeSafely();

    const reopened = createDb({ dir, backend, log: () => {} });
    const again = reopened.get("runs", { id: "r1" });
    assert.deepEqual(again.vars_json, { count: 2, nested: { ok: true } });
    assert.equal(again.wf, "wf.test");
    reopened.closeSafely();
  });

  test(backend + ": composite primary key (steps) replaces instead of duplicating", () => {
    const db = createDb({ dir: tmpDir(), backend, log: () => {} });
    db.insert("steps", { run_id: "r1", step_id: "s1", attempt: 1, kind: "call", status: "intent", intent_at: 5 });
    db.insert("steps", { run_id: "r1", step_id: "s1", attempt: 1, kind: "call", status: "done", intent_at: 5, done_at: 6 });
    const rows = db.all("steps");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "done");
    db.closeSafely();
  });

}

test("json backend: mutations replayed from ops log when snapshot is stale", () => {
  const dir = tmpDir();
  const db = createDb({ dir, backend: "json", log: () => {} });
  db.insert("signals", { id: 1, kind: "a", at: 1 });
  db.flush();
  db.insert("signals", { id: 2, kind: "b", at: 2 });
  db.closeSafely();
  const reopened = createDb({ dir, backend: "json", log: () => {} });
  assert.equal(reopened.all("signals").length, 2);
  reopened.closeSafely();
});
test("json backend: corrupt snapshot is ignored, good ops lines still replay", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "steward.db.json"), "{not json");
  const op = { t: "set", table: "signals", key: "1", row: { id: 1, kind: "x" }, seq: 1 };
  fs.writeFileSync(path.join(dir, "steward.ops.jsonl"), "garbage\n" + JSON.stringify(op) + "\n");
  const db = createDb({ dir, backend: "json", log: () => {} });
  assert.equal(db.all("signals").length, 1);
  db.closeSafely();
});

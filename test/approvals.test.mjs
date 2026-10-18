import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "../lib/features/steward/core/db.js";
import { createApprovalStore } from "../lib/features/steward/core/approvals.js";

const NOW = 1_700_000_000_000;

function make(clockValue) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-ap-"));
  const db = createDb({ dir, backend: "json" });
  const clock = typeof clockValue === "function" ? clockValue : () => clockValue;
  const store = createApprovalStore({ db, clock });
  return { dir, db, store };
}

test("approval create returns an open record", () => {
  const { store } = make(NOW);
  const row = store.create({ title: "重启吗", detail: "堆 3.9G", subject: "host", level: "critical", ttlMs: 60_000 });
  assert.equal(row.status, "open");
  assert.equal(row.title, "重启吗");
  assert.equal(row.detail, "堆 3.9G");
  assert.equal(row.subject, "host");
  assert.equal(row.deadline, NOW + 60_000);
  assert.equal(store.listOpen().length, 1);
});

test("answer approves exactly once", () => {
  const { store } = make(NOW);
  const row = store.create({ title: "t" });
  assert.equal(store.answer(row.id, "approve", "me").ok, true);
  assert.equal(store.get(row.id).status, "approved");
  assert.equal(store.get(row.id).answerBy, "me");
  const second = store.answer(row.id, "reject", "me");
  assert.equal(second.ok, false);
  assert.equal(second.reason, "not-open");
});

test("answer is blocked by a stale version", () => {
  const { store } = make(NOW);
  const row = store.create({ title: "t" });
  const stale = store.answer(row.id, "approve", "a", row.version + 5);
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "stale");
  const fresh = store.answer(row.id, "approve", "a", row.version);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.approval.version, row.version + 1);
});

test("expire only touches open rows and sweep respects deadline", () => {
  let clock = NOW;
  const { store } = make(() => clock);
  const a = store.create({ title: "a", ttlMs: 1000 });
  const b = store.create({ title: "b", ttlMs: 999_999 });
  clock = NOW + 5000;
  assert.equal(store.sweep(), 1);
  assert.equal(store.get(a.id).status, "expired");
  assert.equal(store.get(b.id).status, "open");
  assert.equal(store.expire(a.id).ok, false);
});

test("unknown approval returns null / not-found", () => {
  const { store } = make(NOW);
  assert.equal(store.get(9999), null);
  assert.equal(store.answer(9999, "approve").reason, "not-found");
});
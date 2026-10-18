import test from "node:test";
import assert from "node:assert/strict";
import { createTasks } from "../lib/features/steward/tasks.js";

function fakeDb() {
  const rows = new Map();
  let seq = 0;
  return {
    insert(_table, row) { const id = ++seq; const rec = Object.assign({ id }, row); rows.set(id, rec); return Object.assign({}, rec); },
    update(_table, pk, fields) { const rec = rows.get(Number(pk.id)); if (rec === undefined) return undefined; Object.assign(rec, fields); return Object.assign({}, rec); },
    get(_table, pk) { const rec = rows.get(Number(pk.id)); return rec === undefined ? undefined : Object.assign({}, rec); },
    all() { return Array.from(rows.values()).map((r) => Object.assign({}, r)); }
  };
}

function harness(opts) {
  const db = fakeDb();
  const actions = [];
  const store = { agents: new Map(), pushAction: (a) => actions.push(a), pushSignal: (s) => actions.push(Object.assign({ kind: "signal" }, s)) };
  const gate = opts.gate === undefined ? () => ({ ok: true, level: "L3", needs: "L3" }) : opts.gate;
  const tasks = createTasks({
    scope: { ctx: { get: () => undefined } },
    db, store, log: () => {}, readSettings: () => opts.settings, policy: { gate },
    chat: opts.chat, prompter: opts.prompter
  });
  return { tasks, actions };
}

const echoSettings = () => ({ actMode: "echo", tasks: { concurrency: 1, autoDispatch: true, maxAttempts: 3 } });

test("auto dispatch behind a lower actLevel logs the denial once, not every tick", async () => {
  const settings = echoSettings();
  const h = harness({ settings, gate: () => ({ ok: false, reason: "below-level", level: "L2", needs: "L3" }) });
  h.tasks.create({ title: "换截图" });
  await h.tasks.tick();
  await h.tasks.tick();
  await h.tasks.tick();
  const denied = h.actions.filter((a) => String(a.message).indexOf("被授权层拦下") > 0);
  assert.equal(denied.length, 1);
  assert.equal(h.tasks.summary().queued, 1);
});

test("echo previews do not occupy the concurrency slot or count as attempts", async () => {
  const settings = echoSettings();
  const h = harness({ settings });
  h.tasks.create({ title: "一" });
  h.tasks.create({ title: "二" });
  assert.equal(await h.tasks.tick(), 2);
  const rows = h.tasks.list({});
  assert.deepEqual(rows.map((r) => r.status), ["assigned", "assigned"]);
  assert.deepEqual(rows.map((r) => r.attempts), [0, 0]);
  const echoes = h.actions.filter((a) => a.kind === "echo").length;
  assert.equal(echoes, 2);
  await h.tasks.tick();
  assert.equal(h.actions.filter((a) => a.kind === "echo").length, echoes);
});

test("live failures count attempts and close at maxAttempts", async () => {
  const settings = echoSettings();
  settings.actMode = "live";
  const sent = [];
  const h = harness({ settings, prompter: { prompt: async (_ctx, req) => { sent.push(req.sessionId); return { ok: false, reason: "busy" }; } } });
  const id = h.tasks.create({ title: "跑一轮", target: "session:s-1" }).task.id;
  await h.tasks.tick();
  assert.equal(h.tasks.get(id).attempts, 1);
  assert.equal(h.tasks.get(id).status, "queued");
  await h.tasks.tick();
  await h.tasks.tick();
  const closed = h.tasks.get(id);
  assert.equal(closed.status, "failed");
  assert.equal(closed.attempts, 3);
  assert.deepEqual(Array.from(new Set(sent)), ["s-1"]);
});

test("closed tasks cannot switch state again", () => {
  const h = harness({ settings: echoSettings() });
  const id = h.tasks.create({ title: "三" }).task.id;
  assert.equal(h.tasks.cancel(id).ok, true);
  assert.equal(h.tasks.complete(id).reason, "already-closed");
  assert.equal(h.tasks.fail(id).reason, "already-closed");
  assert.equal(h.tasks.cancel(id).reason, "already-closed");
});

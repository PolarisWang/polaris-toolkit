import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRollup, renderRollup } from "../lib/features/steward/session/rollup.js";
import { computePressure, shouldRotate, DEFAULT_LIMITS } from "../lib/features/steward/session/pressure.js";
import { buildHandoff } from "../lib/features/steward/session/handoff.js";
import { createSessionBinder } from "../lib/features/steward/session/bootstrap.js";

const NOW = 1_700_000_000_000;

test("rollup aggregates agents, modules and attention", () => {
  const rollup = buildRollup({
    now: NOW,
    agents: [
      { id: "a1", title: "ev", moduleId: "ev", status: "running", silenceMs: 1000 },
      { id: "a2", title: "cb2", moduleId: "cb2", status: "stalled", silenceMs: 900_000 },
      { id: "a3", title: "x", moduleId: "ev", status: "idle", silenceMs: 10_000, question: { callId: "q1" } },
      { id: "a4", status: "idle", silenceMs: 0 }
    ],
    signals: [{ kind: "agent.stalled", subject: "a2", severity: "warning", at: NOW - 1000 }, { kind: "old", subject: "a1", severity: "info", at: NOW - 900_000 }],
    runs: [{ id: "r1", wf: "wf.notify", subject: "s", status: "waiting", current_step: "send" }, { id: "r2", wf: "wf.ask", subject: "s", status: "failed", current_step: "wait" }],
    approvals: [{ id: "ap1", title: "要不要重启", status: "open", deadline: NOW + 1000 }],
    health: { heapPct: 42 },
    windowMs: 300_000
  });
  assert.equal(rollup.agents.total, 4);
  assert.equal(rollup.agents.running, 1);
  assert.equal(rollup.agents.stalled, 1);
  assert.equal(rollup.agents.byModule.ev, 2);
  assert.equal(rollup.agents.byModule.unassigned, 1);
  assert.equal(rollup.attention.length, 2);
  assert.equal(rollup.signals.total, 1);
  assert.equal(rollup.runs.open, 1);
  assert.equal(rollup.runs.failed, 1);
  assert.equal(rollup.approvals.length, 1);
  assert.equal(rollup.health.heapPct, 42);
});

test("rollup tolerates empty input", () => {
  const rollup = buildRollup({ now: NOW });
  assert.equal(rollup.agents.total, 0);
  assert.equal(rollup.attention.length, 0);
  assert.equal(renderRollup(rollup).includes("agent 0"), true);
});

test("renderRollup includes attention and approvals", () => {
  const text = renderRollup(buildRollup({
    now: NOW,
    agents: [{ id: "a1", title: "ev", moduleId: "ev", status: "stalled", silenceMs: 600_000 }],
    approvals: [{ id: "ap", title: "重启吗", status: "open" }],
    signals: [{ kind: "agent.stalled", subject: "a1", severity: "warning", at: NOW }]
  }));
  assert.match(text, /需要关注/);
  assert.match(text, /ev/);
  assert.match(text, /待批 1 项/);
});

test("pressure grows with fill and hits hard threshold", () => {
  const low = computePressure({ role: "lead", turns: 10, tokens: 0, rollupChars: 0, now: NOW });
  const high = computePressure({ role: "lead", turns: 180, tokens: 0, rollupChars: 4000, now: NOW });
  assert.equal(low.pressure < high.pressure, true);
  assert.equal(high.fill, 0.9);
  assert.equal(high.pressure > 0.6, true);
});

test("pressure uses the worse of turns and tokens", () => {
  const m = computePressure({ role: "module", turns: 10, tokens: 170_000 });
  assert.equal(Math.round(m.fill * 100) / 100, Math.round((170_000 / DEFAULT_LIMITS.module.ceilingTokens) * 100) / 100);
});

test("compactRecency decays over half an hour", () => {
  const fresh = computePressure({ role: "lead", turns: 0, compactAgeMs: 0 });
  const old = computePressure({ role: "lead", turns: 0, compactAgeMs: 1_800_000 });
  assert.equal(fresh.compactRecency, 1);
  assert.equal(old.compactRecency, 0);
});

test("shouldRotate respects floor, hard-fill, debounce", () => {
  assert.equal(shouldRotate({ role: "lead", turns: 5, now: NOW }).reason, "below-floor");
  const hard = shouldRotate({ role: "lead", turns: 10, tokens: 400_000, now: NOW });
  assert.equal(hard.rotate, true);
  assert.equal(hard.reason, "hard-fill");
  const debounced = shouldRotate({ role: "lead", turns: 200, tokens: 400_000, now: NOW, lastRotateAt: NOW - 1000 });
  assert.equal(debounced.rotate, false);
  assert.equal(debounced.reason, "debounce");
  const byPressure = shouldRotate({ role: "module", turns: 70, tokens: 0, compactAgeMs: 0, rollupChars: 4000, now: NOW, lastRotateAt: NOW - 3_600_000 });
  assert.equal(byPressure.rotate, true);
  assert.equal(byPressure.reason, "pressure");
});

test("shouldRotate warns when rotating too soon", () => {
  const decision = shouldRotate({ role: "lead", turns: 10, tokens: 400_000, now: NOW, lastRotateAt: NOW - 700_000 });
  assert.equal(decision.warn, true);
});

test("handoff includes stance, pending and hints", () => {
  const text = buildHandoff({
    now: NOW,
    reason: "pressure",
    rollup: buildRollup({ now: NOW, agents: [{ id: "a1", title: "ev", moduleId: "ev", status: "running" }] }),
    pending: [{ id: "ap1", title: "重启吗", kind: "approval", subject: "host", deadline: NOW + 5000 }],
    decisions: [{ id: "d1", summary: "拒绝重启" }]
  });
  assert.match(text, /总管交接摘要/);
  assert.match(text, /当前态势/);
  assert.match(text, /未决事项/);
  assert.match(text, /重启吗/);
  assert.match(text, /拒绝重启/);
});

test("binder reuses an existing session", () => {
  const agent = { id: "ag1", session: { id: "s1" } };
  const binder = createSessionBinder({});
  const ctx = { get: () => ({ get: (id) => (id === "s1" ? agent : undefined) }) };
  const result = binder.ensure(ctx, { sessionId: "s1" });
  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(binder.current(), agent);
});

test("binder reports failure instead of throwing", () => {
  const binder = createSessionBinder({});
  assert.equal(binder.ensure({ get: () => undefined }, {}).ok, false);
  const throwing = { get: () => ({ get() { throw new Error("boom"); }, create() { throw new Error("nope"); } }) };
  const result = binder.ensure(throwing, { sessionId: "s1" });
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /nope/);
});
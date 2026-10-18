import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateExpr, matchEvent, severityRank } from "../lib/features/steward/rules/expr.js";
import { buildRuleSet, loadBuiltin, rulesHash, normalizeRule } from "../lib/features/steward/rules/loader.js";
import { createEvaluator, resolveConflicts } from "../lib/features/steward/rules/evaluator.js";

const silent = () => {};

test("expr: comparison, membership, existence, regex, logic", () => {
  const facts = { status: "running", silenceMs: 600000, module: "ev", question: { id: "q" }, title: "ev-123" };
  assert.equal(evaluateExpr({ eq: ["status", "running"] }, facts), true);
  assert.equal(evaluateExpr({ ne: ["status", "idle"] }, facts), true);
  assert.equal(evaluateExpr({ gt: ["silenceMs", 1000] }, facts), true);
  assert.equal(evaluateExpr({ lt: ["silenceMs", 1000] }, facts), false);
  assert.equal(evaluateExpr({ in: ["module", ["ev", "cb2"]] }, facts), true);
  assert.equal(evaluateExpr({ nin: ["module", ["ev"]] }, facts), false);
  assert.equal(evaluateExpr({ exists: "question" }, facts), true);
  assert.equal(evaluateExpr({ absent: "question" }, facts), false);
  assert.equal(evaluateExpr({ regex: ["title", "^ev-"] }, facts), true);
  assert.equal(evaluateExpr({ all: [{ eq: ["status", "running"] }, { gte: ["silenceMs", 1000] }] }, facts), true);
  assert.equal(evaluateExpr({ any: [{ eq: ["status", "idle"] }, { eq: ["module", "ev"] }] }, facts), true);
  assert.equal(evaluateExpr({ not: { eq: ["status", "idle"] } }, facts), true);
  assert.equal(evaluateExpr({ const: true }, facts), true);
  assert.equal(evaluateExpr(undefined, facts), true);
});

test("expr: bad expressions are rejected loudly", () => {
  assert.throws(() => evaluateExpr({ nope: ["a", 1] }, {}), /unknown rule operator/);
  assert.throws(() => evaluateExpr({ eq: ["a"] }, {}), /needs \[field, value\]/);
  assert.throws(() => evaluateExpr({ eq: ["a", 1], ne: ["b", 2] }, {}), /exactly one operator/);
});

test("matchEvent supports exact, glob and star", () => {
  assert.equal(matchEvent("*", "agent/error"), true);
  assert.equal(matchEvent("agent/*", "agent/error"), true);
  assert.equal(matchEvent("agent/*", "host/tick"), false);
  assert.equal(matchEvent("agent/error", "agent/error"), true);
});

test("severity ordering", () => {
  assert.ok(severityRank("critical") > severityRank("error"));
  assert.ok(severityRank("error") > severityRank("warning"));
  assert.ok(severityRank("warning") > severityRank("info"));
  assert.equal(severityRank("bogus"), 0);
});

test("builtin rules load, validate and hash deterministically", () => {
  const rules = loadBuiltin(silent);
  assert.ok(rules.length >= 10, "expected builtin rules, got " + rules.length);
  const ids = new Set(rules.map((r) => r.id));
  for (const id of ["agent.stalled", "agent.error", "host.heap.critical", "host.crash.new", "social.question.stale"]) assert.ok(ids.has(id), id);
  const a = buildRuleSet({ builtin: rules, log: silent });
  const b = buildRuleSet({ builtin: rules.slice().reverse(), log: silent });
  assert.equal(a.hash, b.hash);
  assert.equal(a.hash, rulesHash(rules));
  assert.equal(a.hash.length, 16);
});

test("overrides can disable and re-tune builtin rules, or add new ones", () => {
  const rules = loadBuiltin(silent);
  const set = buildRuleSet({
    builtin: rules,
    log: silent,
    overrides: {
      "agent.error": { enabled: false },
      "agent.stalled": { severity: "critical", cooldownSec: 60, params: { text: "custom" } },
      "custom.rule": { title: "custom", when: "agent/tick", if: { eq: ["status", "idle"] }, actions: [{ workflow: "wf.notify" }] }
    }
  });
  const byId = new Map(set.rules.map((r) => [r.id, r]));
  assert.equal(byId.get("agent.error").enabled, false);
  assert.equal(byId.get("agent.stalled").severity, "critical");
  assert.equal(byId.get("agent.stalled").cooldownSec, 60);
  assert.deepEqual(byId.get("agent.stalled").params, { text: "custom" });
  assert.equal(byId.get("custom.rule").file, "override");
});

test("normalizeRule rejects malformed rules", () => {
  assert.throws(() => normalizeRule({}), /needs an id/);
  assert.throws(() => normalizeRule({ id: "x", actions: [{ params: {} }] }), /without workflow/);
  assert.throws(() => normalizeRule({ id: "x", if: { bogus: [] } }), /unknown rule operator/);
});

test("evaluator fires a rule, then honours its cooldown", () => {
  const set = buildRuleSet({ builtin: loadBuiltin(silent), log: silent });
  let now = 1_000_000;
  const evaluator = createEvaluator({ ruleSet: set, clock: () => now, log: silent });
  const event = { type: "agent/tick", subject: "a1", payload: { status: "running", silenceMs: 600000 } };
  const first = evaluator.evaluate(event);
  assert.equal(first.decisions.length, 1);
  assert.equal(first.decisions[0].ruleId, "agent.stalled");
  const second = evaluator.evaluate(event);
  assert.equal(second.decisions.length, 0);
  assert.equal(second.suppressed[0].reason, "cooldown");
  now += 901_000;
  const third = evaluator.evaluate(event);
  assert.equal(third.decisions.length, 1);
});

test("evaluator keeps only the most severe decision per subject and workflow", () => {
  const set = buildRuleSet({
    builtin: [
      normalizeRule({ id: "a.info", when: "host/tick", severity: "info", if: { const: true }, actions: [{ workflow: "wf.notify" }], cooldownSec: 0 }),
      normalizeRule({ id: "b.critical", when: "host/tick", severity: "critical", if: { const: true }, actions: [{ workflow: "wf.notify" }], cooldownSec: 0 })
    ],
    log: silent
  });
  const evaluator = createEvaluator({ ruleSet: set, clock: () => 1, log: silent });
  const result = evaluator.evaluate({ type: "host/tick", subject: "host-1", payload: {} });
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].ruleId, "b.critical");
  assert.ok(result.suppressed.some((s) => s.reason === "conflict"));
});

test("resolveConflicts prefers severity and records the loser", () => {
  const suppressed = [];
  const kept = resolveConflicts([
    { ruleId: "low", subject: "s", severity: "info", actions: [{ workflow: "wf.x" }] },
    { ruleId: "high", subject: "s", severity: "critical", actions: [{ workflow: "wf.x" }] },
    { ruleId: "other", subject: "s", severity: "info", actions: [{ workflow: "wf.y" }] }
  ], suppressed);
  assert.deepEqual(kept.map((k) => k.ruleId).sort(), ["high", "other"]);
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0].ruleId, "low");
});

test("shadow rules are marked but still evaluated", () => {
  const set = buildRuleSet({
    builtin: [normalizeRule({ id: "shadow.rule", when: "*", shadowHours: 24, if: { const: true }, actions: [{ workflow: "wf.x" }] })],
    log: silent
  });
  const evaluator = createEvaluator({ ruleSet: set, clock: () => 5, log: silent });
  const result = evaluator.evaluate({ type: "agent/tick", subject: "s", payload: {} });
  assert.equal(result.decisions[0].shadow, true);
});

test("overrides load from a directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-rules-"));
  fs.mkdirSync(path.join(dir, "overrides"), { recursive: true });
  fs.writeFileSync(path.join(dir, "overrides", "agents.json"), JSON.stringify({ "agent.error": { enabled: false } }));
  const set = buildRuleSet({ builtin: loadBuiltin(silent), overrides: { "agent.error": { enabled: false } }, log: silent });
  assert.equal(set.rules.filter((r) => r.id === "agent.error")[0].enabled, false);
});

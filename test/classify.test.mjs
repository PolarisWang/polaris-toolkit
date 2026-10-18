import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClassifier, parseDecision, promptFor } from "../lib/features/steward/classify.js";

const MODULES = [
  { id: "ev", name: "EV 引擎", enabled: true, titles: ["ev"], workspaces: [] },
  { id: "dsh", name: "DSH", enabled: true, titles: ["dsh"], workspaces: [] },
  { id: "unassigned", name: "未归类", enabled: true, titles: [], workspaces: [] }
];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "polaris-classify-"));
}

function settings(extra) {
  return () => ({ classifier: Object.assign({ enabled: true, minConfidence: 0.55, maxPerTick: 2, timeoutMs: 5000, maxTokens: 120, ttlDays: 7, provider: "", model: "" }, extra || {}) });
}

function fakeCtx(answer, opts) {
  const o = opts || {};
  return {
    get(name) {
      if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "fake", model: "fake-1" }) };
      if (name === "llm") {
        return {
          async *stream() {
            if (o.throwOnStream) throw new Error("model exploded");
            yield { type: "text-delta", text: answer === undefined ? "" : answer };
            yield { type: "finish", reason: { kind: "stop" } };
          }
        };
      }
      return undefined;
    }
  };
}

test("parseDecision tolerates fences, chatter and out-of-range confidence", () => {
  const NL = String.fromCharCode(10);
  const FENCE = String.fromCharCode(96, 96, 96);
  const json = '{"module":"dsh","confidence":3,"reason":"  路径 是 dsh  "}';
  const fenced = FENCE + "json" + NL + json + NL + FENCE;
  const value = parseDecision("好的：" + NL + fenced, ["ev", "dsh"]);
  assert.deepEqual(value, { moduleId: "dsh", confidence: 1, reason: "路径 是 dsh" });
  const chatty = parseDecision('多余的话 {"module":"ev"} 后面还有字', ["ev", "dsh"]);
  assert.equal(chatty.moduleId, "ev", "takes the first JSON object out of chatter");
});

test("parseDecision rejects unknown modules and malformed output", () => {
  assert.equal(parseDecision('{"module":"nope","confidence":0.9}', ["ev", "dsh"]), undefined);
  assert.equal(parseDecision("no json here", ["dsh"]), undefined);
  assert.equal(parseDecision('{"module":"dsh",', ["dsh"]), undefined);
});

test("promptFor lists every enabled module and the agent cwd", () => {
  const prompt = promptFor(MODULES, { id: "a", cwd: "D:\\agent\\il2cpp", title: "unity 构建" });
  assert.ok(prompt.system.includes("ev") && prompt.system.includes("dsh"), "module ids in the system prompt");
  assert.ok(prompt.ids.includes("ev") && prompt.ids.includes("dsh"), "ids returned for validation");
  assert.ok(prompt.user.includes("il2cpp"), "cwd passed as the strongest evidence");
  assert.ok(prompt.user.includes("unity"), "title passed through");
});

test("classifier degrades to undefined without an llm service", async () => {
  const dir = tmpDir();
  try {
    const classifier = createClassifier({ ctx: { get: () => undefined }, dir, log: () => {}, readSettings: settings() });
    const decision = await classifier.classify({ id: "a", cwd: "D:\\agent\\dsh" }, MODULES);
    assert.equal(decision, undefined);
    assert.equal(classifier.peek({ id: "a", cwd: "D:\\agent\\dsh" }, MODULES), undefined);
    assert.match(String(classifier.stats().lastError), /no model route/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a confident answer is cached and reused by peek", async () => {
  const dir = tmpDir();
  try {
    const classifier = createClassifier({
      ctx: fakeCtx('{"module":"dsh","confidence":0.91,"reason":"polaris 仓库"}'),
      dir, log: () => {}, readSettings: settings()
    });
    const rec = { id: "a", cwd: "D:\\agent\\polaris-toolkit" };
    const decision = await classifier.classify(rec, MODULES);
    assert.equal(decision.moduleId, "dsh");
    assert.equal(decision.model, "fake/fake-1");
    const hit = classifier.peek(rec, MODULES);
    assert.equal(hit.moduleId, "dsh", "second pass comes from the cache");
    assert.ok(fs.existsSync(path.join(dir, "module-cache.json")), "cache file written");
    classifier.forget(rec, MODULES);
    assert.equal(classifier.peek(rec, MODULES), undefined, "forget forces a fresh judgement");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("low confidence and unassigned are not applied but are remembered", async () => {
  const dir = tmpDir();
  try {
    const classifier = createClassifier({
      ctx: fakeCtx('{"module":"dsh","confidence":0.2,"reason":"不确定"}'),
      dir, log: () => {}, readSettings: settings()
    });
    const rec = { id: "a", cwd: "D:\\unknown" };
    assert.equal(await classifier.classify(rec, MODULES), undefined);
    assert.equal(classifier.peek(rec, MODULES), undefined);
    assert.equal(classifier.stats().cached, 1, "negative result cached to avoid re-asking");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a throwing model never escapes classify", async () => {
  const dir = tmpDir();
  try {
    const classifier = createClassifier({ ctx: fakeCtx("", { throwOnStream: true }), dir, log: () => {}, readSettings: settings() });
    assert.equal(await classifier.classify({ id: "a", cwd: "D:\\x" }, MODULES), undefined);
    assert.match(String(classifier.stats().lastError), /exploded/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("disabled classifier does nothing at all", async () => {
  const dir = tmpDir();
  try {
    const classifier = createClassifier({ ctx: fakeCtx('{"module":"dsh","confidence":1}'), dir, log: () => {}, readSettings: settings({ enabled: false }) });
    assert.equal(await classifier.classify({ id: "a", cwd: "D:\\dsh" }, MODULES), undefined);
    assert.equal(classifier.peek({ id: "a", cwd: "D:\\dsh" }, MODULES), undefined);
    assert.equal(classifier.stats().calls, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
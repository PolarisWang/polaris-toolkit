import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDesktopChannel } from "../lib/features/steward/channels/desktop.js";
import { createFeishuChannel } from "../lib/features/steward/channels/feishu.js";
import { createNotifier } from "../lib/features/steward/actuators/notify.js";
import { createPrompter } from "../lib/features/steward/actuators/prompt.js";
import { createAnswerer } from "../lib/features/steward/actuators/answer.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "polaris-act-")); }

test("desktop channel always ok and bounded", async () => {
  const ch = createDesktopChannel({});
  for (let i = 0; i < 250; i += 1) await ch.send({ title: "t" + i, text: "x" });
  assert.equal(ch.recent().length, 200);
  assert.equal(ch.recent()[199].message.title, "t249");
});

test("feishu channel materializes templates and reports close code", async () => {
  const calls = [];
  const fakeSpawn = (cmd, args) => {
    calls.push({ cmd, args });
    const handlers = {};
    const child = { on(ev, fn) { handlers[ev] = fn; if (ev === "close") queueMicrotask(() => fn(0)); return child; }, kill() {} };
    return child;
  };
  const ch = createFeishuChannel({ spawn: fakeSpawn, args: ["send", "--text", "{text}", "--title", "{title}"] });
  const result = await ch.send({ title: "T", text: "hello", level: "warning" });
  assert.equal(result.ok, true);
  assert.equal(calls[0].cmd, "lark-cli");
  assert.deepEqual(calls[0].args, ["send", "--text", "hello", "--title", "T"]);
});

test("feishu channel never throws on spawn failure", async () => {
  const ch = createFeishuChannel({ spawn: () => { throw new Error("nope"); } });
  const result = await ch.send({ title: "T", text: "x" });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /nope/);
});

test("notifier filters by minSeverity and lark flag", async () => {
  const seen = [];
  const desktop = { id: "desktop", async send(m) { seen.push("d:" + m.title); return { ok: true }; } };
  const feishu = { id: "feishu", async send(m) { seen.push("f:" + m.title); return { ok: true }; } };
  const settings = { notify: { minSeverity: "warning", larkEnabled: false } };
  const n = createNotifier({ desktop, feishu, settings: () => settings });
  assert.equal((await n.send({ title: "info", level: "info" })).skipped, "below-threshold");
  await n.send({ title: "warn", level: "warning" });
  assert.deepEqual(seen, ["d:warn"]);
  settings.notify.larkEnabled = true;
  await n.send({ title: "err", level: "error" });
  assert.deepEqual(seen, ["d:warn", "d:err", "f:err"]);
});

test("notifier survives a throwing channel", async () => {
  const n = createNotifier({
    desktop: { id: "desktop", async send() { throw new Error("boom"); } },
    settings: () => ({ notify: { minSeverity: "info" } })
  });
  const result = await n.send({ title: "x", level: "error" });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].error.includes("boom"), true);
});

test("prompter reports unavailable controller without throwing", async () => {
  const p = createPrompter({});
  const result = await p.prompt({ get: () => undefined }, { sessionId: "s", content: "c" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "session-controller-unavailable");
});

test("prompter forwards requestId and maps remote errors", async () => {
  const seen = [];
  const ctx = { get: () => ({ async prompt(req) { seen.push(req); throw Object.assign(new Error("busy"), { code: "session/agent-busy" }); } }) };
  const result = await createPrompter({}).prompt(ctx, { sessionId: "s", content: "c", requestId: "r1" });
  assert.equal(result.reason, "session/agent-busy");
  assert.equal(seen[0].requestId, "r1");
});

test("answerer sends answers object and maps errors", async () => {
  const seen = [];
  const ctx = { get: () => ({ async answer(agent, callId, payload) { seen.push({ agent, callId, payload }); if (callId === "bad") throw new Error("BAD_ANSWER"); } }) };
  const a = createAnswerer({});
  assert.equal((await a.answer(ctx, { agent: "ag", callId: "c1", answers: ["yes"] })).ok, true);
  assert.deepEqual(seen[0].payload, { answers: ["yes"] });
  assert.equal((await a.answer(ctx, { agent: "ag", callId: "bad", answers: [] })).ok, false);
});

test("answerer degrades when userQuestions is missing", async () => {
  const a = createAnswerer({});
  const result = await a.answer({ get: () => undefined }, { agent: "ag", callId: "c", answers: [] });
  assert.equal(result.reason, "user-questions-unavailable");
});

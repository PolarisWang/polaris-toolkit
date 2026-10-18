import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentsSource } from "../lib/features/steward/sources/agents.js";
import { createStore } from "../lib/features/steward/core/store.js";

/**
 * refreshCwd 曾经读 item.cwd，但 sessions.list() 返回的是活 Session 对象
 * （cwd 在 session.header.cwd），导致"按 workspace 归类"整条链路静默失效。
 * 这里锁死三种真实形状：活 Session、老式扁平对象、带 meta.cwd 的对象。
 */
function build(sessions, agents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-agents-"));
  const store = createStore({ dir, log: () => {} });
  const titles = { get: () => undefined, refresh: async () => [] };
  const ctx = {
    agents: { list: () => agents || [], get: () => undefined },
    get(name) {
      if (name === "sessions") return { list: () => sessions };
      return undefined;
    }
  };
  return { store, source: createAgentsSource({ ctx, store, titles, log: () => {} }) };
}

test("refreshCwd reads cwd from the live session header", async () => {
  const { store, source } = build([{ id: "session-abc", header: { id: "session-abc", cwd: "D:/agent/cb2" } }]);
  store.touch("session-abc", "sync", {});
  const filled = await source.refreshCwd();
  assert.equal(filled, 1);
  assert.equal(store.agents.get("session-abc").cwd, "D:/agent/cb2");
});

test("refreshCwd still accepts flat session objects and meta.cwd", async () => {
  const { store, source } = build([
    { id: "plain-one", cwd: "D:/agent/plain" },
    { id: "session-meta", header: { id: "session-meta", meta: { cwd: "D:/agent/meta" } } }
  ]);
  store.touch("plain-one", "sync", {});
  store.touch("session-meta", "sync", {});
  const filled = await source.refreshCwd();
  assert.equal(filled, 2);
  assert.equal(store.agents.get("plain-one").cwd, "D:/agent/plain");
  assert.equal(store.agents.get("session-meta").cwd, "D:/agent/meta");
});

test("refreshCwd overwrites a stale cwd instead of keeping it forever", async () => {
  const { store, source } = build([{ id: "session-abc", header: { id: "session-abc", cwd: "D:/agent/new" } }]);
  const rec = store.touch("session-abc", "sync", {});
  rec.cwd = "D:/agent/old";
  await source.refreshCwd();
  assert.equal(store.agents.get("session-abc").cwd, "D:/agent/new");
});

test("refreshCwd tolerates a promise-returning sessions service and missing cwd", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-agents-"));
  const store = createStore({ dir, log: () => {} });
  const titles = { get: () => undefined, refresh: async () => [] };
  const source = createAgentsSource({
    ctx: { agents: { list: () => [] }, get: (name) => (name === "sessions" ? { list: async () => [{ id: "session-p", header: { id: "session-p", cwd: "D:/agent/p" } }] } : undefined) },
    store,
    titles,
    log: () => {}
  });
  store.touch("session-p", "sync", {});
  assert.equal(await source.refreshCwd(), 1);
  assert.equal(store.agents.get("session-p").cwd, "D:/agent/p");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { createChat } from "../lib/features/steward/session/chat.js";

// 主管会话的工作目录不能是宿主进程的 cwd：先看 session.cwd，再看第一个模块的工作区，最后退回用户主目录。
function harness({ cfgCwd = "", modulesList = [{ enabled: true, workspaces: ["D:/mod-ws"] }] } = {}) {
  const calls = [];
  const writes = [];
  const ctrl = {
    create: async (opts) => { calls.push(opts); return { sessionId: "sess-1" }; },
    rename: async () => ({}),
    prompt: async () => ({ accepted: true })
  };
  const chat = createChat({
    scope: { ctx: { get: (name) => (name === "sessionController" ? ctrl : undefined) }, settings: { set: (patch) => { writes.push(patch); } } },
    store: { pushAction: () => {} },
    log: () => {},
    readSettings: () => ({ session: { cwd: cfgCwd, preset: "", title: "T" } }),
    prompter: { prompt: async () => ({ ok: true }) },
    events: { read: () => ({ ok: true, entries: [] }) },
    modules: () => modulesList
  });
  return { chat, calls, writes };
}

test("chat create prefers session.cwd from settings", async () => {
  const h = harness({ cfgCwd: "D:/cfg-ws" });
  const r = await h.chat.create({ bootstrap: false });
  assert.equal(r.ok, true);
  assert.equal(r.cwd, "D:/cfg-ws");
  assert.equal(h.calls[0].cwd, "D:/cfg-ws");
});

test("chat create falls back to the first module workspace, not process.cwd()", async () => {
  const h = harness();
  const r = await h.chat.create({ bootstrap: false });
  assert.equal(r.cwd, "D:/mod-ws");
  assert.notEqual(r.cwd, process.cwd());
});

test("chat create falls back to the user home when nothing is configured", async () => {
  const h = harness({ modulesList: [] });
  const r = await h.chat.create({ bootstrap: false });
  assert.equal(r.cwd, homedir());
});

test("chat create still honours an explicit cwd", async () => {
  const h = harness({ cfgCwd: "D:/cfg-ws" });
  const r = await h.chat.create({ cwd: " D:/asked ", bootstrap: false });
  assert.equal(r.cwd, "D:/asked");
});

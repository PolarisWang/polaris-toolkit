/**
 * 集成测试：把整个工具包挂到假 ctx 上，走真实 HTTP handler 形状。
 *
 * 重点不是覆盖业务细节（那是 db/wf/rules/session 等单测的事），而是
 * 保证「挂载不崩、路由可用、事件能落到账本、dispose 干净」。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-home-"));
process.env.DSH_HOME = HOME;

const { FEATURES } = await import("../lib/features/index.js");
const { mountToolkit } = await import("../lib/core/host.js");

function makeCtx(overrides = {}) {
  const effects = [];
  const routes = [];
  const tools = [];
  const logs = [];
  const listeners = new Map();
  const ctx = {
    on(event, fn) {
      const arr = listeners.get(event) || [];
      arr.push(fn);
      listeners.set(event, arr);
      return () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };
    },
    emit(event, payload) { for (const fn of (listeners.get(event) || []).slice()) fn(payload); },
    logger: {
      info: (m) => logs.push("info " + m),
      warn: (m) => logs.push("warn " + m),
      error: (m) => logs.push("error " + m)
    },
    effect(fn) { const off = fn(); effects.push(off); return () => {}; },
    webServer: { register(opts) { routes.push(opts); return () => {}; } },
    tools: { register(tool) { tools.push(tool); return () => {}; } },
    agents: { list: () => [], get: () => undefined },
    get: () => undefined,
    ...overrides
  };
  return { ctx, effects, routes, tools, logs };
}

function mount(overrides) {
  const env = makeCtx(overrides);
  const result = mountToolkit(env.ctx, { features: {} }, {
    name: "polaris-toolkit",
    prefix: "/__polaris",
    displayName: "Polaris Toolkit",
    features: FEATURES
  });
  TOKEN = result.token;
  const handler = (name) => env.routes.filter((r) => r.path === "/__polaris/" + name)[0].handler;
  const toolkit = env.routes.filter((r) => r.path === "/__polaris")[0].handler;
  return { ...env, result, handler, toolkit };
}

function fakeRes() {
  return {
    statusCode: 0, headers: {}, body: "",
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(body) { this.body = body === undefined ? "" : String(body); }
  };
}

let TOKEN = "";

function fakeReq(method, url, body) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1:1" };
  if (TOKEN !== "") req.headers["x-polaris-token"] = TOKEN;
  if (body !== undefined) req.push(Buffer.from(JSON.stringify(body), "utf8"));
  req.push(null);
  return req;
}

async function call(handler, method, url, body) {
  const res = fakeRes();
  await handler(fakeReq(method, url, body), res);
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

async function json(res) { return JSON.parse(res.body); }

test("mounts both features without throwing", () => {
  const m = mount();
  assert.deepEqual(m.result.features, ["heap-guard", "steward"]);
  assert.equal(m.routes.length, 3);
  assert.equal(m.tools.length, 9);
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("state endpoint answers and carries every section", async () => {
  const m = mount();
  const res = await call(m.handler("steward"), "GET", "/__polaris/steward/api/state");
  assert.equal(res.statusCode, 200);
  const s = await json(res);
  assert.equal(s.ok, true);
  for (const key of ["health", "agents", "modules", "signals", "counters", "runs", "approvals", "rules", "control"]) {
    assert.ok(key in s, "state has " + key);
  }
  assert.ok(s.modules.length >= 5, "module buckets");
  assert.ok(s.rules.count >= 19, "capability instances");
  assert.ok(String(s.rules.hash).startsWith("plane-"), "plane hash");
  assert.ok(s.plane && Array.isArray(s.plane.stewards) && s.plane.stewards.some((st) => st.id === "watch" && st.enabled !== false), "builtin steward equipped");
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("observed agents land in the ledger and errors fire a rule", async () => {
  const m = mount();
  m.ctx.emit("agent/created", { agentId: "a1", sessionId: "session-x", status: "idle" });
  m.ctx.emit("agent/status", { agent: { id: "a1" }, status: "running" });
  let s = await json(await call(m.handler("steward"), "GET", "/__polaris/steward/api/state"));
  assert.equal(s.agents.length, 1);
  assert.equal(s.agents[0].status, "running");

  m.ctx.emit("agent/error", { agentId: "a1", message: "boom" });
  s = await json(await call(m.handler("steward"), "GET", "/__polaris/steward/api/state"));
  assert.ok(s.signals.some((x) => x.kind === "agent/error"), "error signal");

  // 能力平面：默认「带班」编制关闭，所以 agent/error 不建 trace；
  // 装备并打开它之后，同一个事件就会落一条 trace。
  const before = await json(await call(m.handler("steward"), "GET", "/__polaris/steward/api/trace?limit=20"));
  assert.equal(before.ok, true);
  assert.ok(Array.isArray(before.traces), "trace list");
  const armed = await json(await call(m.handler("steward"), "POST", "/__polaris/steward/api/settings", {
    patch: { plane: { stewards: [{ id: "agent", enabled: true, events: ["agent/tick", "agent/error"] }] } }
  }));
  assert.equal(armed.ok, true, "plane settings accepted");
  m.ctx.emit("agent/error", { agentId: "a1", message: "boom again" });
  await new Promise((r) => setTimeout(r, 40));
  const after = await json(await call(m.handler("steward"), "GET", "/__polaris/steward/api/trace?limit=20"));
  assert.ok(after.traces.length > before.traces.length, "plane traced the agent/error event");
  assert.ok(after.traces.some((tr) => tr.trigger === "agent/error"), "trace carries the trigger");
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("settings patch round-trips through the panel api", async () => {
  const m = mount();
  const set = await json(await call(m.handler("steward"), "POST", "/__polaris/steward/api/settings", { patch: { autoAct: true, notify: { larkEnabled: false } } }));
  assert.equal(set.ok, true);
  assert.equal(set.settings.autoAct, true);
  const back = await json(await call(m.handler("steward"), "GET", "/__polaris/steward/api/state"));
  assert.equal(back.control.autoAct, true);
  const off = await json(await call(m.handler("steward"), "POST", "/__polaris/steward/api/settings", { patch: { autoAct: false } }));
  assert.equal(off.settings.autoAct, false);
  for (const off1 of m.effects) { try { off1(); } catch { /* ignore */ } }
});

test("hostile host services degrade instead of crashing", async () => {
  const m = mount({
    get: () => { throw new Error("service lookup exploded"); },
    agents: { list: () => { throw new Error("agents exploded"); }, get: () => { throw new Error("get exploded"); } },
    on: () => { throw new Error("event bus exploded"); }
  });
  const res = await call(m.handler("steward"), "GET", "/__polaris/steward/api/state");
  assert.equal(res.statusCode, 200, "state still answers");
  const s = await json(res);
  assert.equal(s.ok, true);
  assert.ok(Array.isArray(s.degraded), "degraded list present");
  const tick = await call(m.handler("steward"), "GET", "/__polaris/steward/api/tick");
  assert.equal(tick.statusCode, 200, "tick still answers");
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("panel html contains the pyramid and the control buttons", async () => {
  const m = mount();
  const res = await call(m.handler("steward"), "GET", "/__polaris/steward/");
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes("大内总管"));
  assert.ok(res.body.includes("自动动作"), "auto toggle");
  assert.ok(res.body.includes("飞书通知"), "lark toggle");
  assert.ok(res.body.includes("待批"), "approvals section");
  assert.ok(res.body.includes("工作流"), "runs section");

  // 金字塔：待批（要你动手）在控制条之上，控制条在流程/模块之上，明细与记录沉到底部，维护收进折叠区。
  const at = (needle) => {
    const i = res.body.indexOf(needle);
    assert.ok(i >= 0, "missing section: " + needle);
    return i;
  };
  const order = ['id="attn-count"', 'id="btn-auto"', 'id="tk-title"', 'id="chat-log"', 'id="runs"', 'id="stewards-count"', 'id="agents-count"', 'id="echoes"', 'id="traces"', 'id="doctor-count"', 'class="maint"'];
  const positions = order.map(at);
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i - 1] < positions[i], order[i - 1] + " must sit above " + order[i]);
  }
  assert.ok(at("id=\"approvals\"") < at("id=\"btn-auto\""), "approvals come before the control bar");
  assert.ok(at("id=\"mods\"") > at("id=\"runs\""), "modules are reference detail under the runs");
  assert.ok(res.body.includes('id="attn-count"'), "attention counter");
  assert.ok(res.body.includes('id="runs-count"'), "running workflow counter");
  assert.ok(res.body.includes('id="agents-count"'), "agent counter");
  assert.ok(res.body.includes('id="mods-count"'), "module counter");
  // 追查页：能力平面的 trace 列表 + 瀑布细节，且落在维护折叠区之上。
  assert.ok(res.body.includes('id="traces"'), "trace list");
  assert.ok(res.body.includes('id="tr-filter"'), "trace filter");
  assert.ok(at('id="traces"') < at('class="maint"'), "trace view sits above the maintenance fold");
  // 内联 onclick 在全局作用域求值，面板必须把函数挂到 window（曾经的静默回归：按钮点了没反应）。
  assert.ok(res.body.includes("GLOBAL_FNS"), "inline handlers are exposed to window");
  // 指挥台：交办输入、对话记录、明细抽屉都在页面上，且「交办」在「对话」之上、「对话」在流程之上。
  assert.ok(res.body.includes('id="tk-title"'), "task composer");
  assert.ok(res.body.includes('id="tk-target"'), "task target picker");
  assert.ok(res.body.includes('id="tasks"'), "task list");
  assert.ok(res.body.includes('id="chat-log"'), "chat transcript");
  assert.ok(res.body.includes('id="chat-text"'), "chat input");
  assert.ok(res.body.includes('id="drawer"'), "detail drawer");
  assert.ok(at('id="tk-title"') < at('id="chat-log"'), "tasks sit above the chat");
  assert.ok(at('id="chat-log"') < at('id="runs"'), "chat sits above the reference sections");
  assert.ok(res.body.includes('class="vword'), "verdict word in the hero");
  assert.ok(res.body.includes('class="kpis"'), "kpi strip in the hero");
  // P1 控制面：主管编制（含决策树编辑器）与体检页都在，且体检沉在追查之下、维护之上。
  assert.ok(res.body.includes('id="stewards"'), "steward list");
  assert.ok(res.body.includes('id="sw-editor"'), "steward editor");
  assert.ok(res.body.includes('id="doctor"'), "doctor view");
  assert.ok(res.body.includes('id="tr-pin"'), "pinned trace line");
  assert.ok(at('id="stewards-count"') < at('id="agents-count"'), "stewards sit above the agent table");
  assert.ok(at('id="traces"') < at('id="doctor-count"'), "doctor sits below the trace view");
  assert.ok(at('id="doctor-count"') < at('class="maint"'), "doctor sits above the maintenance fold");
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("dispose is safe to call twice and stops the tick loop", () => {
  const m = mount();
  for (const off of m.effects) { assert.doesNotThrow(() => off()); }
  for (const off of m.effects) { assert.doesNotThrow(() => off()); }
});

test("remounting in the same process keeps working", async () => {
  const a = mount();
  for (const off of a.effects) { try { off(); } catch { /* ignore */ } }
  const b = mount();
  const res = await call(b.handler("steward"), "GET", "/__polaris/steward/api/state");
  assert.equal(res.statusCode, 200);
  assert.equal((await json(res)).ok, true);
  for (const off of b.effects) { try { off(); } catch { /* ignore */ } }
});

test("toolkit metrics endpoint exports host and feature gauges", async () => {
  const m = mount();
  const res = await call(m.toolkit, "GET", "/__polaris/metrics");
  assert.equal(res.statusCode, 200);
  assert.ok(String(res.headers["content-type"]).includes("text/plain"), "prometheus content type");
  for (const name of ["polaris_heap_used_mb", "polaris_features_total", "polaris_heap_guard_used_pct", "polaris_steward_agents_total"]) {
    assert.ok(res.body.includes(name), "metric " + name);
  }
  assert.ok(/# TYPE polaris_heap_used_mb gauge/.test(res.body), "type lines present");
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("write routes need the install token, read routes stay open", async () => {
  const m = mount();
  const saved = TOKEN;
  TOKEN = "";
  const denied = await call(m.toolkit, "POST", "/__polaris/api/settings", { feature: "heap-guard", patch: { autoSlim: true } });
  assert.ok(denied.statusCode === 401 || denied.statusCode === 403, "write refused, got " + denied.statusCode);
  const read = await call(m.toolkit, "GET", "/__polaris/api/features");
  assert.equal(read.statusCode, 200, "read stays open");
  TOKEN = saved;
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("invalid settings patches are rejected with 400", async () => {
  const m = mount();
  const bad = await call(m.toolkit, "POST", "/__polaris/api/settings", { feature: "heap-guard", patch: { slimLevel: 99 } });
  assert.equal(bad.statusCode, 400);
  const body = await json(bad);
  assert.equal(body.code, "invalid-settings");
  const ok = await call(m.toolkit, "POST", "/__polaris/api/settings", { feature: "heap-guard", patch: { slimLevel: 2 } });
  assert.equal(ok.statusCode, 200, "valid nested patch still applies");
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("features endpoint exposes install, capabilities, bus and scheduler", async () => {
  const m = mount();
  const f = await json(await call(m.toolkit, "GET", "/__polaris/api/features"));
  assert.equal(typeof f.install, "object");
  assert.equal(f.install.version, "0.3.0");
  assert.ok(f.capabilities.includes("heap-guard.action"), "capability registry published");
  assert.ok(Array.isArray(f.scheduler) && f.scheduler.length >= 2, "scheduler tasks listed");
  assert.ok(Array.isArray(f.bus) && f.bus.includes("heap/critical"), "bus topics listed");
  assert.ok(typeof f.metrics === "number" && f.metrics > 0, "metric count reported");
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("journal supports incremental pull with since", async () => {
  const m = mount();
  m.ctx.emit("agent/error", { agentId: "a2", message: "boom" });
  const first = await json(await call(m.handler("steward"), "GET", "/__polaris/steward/api/journal?since=0"));
  assert.equal(first.ok, true);
  assert.ok(first.entries.length > 0, "entries returned");
  assert.ok(first.latest > 0, "cursor returned");
  const second = await json(await call(m.handler("steward"), "GET", "/__polaris/steward/api/journal?since=" + first.latest));
  assert.equal(second.ok, true);
  assert.ok(second.entries.every((e) => e.seq > first.latest), "only entries past the cursor");
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("modules can be created, edited, deleted and reset from the panel", async () => {
  const m = mount();
  const h = m.handler("steward");
  const save = async (module) => json(await call(h, "POST", "/__polaris/steward/api/modules", { op: "save", module }));
  const defs = async () => (await json(await call(h, "GET", "/__polaris/steward/api/modules"))).defs;
  const created = await save({ id: "cbtest", name: "CB 测试", workspaces: "D:/agent/cb2, D:/agent/cb3", titles: "cb2, cb3", enabled: true });
  assert.equal(created.ok, true);
  let list = await defs();
  const found = list.filter((x) => x.id === "cbtest")[0];
  assert.ok(found !== undefined, "module saved");
  assert.deepEqual(found.workspaces, ["D:/agent/cb2", "D:/agent/cb3"], "workspaces split on commas");
  assert.deepEqual(found.titles, ["cb2", "cb3"], "titles split on commas");

  const edited = await save({ id: "cbtest", name: "CB 改名", workspaces: ["D:/agent/cb2"], titles: [], enabled: false });
  assert.equal(edited.ok, true);
  list = await defs();
  const again = list.filter((x) => x.id === "cbtest")[0];
  assert.equal(again.name, "CB 改名", "save overwrites in place");
  assert.equal(again.enabled, false);
  assert.equal(again.workspaces.length, 1);

  const badId = await call(h, "POST", "/__polaris/steward/api/modules", { op: "save", module: { id: "bad id!", name: "x" } });
  assert.equal(badId.statusCode, 400, "illegal id refused");
  const reserved = await call(h, "POST", "/__polaris/steward/api/modules", { op: "delete", id: "unassigned" });
  assert.equal(reserved.statusCode, 400, "unassigned is reserved");

  await json(await call(h, "POST", "/__polaris/steward/api/pin", { agentId: "agent-cb", module: "cbtest" }));
  const del = await json(await call(h, "POST", "/__polaris/steward/api/modules", { op: "delete", id: "cbtest" }));
  assert.equal(del.ok, true);
  assert.equal(del.droppedPins, 1, "pins pointing at a deleted module are dropped");
  assert.equal(del.pins["agent-cb"], undefined, "the stale pin is gone");
  list = await defs();
  assert.equal(list.filter((x) => x.id === "cbtest").length, 0, "module removed");
  const missing = await call(h, "POST", "/__polaris/steward/api/modules", { op: "delete", id: "cbtest" });
  assert.equal(missing.statusCode, 404, "deleting a missing module is 404");

  const reset = await json(await call(h, "POST", "/__polaris/steward/api/modules", { op: "reset" }));
  assert.equal(reset.ok, true);
  list = await defs();
  assert.ok(list.length >= 5, "builtin modules restored");
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("every registered tool renders a content block array", () => {
  // DSH defineTool 的 render(args, value) 必须回数组；回单个对象会让调用侧
  // 在 content.some(...) 处炸掉（steward_* 五个工具曾经全中，堆工具用的是数组所以没暴露）。
  const m = mount();
  assert.equal(m.tools.length, 9);
  for (const t of m.tools) {
    const blocks = t.output.render({}, { text: "hello" });
    assert.ok(Array.isArray(blocks), t.name + " render returns an array");
    assert.equal(blocks[0].type, "text", t.name + " block type");
    assert.equal(blocks[0].text, "hello", t.name + " block text");
  }
  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("ops console: chat, tasks, detail and policy routes", async () => {
  const m = mount();
  const steward = m.handler("steward");

  // 分级授权：默认 L2 —— 能采样/瘦身，不能派活/steer。
  const pol = await json(await call(steward, "GET", "/__polaris/steward/api/policy"));
  assert.equal(pol.ok, true);
  assert.equal(pol.actLevel, "L2");
  assert.equal(pol.actMode, "echo");
  assert.ok(pol.policy.allows.indexOf("slim") >= 0, "L2 allows slim");
  assert.ok(pol.policy.denies.indexOf("task.dispatch") >= 0, "L2 denies task.dispatch");

  // 交办：建单 -> 列出 -> echo 派发（不建会话、不发消息）-> 收口。
  const created = await json(await call(steward, "POST", "/__polaris/steward/api/tasks", {
    op: "create", title: "把 README 的旧截图换掉", brief: "换掉 2024 年那几张", acceptance: "README 里没有旧截图"
  }));
  assert.equal(created.ok, true);
  assert.equal(created.task.status, "queued");
  const taskId = created.task.id;

  const listed = await json(await call(steward, "GET", "/__polaris/steward/api/tasks"));
  assert.equal(listed.tasks.length, 1);
  assert.equal(listed.summary.queued, 1);

  const dispatched = await json(await call(steward, "POST", "/__polaris/steward/api/tasks", { op: "dispatch", id: taskId }));
  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.echo, true);
  assert.equal(dispatched.task.status, "assigned");
  assert.match(dispatched.task.result, /echo/);

  const done = await json(await call(steward, "POST", "/__polaris/steward/api/tasks", { op: "complete", id: taskId, result: "换完了" }));
  assert.equal(done.task.status, "done");
  assert.equal(done.task.result, "换完了");

  // 空标题必须被拒。
  const bad = await call(steward, "POST", "/__polaris/steward/api/tasks", { op: "create", title: "  " });
  assert.equal(bad.statusCode, 400);

  // 对话：没有绑定会话时读得到状态、发不出话。
  const chat = await json(await call(steward, "GET", "/__polaris/steward/api/chat"));
  assert.equal(chat.ok, true);
  assert.equal(chat.chat.bound, false);
  assert.equal(chat.transcript.ok, false);
  const refused = await call(steward, "POST", "/__polaris/steward/api/chat", { op: "send", text: "在吗" });
  assert.equal(refused.statusCode, 400);
  assert.equal((await json(refused)).reason, "no-bound-session");

  // 带队详情：缺 session 参数是 400，给了但没有日志就 ok:false（不抛）。
  assert.equal((await call(steward, "GET", "/__polaris/steward/api/detail")).statusCode, 400);
  const detail = await json(await call(steward, "GET", "/__polaris/steward/api/detail?session=session-x"));
  assert.equal(detail.ok, false);

  // actLevel 走 /api/settings，脏值被 schema 拒。
  const up = await call(steward, "POST", "/__polaris/steward/api/settings", { patch: { actLevel: "L3" } });
  assert.equal(up.statusCode, 200);
  const after = await json(await call(steward, "GET", "/__polaris/steward/api/policy"));
  assert.equal(after.actLevel, "L3");
  assert.ok(after.policy.allows.indexOf("task.dispatch") >= 0, "L3 allows task.dispatch");
  const wrong = await call(steward, "POST", "/__polaris/steward/api/settings", { patch: { actLevel: "L9" } });
  assert.equal(wrong.statusCode, 400);

  for (const off of m.effects) { try { off(); } catch { /* ignore */ } }
});

test("capability plane control surface: stewards, routes, doctor, trace replay and export", async () => {
  const m = mount();
  const steward = m.handler("steward");
  const get = async (p) => json(await call(steward, "GET", "/__polaris/steward" + p));
  const post = async (p, body) => json(await call(steward, "POST", "/__polaris/steward" + p, body));
  await new Promise((r) => setTimeout(r, 60));

  // 编制：内置两条 + 每条的树/声带/装备都能读出来（面板编辑器要整条回写）。
  const sw = await get("/api/stewards");
  assert.equal(sw.ok, true);
  assert.ok(sw.stewards.length >= 2, "builtin stewards listed");
  const watch = sw.stewards.filter((s) => s.id === "watch")[0];
  assert.ok(watch !== undefined, "watch steward present");
  assert.ok(watch.tree !== undefined && watch.tree !== null, "tree is exposed for editing");
  assert.deepEqual(watch.voice.mode, "virtual");
  assert.ok(sw.builtin.some((s) => s.id === "watch"), "builtin roster reported");

  // 路由矩阵：每个编制 × 每条能力都有 route + grant。
  const rt = await get("/api/routes");
  assert.equal(rt.ok, true);
  assert.equal(rt.routes.default, "allow");
  assert.equal(rt.routes.matrix.length, sw.stewards.length);
  assert.ok(rt.routes.matrix[0].cells.length >= 19, "matrix covers every capability");
  assert.ok(typeof rt.routes.matrix[0].cells[0].route === "string", "route verdict present");
  assert.ok(typeof rt.routes.matrix[0].cells[0].grant === "string", "grant verdict present");

  // 路由改配置：非法 route 400 且不落盘；合法规则生效后可读回，最后清空。
  const badRoute = await call(steward, "POST", "/__polaris/steward/api/routes", { rules: [{ steward: "watch", cap: "*", route: "nope" }] });
  assert.equal(badRoute.statusCode, 400);
  const okRoute = await post("/api/routes", { rules: [{ steward: "watch", cap: "notify.*", target: "owner", route: "deny" }] });
  assert.equal(okRoute.ok, true);
  assert.equal(okRoute.routes.rules.length, 1);
  assert.equal(okRoute.routes.errors.length, 0);
  const cleared = await post("/api/routes", { default: "allow", rules: [] });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.routes.rules.length, 0);

  // 编制增删改：非法树 400、缺 id 400、删不存在的 404、enable 生效、reset 回默认。
  const badTree = await call(steward, "POST", "/__polaris/steward/api/stewards", { op: "save", id: "cbtest", steward: { id: "cbtest", tree: { foo: 1 } } });
  assert.equal(badTree.statusCode, 400, "invalid tree refused");
  assert.equal((await call(steward, "POST", "/__polaris/steward/api/stewards", { op: "save" })).statusCode, 400, "id required");
  assert.equal((await call(steward, "POST", "/__polaris/steward/api/stewards", { op: "delete", id: "nope" })).statusCode, 404, "unknown steward is 404");
  const off = await post("/api/stewards", { op: "enable", id: "watch", enabled: false });
  assert.equal(off.ok, true);
  assert.equal(off.stewards.filter((s) => s.id === "watch")[0].enabled, false, "enable toggle sticks");
  const resetStewards = await post("/api/stewards", { op: "reset" });
  assert.equal(resetStewards.ok, true);
  assert.equal(resetStewards.stewards.filter((s) => s.id === "watch")[0].enabled, true, "reset restores the builtin");

  // 体检：结论 + 修法入口，能力数来自能力仓。
  const doc = await get("/api/doctor");
  assert.equal(doc.ok, true);
  assert.equal(typeof doc.healthy, "boolean");
  assert.ok(doc.counts.capabilities >= 19, "doctor sees the catalog");
  assert.ok(Array.isArray(doc.checks), "checks array");
  for (const c of doc.checks) assert.ok(typeof c.fix.page === "string", "every check names a place to fix");

  // 追查增强：导出 jsonl、重放（不执行能力）、对比。
  const traces = await get("/api/trace?limit=5");
  assert.ok(traces.traces.length >= 1, "a trace exists after mount");
  const first = traces.traces[0].id;
  const exp = await call(steward, "GET", "/__polaris/steward/api/trace/export?id=" + encodeURIComponent(first));
  assert.equal(exp.statusCode, 200);
  assert.ok(String(exp.headers["content-type"]).includes("ndjson"), "export is ndjson");
  const lines = exp.body.trim().split("\n");
  assert.ok(lines.length >= 2, "export has a header plus rows");
  assert.equal(JSON.parse(lines[0]).kind, "trace");
  assert.ok(lines.some((l) => JSON.parse(l).kind === "span"), "export carries spans");
  const rep = await post("/api/trace/replay", { id: first });
  assert.equal(rep.ok, true, "replay runs");
  assert.ok(Array.isArray(rep.before) && Array.isArray(rep.after), "replay reports before/after");
  assert.ok(typeof rep.changed === "boolean");
  if (traces.traces.length >= 2) {
    const diff = await get("/api/trace/diff?id=" + encodeURIComponent(first) + "&against=" + encodeURIComponent(traces.traces[1].id));
    assert.equal(diff.ok, true);
    assert.ok(Array.isArray(diff.added) && Array.isArray(diff.removed), "diff lists the delta");
  }
  assert.equal((await call(steward, "GET", "/__polaris/steward/api/trace/replay")).statusCode, 404, "replay is POST only");

  for (const off2 of m.effects) { try { off2(); } catch { /* ignore */ } }
});

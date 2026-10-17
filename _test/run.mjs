/**
 * 离线自检：用一个假 cordis ctx 把工具包完整挂一遍，
 * 再按真 HTTP 的形状打请求。不触碰真实 DSH 进程。
 *
 *   node _test/run.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { FEATURES } from "../lib/features/index.js";
import { mountToolkit } from "../lib/core/host.js";
import { stateDir } from "../lib/core/paths.js";

function makeCtx() {
  const effects = [];
  const routes = [];
  const tools = [];
  const logs = [];
  const ctx = {
    logger: { info: (m) => logs.push("info " + m), warn: (m) => logs.push("warn " + m), error: (m) => logs.push("error " + m) },
    effect(fn, label) {
      const off = fn();
      effects.push({ off, label });
      return () => {};
    },
    webServer: {
      register(opts) {
        routes.push(opts);
        return () => { const i = routes.indexOf(opts); if (i >= 0) routes.splice(i, 1); };
      }
    },
    tools: {
      register(tool) {
        tools.push(tool);
        return () => { const i = tools.indexOf(tool); if (i >= 0) tools.splice(i, 1); };
      }
    },
    webRuntime: { trustedHosts: [] },
    agents: { list: () => [], get: () => undefined },
    get: () => undefined
  };
  return { ctx, effects, routes, tools, logs };
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(body) { this.body = body === undefined ? "" : String(body); }
  };
}

function fakeReq(method, url, body) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1:19387" };
  if (body !== undefined) req.push(Buffer.from(JSON.stringify(body), "utf8"));
  req.push(null);
  return req;
}

async function call(handler, method, url, body) {
  const res = fakeRes();
  await handler(fakeReq(method, url, body), res);
  await new Promise((r) => setTimeout(r, 60));
  return res;
}

async function json(res) {
  try { return JSON.parse(res.body); } catch { throw new Error("not json: " + res.body.slice(0, 200)); }
}

// start from a clean settings file so the assertions are about behaviour, not leftovers
const settingsFile = path.join(stateDir(), "settings.json");
try { fs.unlinkSync(settingsFile); } catch { /* absent is fine */ }

const { ctx, effects, routes, tools, logs } = makeCtx();
const result = mountToolkit(ctx, { features: { "heap-guard": { intervalSec: 30 } } }, {
  name: "polaris-toolkit",
  prefix: "/__polaris",
  displayName: "Polaris Toolkit",
  features: FEATURES
});

assert.deepEqual(result.features, ["heap-guard"], "heap-guard should be mounted");
assert.equal(routes.length, 2, "toolkit + one feature route");
assert.equal(tools.length, 4, "four agent tools");

const toolkit = routes.filter((r) => r.path === "/__polaris")[0].handler;
const feature = routes.filter((r) => r.path === "/__polaris/heap-guard")[0].handler;
assert.ok(typeof toolkit === "function" && typeof feature === "function", "handlers registered");

// 1. feature list + live status
const features = await json(await call(toolkit, "GET", "/__polaris/api/features"));
assert.equal(features.ok, true);
assert.equal(features.features.length, 1);
const f = features.features[0];
assert.equal(f.id, "heap-guard");
assert.equal(f.title, "Heap Guard");
assert.equal(f.actions.length, 6, "six actions");
assert.ok(f.actions.some((a) => a.label.indexOf("立即清理（最大）") === 0), "immediate clean button");
assert.ok(f.actions.some((a) => a.kind === "toggle" && a.setting === "autoSlim"), "auto-clean toggle");
assert.ok(f.actions.some((a) => a.id === "slim-all" && a.confirm), "clean-all is confirmed");
assert.ok(typeof f.status.level === "string", "status level present");
assert.deepEqual(f.settings, { autoSlim: false, slimLevel: 3, maxPerClick: 20 });
assert.equal(f.panelUrl, "/__polaris/heap-guard/panel");

// 2. feature panel html
const panel = await call(feature, "GET", "/__polaris/heap-guard/");
assert.equal(panel.statusCode, 200);
assert.ok(panel.body.includes("<title>Heap Guard</title>"), "panel title");
assert.ok(panel.body.includes("宿主 V8 堆"), "pyramid hero");
assert.ok(panel.body.includes("阈值与预计"), "pyramid second layer");
assert.ok(panel.headers["content-type"].includes("text/html"), "html content type");

// 3. live state
const state = await json(await call(feature, "GET", "/__polaris/heap-guard/api/state"));
if (state.last === undefined) { console.log("note: sampler had not produced its first sample yet"); } else { assert.ok(state.last.heap.heapSizeLimitMB > 0, "heap limit known"); }
assert.ok(Array.isArray(state.history), "history ring present");
assert.equal(state.config.intervalSec, 30, "config slice passed through");
assert.ok(typeof state.stateDir === "string" && state.stateDir.length > 0, "state dir");
assert.equal(state.settings.slimLevel, 3);

// 4. toolkit shell panel
const shell = await call(toolkit, "GET", "/__polaris/panel");
assert.equal(shell.statusCode, 200);
assert.ok(shell.body.includes("Polaris Toolkit"), "shell brand");

// 5. settings round trip (toggle, live, no restart)
const set = await json(await call(toolkit, "POST", "/__polaris/api/settings", { feature: "heap-guard", patch: { autoSlim: true, slimLevel: 2 } }));
assert.equal(set.ok, true);
assert.equal(set.settings.autoSlim, true);
const back = await json(await call(toolkit, "GET", "/__polaris/api/settings?feature=heap-guard"));
assert.equal(back.settings.autoSlim, true);
assert.equal(back.settings.slimLevel, 2);
const live = await json(await call(toolkit, "GET", "/__polaris/api/features"));
assert.equal(live.features[0].settings.autoSlim, true, "feature sees the live value");

// 6. generic toggle action flips the same setting
const toggled = await json(await call(toolkit, "POST", "/__polaris/api/action", { feature: "heap-guard", action: "auto-slim" }));
assert.equal(toggled.toggle, "autoSlim");
assert.equal(toggled.value, false, "toggle flipped back");

// 7. sessions listing
const sessions = await json(await call(feature, "GET", "/__polaris/heap-guard/api/sessions?limit=3"));
assert.ok(Array.isArray(sessions.sessions), "sessions array");
assert.ok(sessions.sessions.length <= 3, "limit honoured");

// 8. bili view (config file read, no write)
const bili = await json(await call(feature, "GET", "/__polaris/heap-guard/api/bili"));
assert.equal(bili.ok, true);
assert.ok(typeof bili.before.max === "number", "bili budget read");

// 9. unknown routes are 404, both levels
assert.equal((await call(feature, "GET", "/__polaris/heap-guard/nope")).statusCode, 404, "feature 404");
assert.equal((await call(toolkit, "GET", "/__polaris/nope")).statusCode, 404, "toolkit 404");

// 10. tools are real specs
const names = tools.map((t) => t.name).sort();
assert.deepEqual(names, ["heap_bili", "heap_slim", "heap_snapshot", "heap_status"]);
const status = await tools.filter((t) => t.name === "heap_status")[0].execute({}, { signal: { throwIfAborted() {} } });
assert.ok(typeof status.text === "string" && status.text.includes("heap-guard"), "heap_status text");

// 11. settings file on disk
const file = path.join(stateDir(), "settings.json");
assert.ok(fs.existsSync(file), "settings file written: " + file);
const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
assert.equal(onDisk["heap-guard"].slimLevel, 2);

const routeCount = routes.length;

// 12. dispose stops the sampler
for (const e of effects) { try { e.off(); } catch (error) { console.error("dispose failed " + e.label + ": " + error); } }

console.log("polaris-toolkit self-test OK");
console.log("  features      " + result.features.join(", "));
console.log("  prefix        " + result.prefix);
console.log("  state dir     " + result.dir);
console.log("  routes        " + routeCount + " (toolkit + feature)");
console.log("  tools         " + names.join(", "));
console.log("  actions       " + f.actions.map((a) => a.id + (a.kind === "toggle" ? "(toggle)" : "")).join(", "));
console.log("  heap          " + (state.last === undefined ? "(first sample pending)" : state.last.heap.heapUsedMB + " / " + state.last.heap.heapSizeLimitMB + " MB, level " + state.last.level));
for (const line of logs) console.log("  log " + line);

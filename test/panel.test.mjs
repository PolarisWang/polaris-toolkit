/**
 * 面板冒烟：把三块面板的 HTML 真渲染一遍。
 *
 * 面板是 classic script + 内联 JS，没有打包、没有类型检查，出问题只会在浏览器里
 * 静默 ReferenceError。这里用 node:vm + document 垫片跑真实 HTML，并直接从
 * mountToolkit 的假宿主取真实 JSON 喂给面板的 fetch。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const { mount, call } = await import("./helpers/harness.mjs");
const kitSrc = fs.readFileSync(new URL("../lib/panel/kit.client.js", import.meta.url), "utf8");
const ALLOWED_MISSING = new Set(["pk-toast"]);

function el(id) {
  return {
    id, textContent: "", innerHTML: "", value: "", hidden: false, checked: false,
    style: {}, dataset: {}, disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    querySelectorAll() { return []; }, querySelector() { return null; },
    appendChild() {}, removeChild() {}, remove() {}, focus() {}, blur() {}, click() {},
    insertAdjacentHTML() {}, scrollIntoView() {}
  };
}

/** 从面板 HTML 造一个 document：只认真实存在的 id（未知 id 记下来，像浏览器一样返回 null）。 */
function makeDocument(html) {
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const els = new Map();
  const missing = [];
  const byId = (id) => { if (!els.has(id)) els.set(id, el(id)); return els.get(id); };
  const document = {
    visibilityState: "visible",
    getElementById(id) {
      if (id === undefined || id === null || id === "") return null;
      if (!ids.has(id)) { if (!missing.includes(id)) missing.push(id); return null; }
      return byId(id);
    },
    createElement() { return el("created"); },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    body: el("body"), documentElement: el("html")
  };
  return { document, els, missing, ids };
}

/** fetch 直接打假宿主的真实 handler，所以面板拿到的是真 JSON。 */
function hostFetch(m, base) {
  return async (url, init) => {
    const u = new URL(String(url), base || "http://127.0.0.1:1");
    const method = (init && init.method) || "GET";
    const body = init && init.body ? JSON.parse(init.body) : undefined;
    const parts = u.pathname.split("/").filter(Boolean);
    const feature = parts[1] === undefined || ["api", "panel", "kit.js", "metrics"].includes(parts[1]) ? "" : parts[1];
    const handler = feature === "" ? m.toolkit : m.handler(feature);
    // 功能路由看到的是特性前缀之后的子路径；工具包路由看到的是 /__polaris 之后的子路径。
    const sub = feature === ""
      ? u.pathname.slice("/__polaris".length) + (u.search || "")
      : u.pathname.slice(("/__polaris/" + feature).length) + (u.search || "");
    const res = await call(handler, method, sub, body);
    return { ok: res.statusCode < 400, status: res.statusCode, text: async () => res.body, json: async () => JSON.parse(res.body) };
  };
}

/** 在 vm 里跑一块面板：kit 先注入，然后跑每个内联 <script>。 */
function runPanel(html, { fetchImpl, base } = {}) {
  const { document, els, missing, ids } = makeDocument(html);
  const sandbox = {
    console, document, URL, JSON, Math, Date, String, Number, Object, Array, Boolean, RegExp, Error,
    Promise, isNaN, parseInt, parseFloat, encodeURIComponent, setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval: () => {},
    navigator: { clipboard: { writeText: async () => {} } },
    addEventListener() {}, removeEventListener() {}, postMessage() {}, close() {}, open() {},
    alert() {}, confirm: () => true, prompt: () => null,
    URLSearchParams, TextEncoder, TextDecoder, AbortController,
    location: { href: base || "http://127.0.0.1:1/__polaris/panel", search: "", hash: "" },
    fetch: fetchImpl
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(kitSrc, sandbox, { filename: "kit.client.js" });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1, "panel has an inline script");
  for (const code of scripts) new Function(code); // 语法必须能解析（踩过：模板字符串里反斜杠丢一层）
  for (const code of scripts) vm.runInContext(code, sandbox, { filename: "panel-inline.js" });
  return { sandbox, els, missing, ids, scripts };
}

async function settle(rounds = 60) {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 10));
}

test("toolkit shell panel renders features and shows the stale banner", async () => {
  const m = mount();
  const { toolkitPanelHtml } = await import("../lib/panel.js");
  const html = toolkitPanelHtml({ prefix: "/__polaris", version: "0.3.0" });
  const state = await (await call(m.toolkit, "GET", "/__polaris/api/features")).body;
  const run = runPanel(html, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => state, json: async () => JSON.parse(state) }) });
  await settle(10);
  assert.deepEqual(run.missing, [], "every id the script touches exists in the HTML");
  assert.ok(run.els.get("features").innerHTML.includes("heap-guard"), "feature cards rendered");
  assert.equal(run.els.get("stale").hidden, true, "no stale banner while the process is newer than disk");
  assert.equal(typeof run.sandbox.copyToken, "function", "copy-token bound");
  assert.equal(typeof run.sandbox.loadRaw, "function", "raw settings loader bound");
  assert.equal(typeof run.sandbox.saveRaw, "function", "raw settings saver bound");
  m.dispose();
});

test("toolkit shell panel reads and refuses an invalid whole-document edit", async () => {
  const m = mount();
  const { toolkitPanelHtml } = await import("../lib/panel.js");
  const html = toolkitPanelHtml({ prefix: "/__polaris", version: "0.3.0" });
  const base = "http://127.0.0.1:1/__polaris/panel";
  const run = runPanel(html, { fetchImpl: hostFetch(m, base), base });
  await settle(10);
  run.sandbox.loadRaw();
  await settle(10);
  assert.ok(run.els.get("raw-json").value.includes('"d"'), "raw editor filled with the envelope");
  run.els.get("raw-json").value = JSON.stringify({ v: 1, d: { "heap-guard": { slimLevel: 99 } } });
  run.sandbox.saveRaw();
  await settle(10);
  assert.ok(/保存被拒/.test(run.els.get("set-msg").textContent), "invalid text reported, got: " + run.els.get("set-msg").textContent);
  assert.ok(/invalid-settings|expected number/.test(run.els.get("set-msg").textContent), "server reason surfaced");
  m.dispose();
});

test("toolkit shell panel flags code that is newer on disk than in the running process", async () => {
  const m = mount();
  const { toolkitPanelHtml } = await import("../lib/panel.js");
  const d = JSON.parse((await call(m.toolkit, "GET", "/__polaris/api/features")).body);
  d.install = Object.assign({}, d.install, { stale: true, bootAt: 1000, newestFile: "lib/features/steward/panel.js", newestMs: 2000, files: 82 });
  const html = toolkitPanelHtml({ prefix: "/__polaris", version: "0.3.0" });
  const run = runPanel(html, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(d), json: async () => d }) });
  await settle(10);
  assert.equal(run.els.get("stale").hidden, false, "stale banner shown");
  assert.ok(run.els.get("stale").innerHTML.includes("steward/panel.js"), "banner names the newer file");
  assert.ok(/启动|重启|restart/.test(run.els.get("stale").innerHTML), "banner tells you to restart");
  m.dispose();
});

const PANELS = [
  {
    feature: "steward",
    // 面板真正写过的 id（冒烟就是抓"面板引用了 HTML 里不存在的 id / render 半途抛错"这类静默故障）。
    needs: ["hero", "attn-count", "approvals", "asks", "mods-count", "mods", "agents-count", "agents", "tasks", "tasks-count",
      "chat-state", "chat-log", "traces", "traces-count", "catalog", "catalog-count", "routes", "routes-count",
      "audit", "audit-count", "stewards", "stewards-count", "doctor-count", "foot", "sw-snippets", "settings-form", "set-msg"],
    check: (run) => {
      assert.match(run.els.get("hero").innerHTML, /平稳|偏高|吃紧/, "hero 给了人话结论");
      assert.equal(run.els.get("catalog-count").textContent, "22", "能力仓读到 22 条能力");
      assert.ok(run.els.get("catalog").innerHTML.includes("plane-"), "catalog 显示能力指纹");
      assert.ok(run.els.get("routes").innerHTML.includes("默认 allow"), "路由格渲染了默认裁决");
      assert.equal(run.els.get("chat-state").textContent, "未绑定", "未绑定时对话区说清楚状态");
      assert.ok(Number(run.els.get("mods-count").textContent) >= 5, "模块分组渲染");
      assert.ok(run.els.get("settings-form").innerHTML.includes("data-path"), "设置表单按 data-path 渲染了旋钮");
      assert.ok(/settings\.json/.test(run.els.get("set-msg").textContent), "设置区显示配置文件路径");
      const stewTree = run.els.get("stewards").innerHTML;
      assert.ok(stewTree.includes("when host/tick"), "决策树渲染成人话步骤（when）");
      assert.ok(stewTree.includes("call judge.host.heap.high"), "决策树渲染成人话步骤（call）");
      assert.ok(stewTree.includes("if "), "决策树分支可见");
      assert.ok(run.els.get("approvals").innerHTML.length > 0, "拍板队列至少给了一句话");
    }
  },
  {
    feature: "heap-guard",
    needs: ["used", "limit", "pct", "rss", "growth", "eta", "kpis", "thresholds", "spark", "spaces", "system",
      "actions", "snapshots", "rows", "cand-hint"],
    check: (run) => {
      // 回归：render 曾把整个 state 传给 renderThresholds（它要的是 state.last），
      // 抛 TypeError 后 thresholds/spaces/system 全部不渲染，并把错误写进 #result。
      const resultBox = run.els.get("result");
      assert.ok(resultBox === undefined || !String(resultBox.textContent).includes("读取状态失败"), "#result 不该出读取错误");
      assert.notEqual(run.els.get("used").textContent, "--", "堆用量有值");
      assert.match(run.els.get("thresholds").innerHTML, /warn \d+%/, "阈值条渲染出来了");
      assert.ok(run.els.get("spaces").innerHTML.includes("<td>"), "堆空间表渲染出来了");
    }
  }
];

for (const spec of PANELS) {
  test(spec.feature + " panel renders against real host data", async () => {
    const m = mount();
    const html = (await call(m.handler(spec.feature), "GET", "/")).body;
    const base = "http://127.0.0.1:1/__polaris/" + spec.feature + "/panel";
    const run = runPanel(html, { fetchImpl: hostFetch(m, base), base });
    await settle();
    assert.deepEqual(run.missing.filter((id) => !ALLOWED_MISSING.has(id)), [], "every id the script touches exists in the HTML");
    for (const id of spec.needs) assert.ok(run.els.get(id) !== undefined, "panel wrote #" + id);
    const written = [...run.els.values()].filter((e) => e.innerHTML !== "" || e.textContent !== "");
    assert.ok(written.length >= spec.needs.length, "panel actually painted (" + written.length + " nodes)");
    spec.check(run);
    m.dispose();
  });
}

test("steward panel binds every inline onclick handler to window", async () => {
  const m = mount();
  const html = (await call(m.handler("steward"), "GET", "/")).body;
  const base = "http://127.0.0.1:1/__polaris/steward/panel";
  const run = runPanel(html, { fetchImpl: hostFetch(m, base), base });
  await settle();
  const names = [...html.matchAll(/onclick="([A-Za-z_$][\w$]*)/g)].map((mm) => mm[1]);
  assert.ok(names.length >= 10, "panel has inline handlers");
  for (const name of new Set(names)) {
    assert.equal(typeof run.sandbox[name], "function", "window." + name + " bound (IIFE 里的函数不会自动上全局)");
  }
  m.dispose();
});

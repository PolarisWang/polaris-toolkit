/**
 * 工具包宿主：把一组 feature 挂成一个插件。
 *
 * 约定（新增功能必须遵守）：
 *   feature = { id, title, subtitle, order, Config?, settings?(config), settingsSchema?, actions[], setup(scope), action?(scope,id,body), status?(scope) }
 *   scope   = { id, ctx, config, dir, settings, core, log, route, tool, onDispose, runtime,
 *               metrics, host, every, provide, use, bus }
 *   - actions 只是元数据；kind:"toggle" 由工具包直接写设置，不会进 feature.action。
 *   - setup(scope) 里用 scope.route / scope.tool / scope.onDispose 登记，工具包负责定义与释放。
 *   - 所有路由挂在 <prefix>/<id> 下；面板用相对 URL 访问，不写前导斜杠。
 *
 * 12 项评审里落在宿主身上的部分：
 *   P0-1 feature 隔离：单个 feature 抛错只把自己标成 degraded，其余照常挂载；
 *   P0-2 统一指标：只有这里一套 createMetrics + 一个采样器，feature 只 publish；
 *   P0-3 写操作鉴权：mutating 请求必须带安装级令牌（见 core/secret.js）；
 *   P1-4 capability 注册表：scope.provide / scope.use，缺失时调用方自行降级；
 *   P1-5 事件总线：scope.bus（emit / on / topics）；
 *   P1-6 设置校验：feature.settingsSchema + 深合并（见 core/settings.js）；
 *   P2-9 装机信息：/api/install + 面板页脚；
 *   P2-10 状态保留：启动时清理 journal 与 samples.csv；
 *   P2-11 统一调度：scope.every 带抖动，堆压力高时全局降频。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { appendCsv, csvRow, ensureDir, featureDir, iso, mb, round1, stamp, stateDir } from "./paths.js";
import { isMutating, isTrustedApiRequest, tokenMatches, tokenOf } from "./fence.js";
import { createRouter, intOf, queryOf, readBody, sendHtml, sendJson, sendText } from "./http.js";
import { createHostSampler, createMetrics } from "./metrics.js";
import { createSecret } from "./secret.js";
import { pruneCsv, pruneFiles } from "./statefile.js";
import { createSettingsStore } from "./settings.js";
import { toolkitPanelHtml } from "../panel.js";
import { KIT_FILE, kitSource } from "../panel/kit.js";

/** 极简 topic 总线：emit 同步派发，单个订阅者抛错不影响其它订阅者。 */
function createBus(log) {
  const topics = new Map();
  return {
    on(topic, handler) {
      if (typeof handler !== "function") return () => {};
      const key = String(topic);
      let set = topics.get(key);
      if (set === undefined) { set = new Set(); topics.set(key, set); }
      set.add(handler);
      return () => { const cur = topics.get(key); if (cur === undefined) return; cur.delete(handler); if (cur.size === 0) topics.delete(key); };
    },
    emit(topic, payload) {
      const set = topics.get(String(topic));
      if (set === undefined) return 0;
      let fired = 0;
      for (const handler of [...set]) {
        try { handler(payload); fired += 1; } catch (error) { log("warn", "polaris bus " + String(topic) + " handler failed: " + String(error)); }
      }
      return fired;
    },
    topics() { return [...topics.keys()]; },
    count(topic) { const set = topics.get(String(topic)); return set === undefined ? 0 : set.size; },
    dispose() { topics.clear(); }
  };
}

/** 统一调度：setTimeout 链 + 抖动 + 堆压力降频（压力越高，间隔越长）。 */
function createScheduler(sampler, log) {
  const tasks = new Set();
  function pressure() {
    const sample = sampler.peek();
    if (sample === undefined) return 1;
    if (sample.heapPct >= 80) return 4;
    if (sample.heapPct >= 65) return 2;
    return 1;
  }
  function every(ms, fn, options) {
    const opt = options === undefined || options === null ? {} : options;
    const base = Math.max(1000, Number.isFinite(Number(ms)) ? Number(ms) : 5000);
    const jitter = Math.min(0.5, Math.max(0, Number.isFinite(Number(opt.jitter)) ? Number(opt.jitter) : 0.1));
    const task = { base, fn, timer: null, stopped: false, runs: 0, lastAt: 0, lastError: "" };
    function arm(delay) {
      if (task.stopped) return;
      const spread = 1 + (Math.random() * 2 - 1) * jitter;
      const wait = Math.max(1000, Math.round(delay * spread));
      task.timer = setTimeout(async () => {
        task.timer = null;
        if (task.stopped) return;
        try { await fn(); task.lastError = ""; } catch (error) { task.lastError = String(error); log("warn", "polaris scheduled task failed: " + String(error)); }
        task.runs += 1;
        task.lastAt = Date.now();
        arm(task.base * pressure());
      }, wait);
      if (task.timer !== null && typeof task.timer.unref === "function") task.timer.unref();
    }
    arm(base);
    tasks.add(task);
    const off = () => { task.stopped = true; if (task.timer !== null) { clearTimeout(task.timer); task.timer = null; } tasks.delete(task); };
    off.state = () => ({ base: task.base, runs: task.runs, lastAt: task.lastAt, lastError: task.lastError });
    return off;
  }
  return {
    every,
    pressure,
    size: () => tasks.size,
    states: () => [...tasks].map((t) => ({ base: t.base, runs: t.runs, lastAt: t.lastAt, lastError: t.lastError })),
    dispose() { for (const task of tasks) { task.stopped = true; if (task.timer !== null) clearTimeout(task.timer); } tasks.clear(); }
  };
}

export function mountToolkit(ctx, config, options) {
  const opt = options === undefined || options === null ? {} : options;
  const name = typeof opt.name === "string" ? opt.name : "polaris-toolkit";
  const prefix = typeof opt.prefix === "string" ? opt.prefix : "/__polaris";
  const displayName = typeof opt.displayName === "string" ? opt.displayName : "Polaris Toolkit";
  const features = Array.isArray(opt.features) ? opt.features : [];
  const dir = ensureDir(stateDir());
  const bootAt = Date.now();
  /** 插件自身根目录：用来判断"磁盘上的代码是否比进程装载的新"。 */
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const log = (level, message) => {
    try { if (ctx.logger !== undefined) ctx.logger[level](message); } catch { /* logger is optional */ }
  };
  const settings = createSettingsStore(dir);
  const metrics = createMetrics();
  const hostSampler = createHostSampler();
  const secret = createSecret(dir, typeof opt.token === "string" ? { token: opt.token } : undefined);
  const auth = { token: secret.token, file: secret.file };
  const bus = createBus(log);
  const scheduler = createScheduler(hostSampler, log);
  const raw = config !== undefined && config !== null && typeof config === "object" ? config : {};
  const rawFeatures = raw.features !== null && typeof raw.features === "object" && !Array.isArray(raw.features) ? raw.features : {};
  const records = new Map();
  /** 跨功能共享句柄（兼容保留）：优先用 scope.provide / scope.use。 */
  const shared = { runtimes: new Map() };
  /** capability 注册表：feature 只声明"我能做什么"，调用方拿不到就自己降级。 */
  const capabilities = new Map();
  /** Trusted authorities for the same-origin fence. 0.2.1 removed the webRuntime
   * service, so probe the candidates and fall back to loopback-only trust. */
  function trustedHosts() {
    for (const serviceName of ["webRuntime", "webTrust", "webApp", "webServer"]) {
      try {
        const service = ctx.get(serviceName);
        const list = service === undefined || service === null ? undefined : service.trustedHosts;
        if (Array.isArray(list) && list.length > 0) return list;
      } catch { /* service absent */ }
    }
    return [];
  }
  const fence = (req) => {
    try { return isTrustedApiRequest(req, trustedHosts()); } catch { return true; }
  };

  /** 统一入口守卫：同源 + 写令牌。返回 false 时已经写好响应。 */
  function authorize(req, res) {
    if (!fence(req)) { sendJson(res, 403, { ok: false, error: "forbidden" }); return false; }
    const method = req === undefined || req === null ? "GET" : req.method;
    if (isMutating(method) && !tokenMatches(auth.token, tokenOf(req))) {
      sendJson(res, 401, {
        ok: false,
        error: "polaris token required",
        code: "token-required",
        hint: "reload the Polaris panel (it sets the polaris_token cookie) or send x-polaris-token: <stateDir>/secret"
      });
      return false;
    }
    return true;
  }

  /**
   * 运行态漂移检测：Node 的 ESM 缓存不会重新导入已装载模块，所以装机/改代码后
   * 不重启宿主，用户看到的仍是旧代码 —— 这里按 mtime 对比"启动时看到的文件"和
   * "现在的文件"，让面板和 /api/install 能明确说"需要重启"。
   */
  function scanCode() {
    let newest = 0;
    let newestFile = "";
    let count = 0;
    let totalBytes = 0;
    for (const sub of ["lib", "bin"]) {
      const base = path.join(moduleRoot, sub);
      const walk = (d) => {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          const p = path.join(d, entry.name);
          if (entry.isDirectory()) { if (entry.name !== "node_modules" && entry.name !== ".git") walk(p); continue; }
          if (!/\.(js|mjs|json)$/.test(entry.name)) continue;
          let st;
          try { st = fs.statSync(p); } catch { continue; }
          count += 1;
          totalBytes += st.size;
          if (st.mtimeMs > newest) { newest = st.mtimeMs; newestFile = path.relative(moduleRoot, p); }
        }
      };
      walk(base);
    }
    return { newest, newestFile, count, totalBytes };
  }
  const bootScan = scanCode();
  let driftCache = { at: 0, value: null };
  function driftInfo() {
    const now = Date.now();
    if (driftCache.value !== null && now - driftCache.at < 5000) return driftCache.value;
    const cur = scanCode();
    let installedAt = 0;
    try { const doc = JSON.parse(fs.readFileSync(path.join(dir, "install.json"), "utf8")); installedAt = Date.parse(doc !== null && doc !== undefined ? doc.at : ""); if (!Number.isFinite(installedAt)) installedAt = 0; } catch { installedAt = 0; }
    const changed = [];
    if (cur.newest > bootScan.newest + 1000) changed.push(cur.newestFile);
    if (installedAt > bootAt + 5000) changed.push("install.json@" + new Date(installedAt).toISOString());
    const value = {
      bootAt,
      bootNewestMs: Math.round(bootScan.newest),
      newestMs: Math.round(cur.newest),
      newestFile: cur.newestFile,
      files: cur.count,
      bytes: cur.totalBytes,
      installedAt: installedAt === 0 ? "" : new Date(installedAt).toISOString(),
      stale: cur.newest > bootScan.newest + 1000 || installedAt > bootAt + 5000,
      changed: changed.slice(0, 8)
    };
    driftCache = { at: now, value };
    return value;
  }

    /** 安装信息：版本来自自身 package.json，装机时间/来源来自 <stateDir>/install.json。 */
  function installInfo() {
    const out = { name, version: "", installedAt: "", source: "", files: 0, stateDir: dir, secretFile: auth.file, node: process.version, features: records.size, metrics: metrics.size() };
    try {
      const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
      if (pkg !== null && typeof pkg === "object") {
        out.version = typeof pkg.version === "string" ? pkg.version : "";
        if (typeof pkg.name === "string" && pkg.name !== "") out.name = pkg.name;
      }
    } catch { /* installed copy without package.json */ }
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, "install.json"), "utf8"));
      if (doc !== null && typeof doc === "object") {
        // install.ps1 写的是 {at,version,repo,profile,files,mode,node,pnpm}；
        // 老的/手写的记录可能用 installedAt/source，两种都认。
        const at = typeof doc.at === "string" ? doc.at : doc.installedAt;
        const source = typeof doc.repo === "string" ? doc.repo : doc.source;
        if (typeof doc.version === "string") out.version = doc.version;
        if (typeof at === "string") out.installedAt = at;
        if (typeof source === "string") out.source = source;
        if (typeof doc.profile === "string") out.profile = doc.profile;
        if (typeof doc.mode === "string") out.mode = doc.mode;
        if (Number.isFinite(Number(doc.files))) out.files = Number(doc.files);
      }
    } catch { /* install.json is written by bin/polaris.mjs, optional */ }
    const drift = driftInfo();
    out.bootAt = new Date(drift.bootAt).toISOString();
    out.stale = drift.stale;
    out.staleFiles = drift.changed;
    out.newestFile = drift.newestFile;
    out.loadedMs = drift.bootNewestMs;
    out.ondiskMs = drift.newestMs;
    out.restartHint = drift.stale ? "restart the DSH host (tray -> quit, then start again) to load the new plugin code" : "";
    return out;
  }

  function validate(feature, slice) {
    if (typeof feature.Config !== "function") return slice;
    try { return feature.Config(slice === undefined ? {} : slice); } catch (error) {
      log("warn", name + ": " + feature.id + " config rejected, using raw slice: " + String(error));
      return slice === undefined ? {} : slice;
    }
  }

  /**
   * 单个 feature 的补丁：先过它的 settingsSchema，再落盘。
   * agent 工具与 HTTP 路由走同一条路径，语义不会分叉（P1-A）。
   */
  function settingsPatch(featureId, patch) {
    const record = records.get(String(featureId));
    if (record === undefined) return { ok: false, error: "unknown feature", feature: String(featureId) };
    const checked = record.scope.settings.validate(patch);
    if (!checked.ok) return { ok: false, code: "invalid-settings", feature: record.id, error: checked.error };
    try { return { ok: true, feature: record.id, value: record.scope.settings.set(patch) }; } catch (error) { return { ok: false, code: "invalid-settings", feature: record.id, error: String(error.message || error) }; }
  }

  /** 整份 settings.json：读原始信封。 */
  function settingsRaw() {
    return { ok: true, file: settings.file, doc: settings.raw() };
  }

  /** 整份替换：逐个 feature 过 schema，任一片段非法就整份拒绝（不落盘）。 */
  function settingsReplace(doc) {
    const inner = doc !== null && typeof doc === "object" && !Array.isArray(doc) && doc.d !== null && typeof doc.d === "object" ? doc.d : doc;
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) {
      return { ok: false, code: "invalid-settings", error: "settings must be an object of feature keys" };
    }
    for (const r of records.values()) {
      if (inner[r.id] === undefined) continue;
      const checked = r.scope.settings.checkSlice(inner[r.id]);
      if (!checked.ok) return { ok: false, code: "invalid-settings", feature: r.id, error: checked.error };
    }
    try { return { ok: true, doc: settings.replace(doc), file: settings.file }; } catch (error) { return { ok: false, code: "invalid-settings", error: String(error.message || error) }; }
  }

  function mountFeature(feature) {
    const id = String(feature.id);
    const featureDirPath = ensureDir(featureDir(id));
    const slice = rawFeatures[id];
    const configSlice = validate(feature, slice);
    let defaults = {};
    try { defaults = typeof feature.settings === "function" ? feature.settings(configSlice) : {}; } catch (error) { log("warn", name + ": " + id + " settings() failed: " + String(error)); }
    const featureSettings = settings.feature(id, defaults, { schema: feature.settingsSchema });
    const router = createRouter();
    const toolSpecs = [];
    const disposers = [];
    let disposed = false;
    const scope = {
      id,
      ctx,
      config: configSlice,
      dir: featureDirPath,
      settings: featureSettings,
      core: {
        fence, sendJson, sendText, sendHtml, readBody, queryOf, intOf, featureDir, stateDir, ensureDir, stamp, iso, mb, round1, appendCsv, csvRow,
        // 设置控制面（P1-A）：面板、agent 工具与 HTTP 路由共用这一套校验/落盘路径。
        settingsFile: settings.file,
        settingsRaw,
        settingsPatch,
        settingsReplace
      },
      log,
      metrics: { gauge: metrics.gauge, counter: metrics.counter, snapshot: metrics.snapshot },
      host: {
        sample: () => { const peeked = hostSampler.peek(); return peeked === undefined ? hostSampler.sample() : peeked; },
        peek: () => hostSampler.peek(),
        every: scheduler.every,
        pressure: scheduler.pressure
      },
      every: scheduler.every,
      provide(capability, fn) {
        if (typeof fn !== "function") return () => {};
        const key = String(capability);
        capabilities.set(key, { feature: id, fn });
        return () => { const cur = capabilities.get(key); if (cur !== undefined && cur.feature === id) capabilities.delete(key); };
      },
      use(capability) {
        const entry = capabilities.get(String(capability));
        return entry === undefined ? undefined : entry.fn;
      },
      bus: { on: bus.on, emit: bus.emit, topics: bus.topics, count: bus.count },
      route(method, path, handler) { router.add(method, path, handler); },
      tool(spec) { toolSpecs.push(spec); },
      onDispose(fn) { if (typeof fn === "function") disposers.push(fn); if (disposed) { try { fn(); } catch { /* ignore */ } } },
      shared,
      runtime: undefined
    };
    const record = {
      id,
      title: feature.title === undefined ? id : feature.title,
      subtitle: feature.subtitle === undefined ? "" : feature.subtitle,
      order: typeof feature.order === "number" ? feature.order : 100,
      actions: Array.isArray(feature.actions) ? feature.actions : [],
      feature,
      scope,
      router,
      degraded: null,
      settings: () => featureSettings.all(),
      status: () => {
        if (record.degraded !== null) {
          return { level: "high", headline: "未启动（" + record.degraded.phase + "）: " + record.degraded.error, degraded: record.degraded };
        }
        try { return typeof feature.status === "function" ? feature.status(scope) : undefined; } catch (error) { return { level: "ok", headline: "status error: " + String(error) }; }
      },
      action: async (actionId, body) => {
        if (record.degraded !== null) return { ok: false, reason: "feature " + id + " degraded at " + record.degraded.phase + ": " + record.degraded.error };
        if (typeof feature.action !== "function") return { ok: false, reason: "feature " + id + " has no action handler" };
        return feature.action(scope, actionId, body === undefined ? {} : body);
      }
    };
    function degrade(phase, error) {
      const text = String(error === undefined || error === null ? "unknown error" : error.message || error);
      record.degraded = { phase, error: text, at: Date.now() };
      log("warn", name + ": feature " + id + " degraded at " + phase + ": " + text);
    }

    if (typeof feature.setup === "function") {
      try {
        ctx.effect(() => {
          try { feature.setup(scope); } catch (error) { degrade("setup", error); }
          let offRoute = () => {};
          try { offRoute = ctx.webServer.register({ kind: "prefix", path: prefix + "/" + id, handler: featureHandler(id) }); } catch (error) { degrade("route", error); }
          const offTools = [];
          for (const spec of toolSpecs.splice(0)) {
            try { offTools.push(ctx.tools.register(defineTool(spec))); } catch (error) { log("warn", name + ": tool " + (spec === undefined ? "?" : spec.name) + " rejected: " + String(error)); }
          }
          return () => {
            disposed = true;
            for (const fn of disposers.splice(0)) { try { fn(); } catch { /* ignore */ } }
            for (const off of offTools.splice(0)) { try { off(); } catch { /* ignore */ } }
            try { offRoute(); } catch { /* ignore */ }
          };
        }, name + ": feature " + id);
      } catch (error) { degrade("mount", error); }
    } else {
      degrade("setup", new Error("feature has no setup function"));
    }
    records.set(id, record);
    shared.runtimes.set(id, record);
    return record;
  }

  function featureHandler(id) {
    const basePath = prefix + "/" + id;
    return async (req, res) => {
      if (!authorize(req, res)) return;
      const record = records.get(id);
      const parsed = new URL(req.url === undefined ? "/" : req.url, "http://127.0.0.1");
      let sub = parsed.pathname;
      if (sub === basePath) sub = "/";
      else if (sub.startsWith(basePath + "/")) sub = sub.slice(basePath.length);
      if (record === undefined) { sendJson(res, 404, { ok: false, error: "feature not mounted", feature: id }); return; }
      if (record.degraded !== null && record.degraded.phase === "setup") {
        sendJson(res, 503, { ok: false, error: "feature degraded during setup", feature: id, degraded: record.degraded });
        return;
      }
      try {
        const handled = await record.router.handle(req, res, sub);
        if (!handled) sendJson(res, 404, { ok: false, error: "no such route", path: sub });
      } catch (error) {
        log("warn", name + ": " + id + " route failed: " + String(error));
        sendJson(res, 500, { ok: false, error: String(error), path: sub });
      }
    };
  }

  for (const feature of features) {
    if (feature === undefined || feature === null || feature.id === undefined) continue;
    mountFeature(feature);
  }

  /** 默认指标：宿主级状态，feature 自己的指标由 feature 用 scope.metrics 发布。 */
  const at = () => hostSampler.peek();
  metrics.gauge("polaris_heap_used_mb", () => (at() === undefined ? 0 : at().heapUsedMB), { help: "V8 heap used in MB" });
  metrics.gauge("polaris_heap_limit_mb", () => (at() === undefined ? 0 : at().heapLimitMB), { help: "V8 heap size limit in MB" });
  metrics.gauge("polaris_heap_pct", () => (at() === undefined ? 0 : at().heapPct), { help: "V8 heap used as percent of the limit" });
  metrics.gauge("polaris_rss_mb", () => (at() === undefined ? 0 : at().rssMB), { help: "process RSS in MB" });
  metrics.gauge("polaris_event_loop_p99_ms", () => (at() === undefined ? 0 : at().loop.p99Ms), { help: "event loop delay p99 in ms" });
  metrics.gauge("polaris_features_total", () => records.size, { help: "mounted features" });
  metrics.gauge("polaris_features_degraded", () => [...records.values()].filter((r) => r.degraded !== null).length, { help: "features that failed to mount" });
  metrics.gauge("polaris_scheduler_tasks", () => scheduler.size(), { help: "scheduled tasks owned by the toolkit" });
  metrics.gauge("polaris_install_stale", () => (driftInfo().stale ? 1 : 0), { help: "1 when the plugin files changed after the host booted (restart required)" });
  hostSampler.sample();
  scheduler.every(5000, () => { hostSampler.sample(); }, { jitter: 0.2 });

  const toolkit = createRouter();
  function sendPanel(res, embed) {
    const info = installInfo();
    try { res.setHeader("set-cookie", "polaris_token=" + encodeURIComponent(auth.token) + "; Path=/; SameSite=Lax; HttpOnly"); } catch { /* headers already sent */ }
    sendHtml(res, 200, toolkitPanelHtml({ prefix, displayName, embed, version: info.version, installedAt: info.installedAt }));
  }
  toolkit.add("GET", "/", (req, res) => sendPanel(res, false));
  toolkit.add("GET", "/panel", (req, res) => sendPanel(res, true));
  toolkit.add("GET", "/metrics", (req, res) => sendText(res, 200, "text/plain; charset=utf-8", metrics.text()));
  toolkit.add("GET", "/" + KIT_FILE, (req, res) => sendText(res, 200, "text/javascript; charset=utf-8", kitSource()));
  toolkit.add("GET", "/api/features", (req, res) => {
    sendJson(res, 200, {
      ok: true,
      name,
      prefix,
      stateDir: dir,
      install: installInfo(),
      metrics: metrics.size(),
      scheduler: scheduler.states(),
      capabilities: [...capabilities.keys()],
      bus: bus.topics(),
      features: [...records.values()].map((r) => ({
        id: r.id,
        title: r.title,
        subtitle: r.subtitle,
        order: r.order,
        actions: r.actions,
        settings: r.settings(),
        status: r.status(),
        degraded: r.degraded,
        panelUrl: prefix + "/" + r.id + "/panel"
      }))
    });
  });
  toolkit.add("GET", "/api/install", (req, res) => { sendJson(res, 200, { ok: true, install: installInfo() }); });
  toolkit.add("GET", "/api/settings", (req, res) => {
    const feature = queryOf(req).get("feature");
    const record = feature === null ? undefined : records.get(feature);
    if (feature !== null && record === undefined) { sendJson(res, 404, { ok: false, error: "unknown feature", feature }); return; }
    if (record === undefined) {
      const all = {};
      for (const r of records.values()) all[r.id] = r.settings();
      sendJson(res, 200, { ok: true, settings: all, file: settings.file });
      return;
    }
    sendJson(res, 200, { ok: true, feature: record.id, settings: record.settings(), file: settings.file });
  });
  toolkit.add("POST", "/api/settings", async (req, res) => {
    const parsed = await readBody(req);
    if (!parsed.ok) { sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    const body = parsed.value;
    const record = records.get(body.feature);
    if (record === undefined) { sendJson(res, 404, { ok: false, error: "unknown feature", feature: body.feature }); return; }
    const patch = body.patch !== null && typeof body.patch === "object" && !Array.isArray(body.patch) ? body.patch : {};
    const saved = settingsPatch(record.id, patch);
    if (!saved.ok) { sendJson(res, 400, saved); return; }
    sendJson(res, 200, { ok: true, feature: record.id, settings: saved.value, file: settings.file });
  });
  // 原始 JSON 全文：面板的"直接编辑 settings.json"入口。写路径仍按 feature 逐个校验，
  // 任一片段非法 → 整份拒绝、不落盘（灵活但不绕过 schema）。
  toolkit.add("GET", "/api/settings/raw", (req, res) => {
    sendJson(res, 200, { ok: true, file: settings.file, doc: settings.raw() });
  });
  toolkit.add("POST", "/api/settings/raw", async (req, res) => {
    const parsed = await readBody(req);
    if (!parsed.ok) { sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    const body = parsed.value === null || parsed.value === undefined ? {} : parsed.value;
    let doc = body.doc;
    if (typeof body.text === "string") {
      try { doc = JSON.parse(body.text); } catch (error) { sendJson(res, 400, { ok: false, code: "invalid-settings", error: "not valid JSON: " + String(error.message || error) }); return; }
    }
    const replaced = settingsReplace(doc);
    if (!replaced.ok) { sendJson(res, 400, replaced); return; }
    sendJson(res, 200, { ok: true, doc: replaced.doc, file: replaced.file });
  });
  toolkit.add("POST", "/api/action", async (req, res) => {
    const parsed = await readBody(req);
    if (!parsed.ok) { sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    const body = parsed.value;
    const record = records.get(body.feature);
    if (record === undefined) { sendJson(res, 404, { ok: false, error: "unknown feature", feature: body.feature }); return; }
    if (record.degraded !== null) { sendJson(res, 503, { ok: false, error: "feature degraded", feature: record.id, degraded: record.degraded }); return; }
    const actionId = String(body.action === undefined ? "" : body.action);
    const meta = record.actions.filter((a) => a.id === actionId)[0];
    try {
      if (meta !== undefined && meta.kind === "toggle") {
        const payload = body.body !== null && typeof body.body === "object" ? body.body : {};
        const current = record.scope.settings.get(meta.setting) === true;
        const value = typeof payload.value === "boolean" ? payload.value : !current;
        const patch = {};
        patch[meta.setting] = value;
        const next = record.scope.settings.set(patch);
        sendJson(res, 200, { ok: true, feature: record.id, action: actionId, toggle: meta.setting, value, settings: next });
        return;
      }
      const result = await record.action(actionId, body.body);
      sendJson(res, 200, result === undefined ? { ok: true } : result);
    } catch (error) {
      log("warn", name + ": action " + actionId + " on " + record.id + " failed: " + String(error));
      sendJson(res, 500, { ok: false, error: String(error), feature: record.id, action: actionId });
    }
  });
  // 令牌自取：只有**已经携带正确令牌**的调用方（面板 cookie 自动带）能读回令牌。
  // 匿名 GET 一律 403，所以这不削弱写保护；只是给面板一个"复制令牌"按钮的落点。
  toolkit.add("GET", "/api/token", (req, res) => {
    if (!tokenMatches(auth.token, tokenOf(req))) {
      sendJson(res, 403, { ok: false, error: "open the panel first (it sets the polaris_token cookie)", code: "token-required" });
      return;
    }
    sendJson(res, 200, { ok: true, token: auth.token, file: auth.file, header: "x-polaris-token" });
  });
  toolkit.add("*", (req, res, sub) => sendJson(res, 404, { ok: false, error: "no such toolkit route", path: sub }));

  ctx.effect(() => {
    const offRoute = ctx.webServer.register({ kind: "prefix", path: prefix, handler: toolkitHandler });
    return () => {
      try { offRoute(); } catch { /* ignore */ }
      try { scheduler.dispose(); } catch { /* ignore */ }
      try { bus.dispose(); } catch { /* ignore */ }
      try { hostSampler.dispose(); } catch { /* ignore */ }
      try { metrics.dispose(); } catch { /* ignore */ }
    };
  }, name + ": toolkit routes");

  /** 启动时清理过期状态：journal 按天滚动但以前从不删，samples.csv 无限增长。 */
  try {
    const removed = pruneFiles(featureDir("steward"), { match: /^journal-\d{8}\.jsonl$/, keepDays: 30 });
    if (removed.length > 0) log("info", name + ": pruned " + removed.length + " old steward journal files");
  } catch { /* best effort */ }
  try { pruneCsv(path.join(featureDir("heap-guard"), "samples.csv"), { keepDays: 14, maxRows: 20000 }); } catch { /* best effort */ }

  function toolkitHandler(req, res) {
    if (!authorize(req, res)) return;
    const parsed = new URL(req.url === undefined ? "/" : req.url, "http://127.0.0.1");
    let sub = parsed.pathname;
    if (sub === prefix) sub = "/";
    else if (sub.startsWith(prefix + "/")) sub = sub.slice(prefix.length);
    void (async () => {
      try {
        const handled = await toolkit.handle(req, res, sub);
        if (!handled) sendJson(res, 404, { ok: false, error: "no such route", path: sub });
      } catch (error) {
        log("warn", name + ": route " + sub + " failed: " + String(error));
        sendJson(res, 500, { ok: false, error: String(error), path: sub });
      }
    })();
  }

  log("info", name + " mounted: prefix " + prefix + ", features " + [...records.keys()].join(",") + ", state " + dir);
  return { name, prefix, dir, features: [...records.keys()], token: auth.token, auth, metrics, bus, scheduler, install: installInfo() };
}

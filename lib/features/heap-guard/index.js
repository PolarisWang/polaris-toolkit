/**
 * Feature: Heap Guard (宿主 V8 堆监控 / 安全瘦身 / bili 预算)
 *
 * 这一层只负责"这个功能做什么"，不知道自己是插件还是工具包的一部分：
 *   - 配置切片的 schema 与防御性默认值；
 *   - actions 元数据（面板按钮 / 工具包卡片的唯一来源）；
 *   - setup(scope)：注册路由与工具、启动采样、返回清理；
 *   - action(scope, id, body)：按钮的服务端实现；
 *   - status(scope)：金字塔顶层要展示的一行结论 + 关键指标。
 *
 * 它刻意不做的事：把别的会话从宿主堆里挤出去（没有这个 API）、重启 app、
 * 强制 GC。那些属于后续的 C 档（安全点重启看门狗）。
 */
import z from "@deepseek-ai/schemastery";
import { ensureDir, featureDir, iso, mb, round1, sessionsRoot, stamp } from "../../core/paths.js";
import { Sampler, freeDiskMB } from "./sampler.js";
import { AutoSlimmer, runSlim } from "./slim.js";
import { listSnapshots, writeHeapSnapshot } from "./snapshot.js";
import { applyBiliBudget, biliBudget, biliConfigFile, fetchBili, readBiliConfig } from "./bili.js";
import { findSessionFile, isSessionClosed, listSessionFiles, newestStructural } from "./idle.js";
import { createTitleStore } from "./titles.js";
import { heapPanelHtml } from "./panel.js";

export const id = "heap-guard";
export const title = "Heap Guard";
export const subtitle = "宿主 V8 堆监控 / 会话安全瘦身 / bili 预算";
export const order = 10;

/** 崩溃排查期间绝对不能动的会话。 */
const DEFAULT_EXCLUDE = ["244dc012", "0ea8ff46", "efadff6e", "42a0ae7a"];

export const Config = z.object({
  intervalSec: z.natural().default(30),
  warnPct: z.number().default(60),
  highPct: z.number().default(75),
  criticalPct: z.number().default(85),
  emergencyPct: z.number().default(92),
  ringSize: z.natural().default(480),
  csv: z.boolean().default(true),
  biliUrl: z.string().default("http://127.0.0.1:18788"),
  bili: z.object({
    enabled: z.boolean().default(true),
    applyOnStart: z.boolean().default(false),
    max: z.natural().default(256),
    residentMaxMB: z.natural().default(384),
    warmMax: z.natural().default(8),
    warmMaxBytesMB: z.natural().default(64)
  }).default({}),
  slim: z.object({
    enabled: z.boolean().default(true),
    level: z.natural().default(3),
    minMB: z.number().default(8),
    quietSec: z.number().default(45),
    cooldownMin: z.number().default(10),
    maxPerHour: z.natural().default(4),
    triggerLevel: z.string().default("warn"),
    dryRun: z.boolean().default(false),
    exclude: z.array(z.string()).default(DEFAULT_EXCLUDE)
  }).default({}),
  snapshot: z.object({
    minFreeGB: z.number().default(5),
    keep: z.natural().default(2)
  }).default({})
});

/** 运行时可改的设置：面板上的开关与下拉写这里，改完立刻生效。 */
export const settings = (config) => ({
  autoSlim: false,
  slimLevel: config.slim.level,
  maxPerClick: 20
});

/**
 * 运行时设置的校验 schema（P1-6）：面板/HTTP 传上来的 patch 先深合并再校验，
 * 非法值直接 400，不会写进 settings.json。
 */
export const settingsSchema = z.object({
  autoSlim: z.boolean().default(false),
  slimLevel: z.natural().min(1).max(3).default(3),
  maxPerClick: z.natural().min(1).max(200).default(20)
});

/** 面板按钮 / 工具包卡片按钮的唯一来源；toggle 型由工具包通用处理。 */
export const actions = [
  { id: "slim-biggest", kind: "button", label: "立即清理（最大）", hint: "只清理最大的一个安全候选会话；先整文件备份再原地重写" },
  { id: "slim-all", kind: "button", label: "立即清理（全部候选）", hint: "串行清理所有安全候选会话，默认上限 20 个", confirm: true },
  { id: "slim-dry", kind: "button", label: "试运行", hint: "只统计能省多少，不改动任何文件" },
  { id: "title-refresh", kind: "button", label: "刷新会话名", hint: "重新扫描会话日志里的 session/title 事件（子进程有界扫描，不动宿主堆）" },
  { id: "auto-slim", kind: "toggle", label: "自动清理", setting: "autoSlim", hint: "达到阈值且处于安全点时自动瘦身" },
  { id: "snapshot", kind: "button", label: "写堆快照", hint: "v8.writeHeapSnapshot，会短暂阻塞宿主几秒" },
  { id: "bili-apply", kind: "button", label: "应用 bili 预算", hint: "把配置里的 max / residentMax / warm 写进 bili 配置文件", confirm: true }
];

function num(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function str(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
function obj(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** 防御性默认值：schema 会补，但手写的一行配置可能没有。 */
export function normalize(raw) {
  const c = obj(raw);
  const bili = obj(c.bili);
  const slim = obj(c.slim);
  const snap = obj(c.snapshot);
  return {
    intervalSec: Math.max(5, num(c.intervalSec, 30)),
    warnPct: num(c.warnPct, 60),
    highPct: num(c.highPct, 75),
    criticalPct: num(c.criticalPct, 85),
    emergencyPct: num(c.emergencyPct, 92),
    ringSize: Math.max(24, num(c.ringSize, 480)),
    csv: bool(c.csv, true),
    biliUrl: str(c.biliUrl, "http://127.0.0.1:18788"),
    bili: {
      enabled: bool(bili.enabled, true),
      applyOnStart: bool(bili.applyOnStart, false),
      max: Math.max(1, num(bili.max, 256)),
      residentMaxMB: Math.max(16, num(bili.residentMaxMB, 384)),
      warmMax: Math.max(1, num(bili.warmMax, 8)),
      warmMaxBytesMB: Math.max(1, num(bili.warmMaxBytesMB, 64))
    },
    slim: {
      enabled: bool(slim.enabled, true),
      level: Math.max(1, Math.min(3, num(slim.level, 3))),
      minMB: num(slim.minMB, 8),
      quietSec: num(slim.quietSec, 45),
      cooldownMin: num(slim.cooldownMin, 10),
      maxPerHour: Math.max(1, num(slim.maxPerHour, 4)),
      triggerLevel: str(slim.triggerLevel, "warn"),
      dryRun: bool(slim.dryRun, false),
      exclude: Array.isArray(slim.exclude) ? slim.exclude.map(String) : DEFAULT_EXCLUDE.slice()
    },
    snapshot: {
      minFreeGB: num(snap.minFreeGB, 5),
      keep: Math.max(1, num(snap.keep, 2))
    }
  };
}

function textRender(fn) {
  return (_args, value) => [{ type: "text", text: fn(value) }];
}

function statusText(sampler, config, extra) {
  const state = sampler.state();
  const last = state.last;
  if (last === undefined) return "heap-guard: no sample yet";
  const h = last.heap;
  const lines = [
    "heap-guard (polaris-toolkit)",
    "  heap used      " + h.heapUsedMB + " MB / " + h.heapSizeLimitMB + " MB  (" + h.usedPct + "%)  level " + last.level,
    "  heap total     " + h.heapTotalMB + " MB   available " + h.heapAvailableMB + " MB   external " + h.externalMB + " MB",
    "  growth         " + last.growthMBPerMin + " MB/min (recent samples)",
    "  rss            " + h.rssMB + " MB",
    "  agents         " + last.runningAgentCount + " running / " + last.agentCount + " loaded",
    "  sessions       " + last.sessionCount + " files, " + last.sessionTotalMB + " MB on disk",
    "  system         " + last.system.usedPct + "% of " + last.system.totalMB + " MB used",
    "  thresholds     warn " + config.warnPct + "% / high " + config.highPct + "% / critical " + config.criticalPct + "% / emergency " + config.emergencyPct + "%",
    "  state dir      " + state.stateDir
  ];
  if (extra !== undefined) lines.push("  " + extra);
  return lines.join("\n");
}

function budgetLine(budget) {
  return "bili budget: max " + budget.max + " sessions, residentMax " + budget.residentMaxMB + " MB, warm " + budget.warmMax + "/" + budget.warmMaxBytesMB + " MB, gc " + (budget.gcEnabled ? "on" : "off") + "  (" + budget.file + ")";
}

function sessionsView(limit) {
  const all = listSessionFiles();
  const out = [];
  for (const s of all.slice(0, limit)) {
    const closed = s.size > 1048576 ? isSessionClosed(s.path) : undefined;
    out.push({
      id: s.id,
      workspace: s.workspace,
      path: s.path,
      sizeMB: round1(s.size / 1048576),
      mtimeMs: s.mtimeMs,
      mtimeIso: new Date(s.mtimeMs).toISOString(),
      state: closed === undefined ? "small" : closed.ok ? "closed" : (closed.reason || "unknown"),
      closed: closed === undefined ? undefined : closed.ok
    });
  }
  return out;
}

function biggestSlimCandidate(config) {
  const all = listSessionFiles();
  const exclude = config.slim.exclude;
  let best;
  for (const s of all) {
    if (s.size < config.slim.minMB * 1048576) continue;
    if (exclude.some((e) => s.id.startsWith(e))) continue;
    const closed = isSessionClosed(s.path, config.slim.quietSec);
    if (!closed.ok) continue;
    if (best === undefined || s.size > best.size) best = s;
  }
  return best;
}

/** 采样等级 → 数字，方便当指标发布（0=ok … 4=emergency）。 */
const LEVEL_RANK = { ok: 0, warn: 1, high: 2, critical: 3, emergency: 4 };

/** 把功能挂到工具包上：路由、工具、采样生命周期。 */
export function setup(scope) {
  const ctx = scope.ctx;
  const c = normalize(scope.config);
  const dir = scope.dir;
  const sampler = new Sampler(ctx, c);
  const slimmer = new AutoSlimmer(ctx, c.slim, sampler, scope.settings);
  const events = { startedAt: Date.now(), lastSlim: undefined, lastSnapshot: undefined, lastBili: undefined, lastError: undefined };
  const log = (level, message) => scope.log(level, message);
  const titleStore = createTitleStore(scope, { root: sessionsRoot(), dir });
  scope.onDispose(() => titleStore.dispose());

  // ---- 指标（P0-2）----
  // feature 只"发布"，采样仍然只在本 feature 内做一次；工具包把同一份 snapshot 同时给
  // GET <prefix>/metrics 与 steward 的 Prometheus/OTLP 导出，两个面板不再各算一套。
  const slimTotal = scope.metrics.counter("polaris_heap_guard_slim_total", { help: "slim runs performed by heap-guard" });
  const slimFailed = scope.metrics.counter("polaris_heap_guard_slim_failed_total", { help: "slim runs that failed" });
  const lastSample = () => sampler.last();
  scope.metrics.gauge("polaris_heap_guard_used_mb", () => { const s = lastSample(); return s === undefined ? 0 : s.heap.heapUsedMB; }, { help: "V8 heap used in MB (heap-guard sample)" });
  scope.metrics.gauge("polaris_heap_guard_used_pct", () => { const s = lastSample(); return s === undefined ? 0 : s.heap.usedPct; }, { help: "V8 heap used as percent of heap_size_limit" });
  scope.metrics.gauge("polaris_heap_guard_growth_mb_per_min", () => { const s = lastSample(); return s === undefined ? 0 : s.growthMBPerMin; }, { help: "heap growth over the last 20 samples, MB/min" });
  scope.metrics.gauge("polaris_heap_guard_level", () => { const s = lastSample(); return s === undefined ? 0 : (LEVEL_RANK[s.level] === undefined ? 0 : LEVEL_RANK[s.level]); }, { help: "sample level: 0=ok 1=warn 2=high 3=critical 4=emergency" });
  scope.metrics.gauge("polaris_heap_guard_agents", () => { const s = lastSample(); return s === undefined ? 0 : s.runningAgentCount; }, { labels: { state: "running" }, help: "agents currently running" });
  scope.metrics.gauge("polaris_heap_guard_agents", () => { const s = lastSample(); return s === undefined ? 0 : s.agentCount; }, { labels: { state: "loaded" }, help: "agents loaded in the host" });
  scope.metrics.gauge("polaris_heap_guard_sessions_mb", () => { const s = lastSample(); return s === undefined ? 0 : s.sessionTotalMB; }, { help: "total size of session logs in MB" });
  scope.metrics.gauge("polaris_heap_guard_free_disk_mb", () => { const s = lastSample(); return s === undefined || s.freeDiskMB === undefined ? 0 : s.freeDiskMB; }, { help: "free disk on the state volume, MB" });

  // 堆危急时向工具包总线广播一次（P1-5）：steward 等订阅方可以自己决定要不要动作。
  let lastCriticalAt = 0;
  const offSample = sampler.onSample((sample) => {
    void slimmer.tick(sample).then((result) => {
      if (result !== undefined) events.lastSlim = result;
    }).catch((error) => {
      events.lastError = String(error);
    });
    void titleStore.tick().catch((error) => { events.lastError = String(error); });
    if (sample.level === "critical" || sample.level === "emergency") {
      log("warn", "heap-guard: host heap " + sample.heap.heapUsedMB + " MB (" + sample.heap.usedPct + "% of limit), growth " + sample.growthMBPerMin + " MB/min");
      if (sample.t - lastCriticalAt >= 60000) {
        lastCriticalAt = sample.t;
        try {
          scope.bus.emit("heap/critical", {
            at: sample.t, level: sample.level, usedMB: sample.heap.heapUsedMB, limitMB: sample.heap.heapSizeLimitMB,
            usedPct: sample.heap.usedPct, growthMBPerMin: sample.growthMBPerMin, agents: sample.agentCount
          });
        } catch (error) { log("debug", "heap-guard: heap/critical emit failed: " + String(error)); }
      }
    }
  });
  sampler.start(scope.every);
  scope.onDispose(() => { offSample(); sampler.stop(); });

  if (c.bili.enabled && c.bili.applyOnStart) {
    try {
      const result = applyBiliBudget({ max: c.bili.max, residentMaxMB: c.bili.residentMaxMB, warmMax: c.bili.warmMax, warmMaxBytesMB: c.bili.warmMaxBytesMB });
      events.lastBili = { at: Date.now(), auto: true, before: result.before, after: result.after };
    } catch (error) {
      events.lastError = String(error);
    }
  }

  function levelOf(bodyLevel) {
    return Math.max(1, Math.min(3, num(bodyLevel, slimmer.configuredLevel())));
  }

  /** 单个会话：默认挑最大的安全候选；显式给 sessionId 时跳过静默窗口但仍要求 turn/end。 */
  async function handleSlimRequest(body) {
    const payload = obj(body);
    const apply = payload.apply === true;
    const level = levelOf(payload.level);
    const sessionId = typeof payload.sessionId === "string" && payload.sessionId.length > 0 ? payload.sessionId : undefined;
    const file = sessionId === undefined ? biggestSlimCandidate(c) : findSessionFile(sessionId);
    if (file === undefined) return { ok: false, reason: sessionId === undefined ? "no eligible session at a safe point" : "session not found" };
    const closed = isSessionClosed(file.path, sessionId === undefined ? c.slim.quietSec : 0);
    if (apply && !closed.ok) return { ok: false, reason: "session is not at a safe point: " + closed.reason, sessionId: file.id };
    const result = await runSlim({ only: [file.id], level, minMB: 0, apply, exclude: c.slim.exclude });
    const totals = result.report === undefined ? undefined : result.report.totals;
    const summary = {
      ok: result.ok,
      sessionId: file.id,
      level,
      apply,
      code: result.code,
      beforeMB: totals === undefined ? undefined : round1(totals.before / 1048576),
      afterMB: totals === undefined ? undefined : round1(totals.after / 1048576),
      savedMB: totals === undefined ? undefined : round1(totals.saved / 1048576),
      status: result.report === undefined ? "no-report" : result.report.rows.filter((r) => r.status === "ok").length + " ok",
      backup: result.backup,
      json: result.json,
      stderr: result.stderr.slice(-1500)
    };
    events.lastSlim = summary;
    sampler.sessionsAt = 0;
    return summary;
  }

  /** 串行清理所有安全候选（面板上的"立即清理（全部候选）"）。 */
  async function cleanAll(body) {
    const payload = obj(body);
    const apply = payload.apply !== false;
    const level = levelOf(payload.level);
    const cap = Math.max(1, Math.min(100, num(payload.max, num(scope.settings.get("maxPerClick"), 20))));
    const candidates = [];
    for (const s of listSessionFiles()) {
      if (s.size < c.slim.minMB * 1048576) continue;
      if (c.slim.exclude.some((e) => s.id.startsWith(e))) continue;
      const closed = isSessionClosed(s.path, c.slim.quietSec);
      if (!closed.ok) continue;
      candidates.push(s);
    }
    candidates.sort((a, b) => b.size - a.size);
    const picked = candidates.slice(0, cap);
    const results = [];
    for (const file of picked) {
      const result = await runSlim({ only: [file.id], level, minMB: 0, apply, exclude: c.slim.exclude });
      const totals = result.report === undefined ? undefined : result.report.totals;
      results.push({
        sessionId: file.id,
        sizeMB: round1(file.size / 1048576),
        ok: result.ok,
        code: result.code,
        savedMB: totals === undefined ? 0 : round1(totals.saved / 1048576),
        afterMB: totals === undefined ? undefined : round1(totals.after / 1048576),
        backup: result.backup
      });
    }
    const summary = {
      ok: results.every((r) => r.ok),
      apply,
      level,
      candidates: candidates.length,
      processed: results.length,
      cappedAt: cap,
      savedMB: round1(results.reduce((n, r) => n + r.savedMB, 0)),
      results
    };
    events.lastSlim = summary;
    sampler.sessionsAt = 0;
    return summary;
  }

  function handleSnapshot(body) {
    const payload = obj(body);
    const result = writeHeapSnapshot({
      minFreeGB: c.snapshot.minFreeGB,
      keep: c.snapshot.keep,
      label: typeof payload.label === "string" && payload.label.length > 0 ? payload.label : undefined
    });
    events.lastSnapshot = { at: Date.now(), ...result };
    return events.lastSnapshot;
  }

  async function handleBiliRequest(body) {
    const payload = obj(body);
    const apply = payload.apply === true;
    const patch = {};
    if (typeof payload.max === "number") patch.max = payload.max;
    if (typeof payload.residentMaxMB === "number") patch.residentMaxMB = payload.residentMaxMB;
    if (typeof payload.warmMax === "number") patch.warmMax = payload.warmMax;
    if (typeof payload.warmMaxBytesMB === "number") patch.warmMaxBytesMB = payload.warmMaxBytesMB;
    if (payload.gcEnabled !== undefined) patch.gcEnabled = payload.gcEnabled === true;
    const before = biliBudget(readBiliConfig());
    let after = before;
    if (apply && Object.keys(patch).length > 0) {
      const result = applyBiliBudget(patch);
      after = result.after;
    }
    const overview = await fetchBili(c.biliUrl, "/__bili/overview", 2500);
    const summary = {
      ok: true,
      applied: apply && Object.keys(patch).length > 0,
      patch,
      before,
      after,
      restartNote: "sessions.max / residentMaxBytes / warmMax / warmMaxBytes 在 bili 模块加载时取值，所以改完要重启 bili（即重启 DSH）才生效；sessions.gc.* 每次读取。",
      overview
    };
    if (apply) events.lastBili = summary;
    return summary;
  }

  /** 顶部结论 + 关键指标（工具包卡片和功能面板顶栏共用）。 */
  function currentStatus() {
    const last = sampler.state().last;
    const budget = c.bili.enabled ? biliBudget(readBiliConfig()) : undefined;
    if (last === undefined) {
      return { level: "ok", headline: "采样中", lines: [], details: { autoSlim: scope.settings.get("autoSlim") === true } };
    }
    const h = last.heap;
    return {
      level: last.level,
      headline: h.heapUsedMB + " MB / " + h.heapSizeLimitMB + " MB · " + h.usedPct + "%",
      lines: [
        { label: "增长", value: String(last.growthMBPerMin), unit: "MB/min" },
        { label: "agents", value: last.runningAgentCount + "/" + last.agentCount, unit: "running/loaded" },
        { label: "会话", value: String(last.sessionCount), unit: "个 " + last.sessionTotalMB + " MB" },
        { label: "系统内存", value: String(last.system.usedPct), unit: "%" },
        { label: "bili", value: budget === undefined ? "off" : budget.max + " / " + budget.residentMaxMB + " MB", unit: "max/resident" }
      ],
      details: {
        autoSlim: scope.settings.get("autoSlim") === true,
        slimLevel: slimmer.configuredLevel(),
        freeDiskMB: last.freeDiskMB,
        stateDir: dir,
        lastSlim: events.lastSlim,
        lastError: events.lastError
      }
    };
  }

  scope.runtime = { c, dir, sampler, slimmer, events, titleStore, handleSlimRequest, cleanAll, handleSnapshot, handleBiliRequest, currentStatus, statusText, counters: { slim: () => slimTotal.inc(), failed: () => slimFailed.inc() } };

  // ---- capability（P1-4）----
  // 别的 feature 只认这些名字，不认 heap-guard 的内部结构；拿不到就自己降级。
  scope.provide("heap-guard.action", (actionId, body) => action(scope, actionId, body));
  scope.provide("heap-guard.titles", () => titleStore);
  scope.provide("heap-guard.sampler", () => sampler);
  scope.provide("heap-guard.status", () => currentStatus());

  // ---------- 路由（挂载在 /__polaris/heap-guard 之下）----------
  scope.route("GET", "/", (req, res) => scope.core.sendHtml(res, 200, heapPanelHtml({ embed: true })));
  scope.route("GET", "/index.html", (req, res) => scope.core.sendHtml(res, 200, heapPanelHtml({ embed: true })));
  scope.route("GET", "/panel", (req, res) => scope.core.sendHtml(res, 200, heapPanelHtml({ embed: true })));
  scope.route("GET", "/api/state", (req, res) => {
    const state = sampler.state();
    const history = scope.core.intOf(scope.core.queryOf(req).get("history"), 0, 0, 100000);
    if (history > 0 && Array.isArray(state.history) && state.history.length > history) state.history = state.history.slice(-history);
    state.bili = biliBudget(readBiliConfig());
    state.settings = scope.settings.all();
    state.titles = titleStore.summary();
    state.actions = { startedAt: events.startedAt, lastSlim: events.lastSlim, lastSnapshot: events.lastSnapshot, lastBili: events.lastBili, lastError: events.lastError };
    scope.core.sendJson(res, 200, state);
  });
  scope.route("GET", "/api/sessions", (req, res) => {
    const limit = scope.core.intOf(scope.core.queryOf(req).get("limit"), 25, 1, 200);
    const sessions = sessionsView(limit);
    const titles = titleStore.attach(sessions);
    void titleStore.tick();
    scope.core.sendJson(res, 200, { sessions, titles });
  });

  /** 轻量心跳：面板每 5 秒取一次，只有 rev 变化时才回拉完整状态。 */
  scope.route("GET", "/api/tick", (req, res) => {
    const state = sampler.state();
    const last = state.last;
    const settings = scope.settings.all();
    const slimAt = events.lastSlim === undefined || events.lastSlim === null ? 0 : (events.lastSlim.at || 0);
    const titleRev = titleStore.summary();
    scope.core.sendJson(res, 200, {
      ok: true,
      at: Date.now(),
      rev: [
        last === undefined ? 0 : last.level,
        last === undefined ? 0 : last.heap.heapUsedMB,
        last === undefined ? 0 : last.growthMBPerMin,
        last === undefined ? 0 : last.sessionCount,
        last === undefined ? 0 : last.sessionTotalMB,
        JSON.stringify(settings),
        slimAt,
        titleRev.known + ":" + (titleRev.lastRunAt || 0) + ":" + titleRev.queued,
        events.lastError === undefined ? "" : String(events.lastError).slice(0, 160)
      ].join("|"),
      sample: last === undefined ? undefined : {
        level: last.level,
        usedMB: last.heap.heapUsedMB,
        limitMB: last.heap.heapSizeLimitMB,
        pct: last.heap.usedPct,
        rssMB: last.heap.rssMB,
        availableMB: last.heap.heapAvailableMB,
        growthMBPerMin: last.growthMBPerMin,
        runningAgentCount: last.runningAgentCount,
        agentCount: last.agentCount,
        sessionCount: last.sessionCount,
        sessionTotalMB: last.sessionTotalMB,
        systemUsedPct: last.system.usedPct,
        freeDiskMB: last.freeDiskMB
      },
      settings,
      titles: titleStore.summary()
    });
  });

  scope.route("GET", "/api/titles", (req, res) => {
    scope.core.sendJson(res, 200, { ok: true, summary: titleStore.summary(), entries: titleStore.entries().slice(0, 60) });
  });
  scope.route("POST", "/api/titles", async (req, res) => {
    const parsed = await scope.core.readBody(req);
    const payload = parsed.ok ? parsed.value : {};
    const result = titleStore.force(Array.isArray(payload.ids) ? payload.ids : undefined);
    void titleStore.tick();
    scope.core.sendJson(res, 200, { ok: true, ...result });
  });
  scope.route("GET", "/api/actions", (req, res) => {
    scope.core.sendJson(res, 200, {
      startedAt: events.startedAt,
      settings: scope.settings.all(),
      lastSlim: events.lastSlim,
      lastSnapshot: events.lastSnapshot,
      lastBili: events.lastBili,
      lastError: events.lastError,
      snapshots: listSnapshots().slice(0, 5),
      titles: titleStore.summary()
    });
  });
  scope.route("GET", "/api/bili", async (req, res) => { scope.core.sendJson(res, 200, await handleBiliRequest({})); });
  scope.route("GET", "/api/snapshots", (req, res) => { scope.core.sendJson(res, 200, { snapshots: listSnapshots(), freeDiskMB: freeDiskMB(dir) }); });
  scope.route("POST", "/api/snapshot", async (req, res) => {
    const parsed = await scope.core.readBody(req);
    const result = handleSnapshot(parsed.ok ? parsed.value : {});
    scope.core.sendJson(res, result.ok ? 200 : 409, result);
  });
  scope.route("POST", "/api/slim", async (req, res) => {
    const parsed = await scope.core.readBody(req);
    const payload = parsed.ok ? parsed.value : {};
    const result = payload.scope === "all" ? await cleanAll(payload) : await handleSlimRequest(payload);
    scope.core.sendJson(res, 200, result);
  });
  scope.route("POST", "/api/bili", async (req, res) => {
    const parsed = await scope.core.readBody(req);
    scope.core.sendJson(res, 200, await handleBiliRequest(parsed.ok ? parsed.value : {}));
  });
  scope.route("*", (req, res, sub) => { scope.core.sendJson(res, 404, { ok: false, error: "no such route", path: sub }); });

  // ---------- 工具（由工具包统一 defineTool + 注册）----------
  scope.tool({
    name: "heap_status",
    description: "Report the DSH host heap: used/limit, growth per minute, level against thresholds, loaded vs running agents, session file count and size, and the bili proxy session budget. Read-only.",
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: true, properties: { text: { type: "string" } } },
      render: textRender((v) => v.text)
    },
    execute: async () => {
      const budget = c.bili.enabled ? biliBudget(readBiliConfig()) : undefined;
      const text = statusText(sampler, c, budget === undefined ? undefined : budgetLine(budget));
      const named = titleStore.entries().slice(0, 5);
      if (named.length === 0) return { text };
      return { text: text + "\n  named sessions " + named.map((e) => e.id.slice(0, 8) + " " + e.title).join(" | ") };
    }
  });

  scope.tool({
    name: "heap_slim",
    description: "Slim DSH session files on disk without restarting: repack the concatenated zstd frames (level 1, lossless), optionally drop assistant stream deltas (level 2) and cap oversized tool result text (level 3). Defaults to a dry run of the biggest session that is closed at turn/end; pass apply:true to rewrite (a full backup is taken and the record count is re-verified). scope:all cleans every safe candidate.",
    parameters: {
      sessionId: { type: "string", description: "Session id (or unique prefix). Omit to target the biggest eligible session." },
      level: { type: "number", description: "1 = lossless repack, 2 = + drop stream deltas, 3 = + cap tool text (default from config)." },
      apply: { type: "boolean", description: "true rewrites the file; false (default) only reports." },
      scope: { type: "string", description: "Set to all to clean every safe candidate (capped by the maxPerClick setting)." }
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: { text: { type: "string" } } },
      render: textRender((v) => v.text)
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted();
      if (args.scope === "all") {
        const all = await cleanAll({ apply: args.apply === true, level: args.level });
        const lines = [
          (all.apply ? "heap_slim ALL APPLIED" : "heap_slim ALL DRY-RUN") + "  candidates " + all.candidates + ", processed " + all.processed + " (cap " + all.cappedAt + ")",
          "  saved " + all.savedMB + " MB total"
        ];
        for (const r of all.results) lines.push("  " + r.sessionId.slice(0, 8) + "  " + r.sizeMB + " MB -> " + (r.afterMB === undefined ? "?" : r.afterMB) + " MB  saved " + r.savedMB + " MB  ok " + r.ok);
        return { text: lines.join("\n") };
      }
      const result = await handleSlimRequest({ sessionId: args.sessionId, level: args.level, apply: args.apply === true });
      const lines = [
        (result.ok ? "heap_slim " + (result.apply ? "APPLIED" : "DRY-RUN") : "heap_slim failed") + (result.sessionId === undefined ? "" : "  session " + result.sessionId),
        "  before " + mb(result.beforeMB === undefined ? 0 : result.beforeMB * 1048576) + " MB -> after " + mb(result.afterMB === undefined ? 0 : result.afterMB * 1048576) + " MB   saved " + (result.savedMB === undefined ? "<none>" : result.savedMB) + " MB",
        "  status " + (result.status === undefined ? (result.reason || "") : result.status),
        result.backup === undefined ? "" : "  backup " + result.backup,
        result.json === undefined ? "" : "  report " + result.json
      ].filter((l) => l.length > 0);
      if (result.stderr !== undefined && result.stderr.length > 0) lines.push("  stderr " + result.stderr.slice(-600));
      return { text: lines.join("\n") };
    }
  });

  scope.tool({
    name: "heap_snapshot",
    description: "Write a V8 heap snapshot of the DSH host process to <DSH_HOME>/polaris-toolkit/features/heap-guard/snapshots for offline analysis with Chrome DevTools. Blocks the host for a few seconds and temporarily uses extra memory and disk; keeps only the newest snapshots and refuses when free disk is below the configured floor.",
    parameters: { label: { type: "string", description: "Optional label included in the file name." } },
    output: {
      schema: { type: "object", additionalProperties: true, properties: { text: { type: "string" } } },
      render: textRender((v) => v.text)
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted();
      return { text: JSON.stringify(handleSnapshot({ label: args.label }), null, 1) };
    }
  });

  scope.tool({
    name: "heap_bili",
    description: "Show or change the billion-context (bili) proxy session budget in its config file: sessions.max, sessions.residentMaxBytes, sessions.warmMax, sessions.warmMaxBytes. Lowering them bounds the largest DSH process that is not the host. The resident/max keys take effect after a bili restart (a DSH restart); sessions.gc is read per use.",
    parameters: {
      action: { type: "string", description: "show (default), preview, or apply." },
      max: { type: "number", description: "sessions.max (default 256)." },
      residentMaxMB: { type: "number", description: "sessions.residentMaxBytes in MB (default 512)." },
      warmMax: { type: "number", description: "sessions.warmMax (default 8)." },
      warmMaxBytesMB: { type: "number", description: "sessions.warmMaxBytes in MB (default 64)." }
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: { text: { type: "string" } } },
      render: textRender((v) => v.text)
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted();
      const action = args.action === undefined ? "show" : String(args.action);
      if (action === "apply") {
        const result = await handleBiliRequest({ apply: true, max: args.max, residentMaxMB: args.residentMaxMB, warmMax: args.warmMax, warmMaxBytesMB: args.warmMaxBytesMB });
        return { text: "applied\nbefore  " + budgetLine(result.before) + "\nafter   " + budgetLine(result.after) + "\n" + result.restartNote + "\nfile " + result.after.file };
      }
      const budget = biliBudget(readBiliConfig());
      const wanted = budgetLine({ ...budget, max: num(args.max, c.bili.max), residentMaxMB: num(args.residentMaxMB, c.bili.residentMaxMB), warmMax: num(args.warmMax, c.bili.warmMax), warmMaxBytesMB: num(args.warmMaxBytesMB, c.bili.warmMaxBytesMB) });
      const live = c.bili.enabled ? JSON.stringify(await fetchBili(c.biliUrl, "/__bili/overview", 2500)).slice(0, 1200) : "disabled";
      return { text: "current " + budgetLine(budget) + "\n" + (action === "preview" ? "would be " + wanted + "\n" : "") + "config file " + biliConfigFile() + "\noverview " + live };
    }
  });

  log("info", "heap-guard ready: interval " + c.intervalSec + "s, slim " + (c.slim.enabled ? "on (level " + c.slim.level + ")" : "off") + ", state " + dir);
}

/** 面板按钮的服务端实现；toggle 型由工具包通用处理，不会走到这里。 */
export async function action(scope, actionId, body) {
  const rt = scope.runtime;
  if (rt === undefined) return { ok: false, reason: "feature not started" };
  const payload = obj(body);
  const count = (result) => {
    try {
      if (rt.counters === undefined) return result;
      if (result !== undefined && result !== null && result.ok === false) rt.counters.failed();
      else if (String(actionId).startsWith("slim")) rt.counters.slim();
    } catch { /* metrics must never break an action */ }
    return result;
  };
  if (actionId === "slim-biggest") return count(await rt.handleSlimRequest({ apply: true, level: payload.level, sessionId: payload.sessionId }));
  if (actionId === "slim-all") return count(await rt.cleanAll({ apply: true, level: payload.level, max: payload.max }));
  if (actionId === "slim-dry") return count(payload.sessionId === undefined ? await rt.handleSlimRequest({ apply: false, level: payload.level }) : await rt.handleSlimRequest({ apply: false, level: payload.level, sessionId: payload.sessionId }));
  if (actionId === "snapshot") return rt.handleSnapshot(payload);
  if (actionId === "title-refresh") { const out = rt.titleStore.force(Array.isArray(payload.ids) ? payload.ids : undefined); void rt.titleStore.tick(); return { ok: true, ...out }; }
  if (actionId === "bili-apply") return rt.handleBiliRequest({ apply: true, max: payload.max, residentMaxMB: payload.residentMaxMB, warmMax: payload.warmMax, warmMaxBytesMB: payload.warmMaxBytesMB });
  return { ok: false, reason: "unknown action " + String(actionId) };
}

export function status(scope) {
  const rt = scope.runtime;
  if (rt === undefined) return { level: "ok", headline: "未启动", lines: [] };
  return rt.currentStatus();
}

export default { id, title, subtitle, order, Config, settings, settingsSchema, actions, normalize, setup, action, status };

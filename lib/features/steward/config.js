/**
 * Steward 的静态配置面（评审第 8 项拆分的产物）：插件元数据、默认设置、
 * 运行时设置的校验 schema，以及把 scope.config 归一成数字的 normalize()。
 * index.js 原样 re-export 这里的 Config / actions / settings / settingsSchema / normalize。
 */
import z from "@deepseek-ai/schemastery";
import { DEFAULT_MODULES } from "./modules.js";

export const Config = z.object({
  tickSec: z.natural().default(5),
  titleSec: z.natural().default(60),
  stallMinutes: z.natural().default(8),
  journalDays: z.natural().default(30)
});

export const actions = [
  { id: "collect", kind: "button", label: "强制采样", hint: "立即对账一次 agent 列表、刷新会话名与健康数据" },
  { id: "flush", kind: "button", label: "落盘 journal", hint: "把内存里待写的观察记录立刻写进 journal-YYYYMMDD.jsonl" },
  { id: "digest", kind: "button", label: "立即汇报", hint: "把当前态势渲染成一段话走通知通道（受 notify.minSeverity 过滤）" },
  { id: "reload-rules", kind: "button", label: "重载规则", hint: "重新读内置规则与 rules/overrides/*.json" }
];

export const DEFAULTS = {
  notify: { minSeverity: "warning", larkEnabled: false, larkCommand: "lark-cli" },
  actions: { stallSteer: false, heapSlim: false },
  session: { mode: "manual", preset: "steward", title: "大内总管", model: "auto", rotateTurns: 200, rotateTokens: 300000 },
  federation: { hostId: "win-main", secret: "", peerUrl: "" },
  // actMode: "echo" 只把动作要发的 message 打进 journal/面板，等主人 ack 后再切 "live"。
  actMode: "echo",
  classifier: { enabled: true, provider: "", model: "", minConfidence: 0.55, maxPerTick: 2, timeoutMs: 12000, maxTokens: 120, ttlDays: 7 },
  export: { prometheus: true, intervalSec: 60, otlp: { enabled: false, endpoint: "", headers: {} } },
  budgetPerHour: 60,
  autoAct: false
};

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function settings(config) {
  const c = normalize(config);
  return Object.assign(clone(DEFAULTS), {
    modules: clone(DEFAULT_MODULES),
    pins: {},
    tickSec: c.tickSec,
    stallMinutes: c.stallMinutes
  });
}

/**
 * 运行时设置的校验 schema（P1-6）。面板与 HTTP 都会先深合并再校验：
 * actMode / budgetPerHour 这类会被 actuator 直接消费的字段必须在这里挡住非法值。
 */
export const settingsSchema = z.object({
  notify: z.object({
    minSeverity: z.union(["info", "warning", "error", "critical"]).default("warning"),
    larkEnabled: z.boolean().default(false),
    larkCommand: z.string().default("lark-cli")
  }).default({}),
  actions: z.object({
    stallSteer: z.boolean().default(false),
    heapSlim: z.boolean().default(false)
  }).default({}),
  session: z.object({
    mode: z.union(["manual", "auto"]).default("manual"),
    preset: z.string().default("steward"),
    title: z.string().default("大内总管"),
    model: z.string().default("auto"),
    rotateTurns: z.natural().default(200),
    rotateTokens: z.natural().default(300000)
  }).default({}),
  federation: z.object({
    hostId: z.string().default("win-main"),
    secret: z.string().default(""),
    peerUrl: z.string().default("")
  }).default({}),
  actMode: z.union(["echo", "live"]).default("echo"),
  classifier: z.object({
    enabled: z.boolean().default(true),
    provider: z.string().default(""),
    model: z.string().default(""),
    minConfidence: z.number().min(0).max(1).default(0.55),
    maxPerTick: z.natural().max(50).default(2),
    timeoutMs: z.natural().default(12000),
    maxTokens: z.natural().default(120),
    ttlDays: z.natural().default(7)
  }).default({}),
  export: z.object({
    prometheus: z.boolean().default(true),
    intervalSec: z.natural().min(5).default(60),
    otlp: z.object({
      enabled: z.boolean().default(false),
      endpoint: z.string().default(""),
      headers: z.any().default({})
    }).default({})
  }).default({}),
  budgetPerHour: z.natural().min(1).max(100000).default(60),
  autoAct: z.boolean().default(false),
  tickSec: z.natural().min(1).max(3600).default(5),
  stallMinutes: z.natural().min(1).max(1440).default(8),
  modules: z.any().default([]),
  pins: z.any().default({})
});

export function normalize(raw) {
  const v = raw !== null && typeof raw === "object" ? raw : {};
  function nat(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  }
  return {
    tickSec: nat(v.tickSec, 5),
    titleSec: nat(v.titleSec, 60),
    stallMinutes: nat(v.stallMinutes, 8),
    journalDays: nat(v.journalDays, 30)
  };
}

/**
 * 运行时设置：默认值（scope.config 归一后）深合并磁盘上的设置，再夹一层语义修正。
 * actMode 只认 "live"，其余一律按 "echo" —— 脏值绝不会让动作真的发出去。
 */
export function createReadSettings(scope) {
  return function readSettings() {
    let raw = {};
    try { raw = scope.settings.all(); } catch { raw = {}; }
    if (raw === null || typeof raw !== "object") raw = {};
    const d = settings(scope.config);
    const out = Object.assign({}, d, raw);
    out.notify = Object.assign({}, d.notify, raw.notify !== null && typeof raw.notify === "object" ? raw.notify : {});
    out.actions = Object.assign({}, d.actions, raw.actions !== null && typeof raw.actions === "object" ? raw.actions : {});
    out.session = Object.assign({}, d.session, raw.session !== null && typeof raw.session === "object" ? raw.session : {});
    out.federation = Object.assign({}, d.federation, raw.federation !== null && typeof raw.federation === "object" ? raw.federation : {});
    out.classifier = Object.assign({}, d.classifier, raw.classifier !== null && typeof raw.classifier === "object" ? raw.classifier : {});
    out.export = Object.assign({}, d.export, raw.export !== null && typeof raw.export === "object" ? raw.export : {});
    out.export.otlp = Object.assign({}, d.export.otlp, raw.export !== null && typeof raw.export === "object" && raw.export.otlp !== null && typeof raw.export.otlp === "object" ? raw.export.otlp : {});
    out.actMode = raw.actMode === "live" ? "live" : "echo";
    out.modules = Array.isArray(raw.modules) && raw.modules.length > 0 ? raw.modules : d.modules;
    out.pins = raw.pins !== null && typeof raw.pins === "object" ? raw.pins : {};
    out.autoAct = raw.autoAct === true;
    out.budgetPerHour = Number(raw.budgetPerHour) > 0 ? Math.floor(Number(raw.budgetPerHour)) : d.budgetPerHour;
    return out;
  };
}

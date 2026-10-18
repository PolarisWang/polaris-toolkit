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
  { id: "reload-rules", kind: "button", label: "重载能力", hint: "重连能力平面：重读内置能力实例与 settings.plane 里的编制" }
];

export const DEFAULTS = {
  notify: { minSeverity: "warning", larkEnabled: false, larkCommand: "lark-cli", larkDocEnabled: false, larkDocArgs: ["docs", "+create", "--title", "{title}", "--markdown", "{text}"] },
  actions: { stallSteer: false, heapSlim: false },
  session: { id: "", createdAt: 0, cwd: "", mode: "manual", preset: "steward", title: "大内总管", model: "auto", rotateTurns: 200, rotateTokens: 300000 },
  federation: { hostId: "win-main", secret: "", peerUrl: "" },
  // actMode: "echo" 只把动作要发的 message 打进 journal/面板，等主人 ack 后再切 "live"。
  actMode: "echo",
  classifier: { enabled: true, provider: "", model: "", minConfidence: 0.55, maxPerTick: 2, timeoutMs: 12000, maxTokens: 120, ttlDays: 7 },
  export: { prometheus: true, intervalSec: 60, otlp: { enabled: false, endpoint: "", headers: {} } },
  budgetPerHour: 60,
  autoAct: false,
  // 分级授权（C 方案）：L1 只通知、L2 只读动作（采样/瘦身/汇报）、L3 允许总管自己往会话里写
  // （派活、steer、cancel、新建会话）。人类在面板上的动作不受这一层限制 —— 它管的是总管的手。
  actLevel: "L2",
  // 升级退役：卡住的会话先 steer 叫醒、再 cancel、最后只报警让主人决定。
  escalation: { enabled: false, cooldownSec: 600, maxAttempts: 2, steerText: "" },
  // 交办：每 tick 最多自动派发多少单，0 表示只能手工点「派发」。
  tasks: { concurrency: 1, autoDispatch: true, maxAttempts: 3, retainDays: 14 },
  plane: { instances: [], stewards: [] }
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
    larkCommand: z.string().default("lark-cli"),
    larkDocEnabled: z.boolean().default(false),
    larkDocArgs: z.array(z.string()).default(["docs", "+create", "--title", "{title}", "--markdown", "{text}"])
  }).default({}),
  actions: z.object({
    stallSteer: z.boolean().default(false),
    heapSlim: z.boolean().default(false)
  }).default({}),
  session: z.object({
    id: z.string().default(""),
    createdAt: z.natural().default(0),
    cwd: z.string().default(""),
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
  actLevel: z.union(["L1", "L2", "L3"]).default("L2"),
  escalation: z.object({
    enabled: z.boolean().default(false),
    cooldownSec: z.natural().min(60).max(86400).default(600),
    maxAttempts: z.natural().min(1).max(5).default(2),
    steerText: z.string().default("")
  }).default({}),
  tasks: z.object({
    concurrency: z.natural().max(5).default(1),
    autoDispatch: z.boolean().default(true),
    retainDays: z.natural().min(1).max(3650).default(14),
    maxAttempts: z.natural().min(1).max(10).default(3)
  }).default({}),
  tickSec: z.natural().min(1).max(3600).default(5),
  stallMinutes: z.natural().min(1).max(1440).default(8),
  modules: z.any().default([]),
  pins: z.any().default({}),
  // 能力平面（P0-c）：实例表 + 编制表。结构由 plane/instances.js 与 plane/preset.js 校验，
  // 这里故意放开，避免用户自定义编制被 schemastery 拒掉。
  plane: z.any().default({})
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
    out.escalation = Object.assign({}, d.escalation, raw.escalation !== null && typeof raw.escalation === "object" ? raw.escalation : {});
    out.plane = raw.plane !== null && typeof raw.plane === "object" ? raw.plane : {};
    out.tasks = Object.assign({}, d.tasks, raw.tasks !== null && typeof raw.tasks === "object" ? raw.tasks : {});
    out.actMode = raw.actMode === "live" ? "live" : "echo";
    // 分级授权只认三个字面量，脏值一律退到 L2（不会意外放开写动作）。
    out.actLevel = raw.actLevel === "L1" || raw.actLevel === "L3" ? raw.actLevel : "L2";
    out.modules = Array.isArray(raw.modules) && raw.modules.length > 0 ? raw.modules : d.modules;
    out.pins = raw.pins !== null && typeof raw.pins === "object" ? raw.pins : {};
    out.autoAct = raw.autoAct === true;
    out.budgetPerHour = Number(raw.budgetPerHour) > 0 ? Math.floor(Number(raw.budgetPerHour)) : d.budgetPerHour;
    return out;
  };
}

/**
 * Steward: 模块归属的"agent 判断"层。
 *
 * 确定性路由（pin → 工作区前缀 → 标题正则）拿不到结论时，把 agent 的
 * cwd / 会话名 / 当前状态交给默认模型做一次极小判断（120 token 上限），
 * 结果落 module-cache.json 复用，避免每 5 秒重复调模型。
 *
 * 约束：
 *   · 只读 —— 只产出 { moduleId, confidence, reason }，由 index.js 决定是否写回记录。
 *   · 全降级 —— 拿不到 llm / agentDefaultModel / 模型报错 / JSON 不合法，
 *     一律返回 undefined，让调用方保持 unassigned，绝不让 tick 抛错。
 *   · 可关 —— settings.classifier.enabled=false 时完全不走模型。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const CACHE_VERSION = 1;
const CACHE_FILE = "module-cache.json";

function sha1(text) {
  return createHash("sha1").update(String(text)).digest("hex").slice(0, 16);
}

function normalizePath(value) {
  return String(value === undefined || value === null ? "" : value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 从模型输出里挑出唯一一个 JSON 结果；容忍代码围栏与前后废话。 */
export function parseDecision(text, ids) {
  const raw = String(text === undefined || text === null ? "" : text).replace(/```[a-zA-Z]*/g, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let value;
  try { value = JSON.parse(raw.slice(start, end + 1)); } catch { return undefined; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const moduleId = String(value.module === undefined ? (value.moduleId === undefined ? "" : value.moduleId) : value.module).trim();
  if (!ids.includes(moduleId)) return undefined;
  let confidence = Number(value.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.max(0, Math.min(1, confidence));
  const reason = String(value.reason === undefined ? "" : value.reason).replace(/\s+/g, " ").trim().slice(0, 60);
  return { moduleId, confidence, reason };
}

/** 把模块定义压成给模型看的一行清单。 */
function moduleLines(modules) {
  return modules
    .filter((mod) => mod.enabled !== false)
    .map((mod) => {
      const hints = [];
      if (Array.isArray(mod.workspaces) && mod.workspaces.length > 0) hints.push("工作区 " + mod.workspaces.join(", "));
      if (Array.isArray(mod.titles) && mod.titles.length > 0) hints.push("关键词 " + mod.titles.join(", "));
      return "- " + mod.id + " (" + mod.name + ")" + (hints.length === 0 ? "" : ": " + hints.join("; "));
    })
    .join("\n");
}

export function promptFor(modules, rec, question) {
  const ids = modules.filter((mod) => mod.enabled !== false).map((mod) => mod.id);
  const system = [
    "你是 DSH 多模块工作区的路由员：根据一个 agent 的工作目录、会话名和最近状态，判断它属于哪个模块。",
    "模块清单：",
    moduleLines(modules),
    "只输出一行 JSON：{\"module\":\"<模块id>\",\"confidence\":<0到1>,\"reason\":\"<12字以内的依据>\"}",
    "规则：工作目录路径是最强证据；会话名关键词次之；都不确定就选 unassigned，confidence 低于 0.5。不要输出任何其他文字。"
  ].join("\n");
  const facts = {
    cwd: rec.cwd === undefined ? undefined : String(rec.cwd),
    title: rec.title === undefined ? undefined : String(rec.title),
    status: rec.status === undefined ? undefined : String(rec.status),
    question: question === undefined ? undefined : String(question)
  };
  const user = "agent 事实：" + JSON.stringify(facts);
  return { system, user, ids };
}

function resolveRoute(ctx, cfg) {
  if (typeof cfg.provider === "string" && cfg.provider.length > 0 && typeof cfg.model === "string" && cfg.model.length > 0) {
    return { provider: cfg.provider, model: cfg.model };
  }
  try {
    const svc = ctx.get("agentDefaultModel");
    if (svc !== undefined && svc !== null && typeof svc.currentSelection === "function") {
      const selection = svc.currentSelection();
      if (selection !== null && typeof selection === "object" && typeof selection.provider === "string" && typeof selection.model === "string") {
        return { provider: selection.provider, model: selection.model };
      }
    }
  } catch { /* 降级 */ }
  return undefined;
}

/** 一次极小的非流式调用：只累加 text-delta。 */
async function callModel(ctx, route, prompt, timeoutMs, maxTokens) {
  const llm = ctx.get("llm");
  if (llm === undefined || llm === null || typeof llm.stream !== "function") throw new Error("llm service unavailable");
  const controller = new AbortController();
  const timer = setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, Math.max(2000, timeoutMs));
  try {
    let text = "";
    let failure;
    const options = {
      provider: route.provider,
      model: route.model,
      maxTokens,
      temperature: 0,
      system: prompt.system,
      messages: [{
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: prompt.user }],
        source: { kind: "plugin", plugin: "polaris-toolkit" }
      }],
      signal: controller.signal
    };
    for await (const chunk of llm.stream(options)) {
      if (chunk === null || chunk === undefined) continue;
      if (chunk.type === "text-delta") text += String(chunk.text === undefined ? "" : chunk.text);
      else if (chunk.type === "finish" && chunk.reason !== null && typeof chunk.reason === "object" && chunk.reason.kind === "error") {
        failure = chunk.reason.failure;
      }
    }
    if (failure !== undefined) throw new Error(String(failure.message === undefined ? "model error" : failure.message));
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export function createClassifier({ ctx, dir, log, readSettings }) {
  const file = path.join(dir, CACHE_FILE);
  let cache = undefined; // { v, entries: { key: { m, c, r, at, model } } }
  let dirty = false;
  let lastError;
  let calls = 0;
  const inFlight = new Set();

  function cfg() {
    const s = readSettings();
    const c = s.classifier !== null && typeof s.classifier === "object" ? s.classifier : {};
    return {
      enabled: c.enabled !== false,
      provider: typeof c.provider === "string" ? c.provider : "",
      model: typeof c.model === "string" ? c.model : "",
      minConfidence: Number.isFinite(Number(c.minConfidence)) ? Math.max(0, Math.min(1, Number(c.minConfidence))) : 0.55,
      timeoutMs: Number.isFinite(Number(c.timeoutMs)) ? Math.max(2000, Math.min(60000, Number(c.timeoutMs))) : 12000,
      maxTokens: Number.isFinite(Number(c.maxTokens)) ? Math.max(32, Math.min(512, Number(c.maxTokens))) : 120,
      maxPerTick: Number.isFinite(Number(c.maxPerTick)) ? Math.max(0, Math.min(6, Number(c.maxPerTick))) : 2,
      ttlDays: Number.isFinite(Number(c.ttlDays)) ? Math.max(1, Math.min(90, Number(c.ttlDays))) : 7
    };
  }

  function load() {
    if (cache !== undefined) return cache;
    cache = { v: CACHE_VERSION, entries: {} };
    try {
      if (!fs.existsSync(file)) return cache;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed === null || typeof parsed !== "object" || parsed.v !== CACHE_VERSION || parsed.entries === null || typeof parsed.entries !== "object") return cache;
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (entry === null || typeof entry !== "object") continue;
        if (typeof entry.m !== "string" || !Number.isFinite(entry.at)) continue;
        cache.entries[key] = { m: entry.m, c: Number(entry.c) || 0, r: String(entry.r === undefined ? "" : entry.r), at: Number(entry.at), model: String(entry.model === undefined ? "" : entry.model) };
      }
    } catch (error) {
      lastError = String(error);
    }
    return cache;
  }

  function save() {
    if (!dirty) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, at: Date.now(), entries: load().entries }), "utf8");
      fs.renameSync(tmp, file);
      dirty = false;
    } catch (error) {
      lastError = String(error);
      log("warn", "steward: module-cache save failed: " + lastError);
    }
  }

  function keyOf(rec, ids) {
    const cwd = normalizePath(rec.cwd);
    const title = String(rec.title === undefined ? "" : rec.title).trim().toLowerCase();
    return sha1(cwd + "|" + title + "|" + ids.join(","));
  }

  function fresh(entry, ttlDays) {
    return entry !== undefined && Date.now() - entry.at <= ttlDays * 86400000;
  }

  /** 同步查缓存：routeAll 用它把已有结论直接拼进路由，不发网络请求。 */
  function peek(rec, modules) {
    if (!cfg().enabled) return undefined;
    const ids = modules.filter((mod) => mod.enabled !== false).map((mod) => mod.id);
    const entry = load().entries[keyOf(rec, ids)];
    if (!fresh(entry, cfg().ttlDays)) return undefined;
    if (entry.m === "unassigned") return undefined;
    return { moduleId: entry.m, confidence: entry.c, reason: entry.r };
  }

  function remember(rec, modules, decision, route) {
    const ids = modules.filter((mod) => mod.enabled !== false).map((mod) => mod.id);
    load().entries[keyOf(rec, ids)] = {
      m: decision.moduleId, c: decision.confidence, r: decision.reason, at: Date.now(),
      model: route.provider + "/" + route.model
    };
    dirty = true;
    save();
  }

  function forget(rec, modules) {
    const ids = modules.filter((mod) => mod.enabled !== false).map((mod) => mod.id);
    const key = keyOf(rec, ids);
    if (load().entries[key] !== undefined) { delete load().entries[key]; dirty = true; save(); }
  }

  /** 走一次模型判断。失败/低置信一律返回 undefined。 */
  async function classify(rec, modules, question) {
    const c = cfg();
    if (!c.enabled) return undefined;
    if (inFlight.has(rec.id)) return undefined;
    if (rec.cwd === undefined && (rec.title === undefined || String(rec.title).trim().length < 2)) return undefined;
    const route = resolveRoute(ctx, c);
    if (route === undefined) { lastError = "no model route"; return undefined; }
    inFlight.add(rec.id);
    calls += 1;
    try {
      const prompt = promptFor(modules, rec, question);
      const text = await callModel(ctx, route, prompt, c.timeoutMs, c.maxTokens);
      const decision = parseDecision(text, prompt.ids);
      if (decision === undefined) {
        lastError = "unparsable model output";
        log("debug", "steward: classifier unparsable output: " + text.slice(0, 120));
        return undefined;
      }
      if (decision.moduleId === "unassigned" || decision.confidence < c.minConfidence) {
        remember(rec, modules, { moduleId: "unassigned", confidence: decision.confidence, reason: decision.reason }, route);
        return undefined;
      }
      remember(rec, modules, decision, route);
      lastError = undefined;
      return { moduleId: decision.moduleId, confidence: decision.confidence, reason: decision.reason, model: route.provider + "/" + route.model };
    } catch (error) {
      lastError = String(error !== null && error !== undefined && error.message !== undefined ? error.message : error);
      log("debug", "steward: classifier failed: " + lastError);
      return undefined;
    } finally {
      inFlight.delete(rec.id);
    }
  }

  function reserve(rec) {
    return !inFlight.has(rec.id);
  }

  function stats() {
    const c = cfg();
    const route = resolveRoute(ctx, c);
    const entries = Object.values(load().entries);
    return {
      enabled: c.enabled,
      minConfidence: c.minConfidence,
      ttlDays: c.ttlDays,
      model: route === undefined ? "" : route.provider + "/" + route.model,
      cached: entries.length,
      decided: entries.filter((e) => e.m !== "unassigned").length,
      calls,
      inFlight: inFlight.size,
      lastError
    };
  }

  return { file, cfg, peek, classify, reserve, remember, forget, stats, save };
}

export default { createClassifier, parseDecision, promptFor };

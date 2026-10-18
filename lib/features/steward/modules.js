import { homedir } from "node:os";
import path from "node:path";

/**
 * Steward: 模块定义与路由（只做确定性路由，不做 LLM 兜底）。
 *
 * 路由顺序（docs/design-capability-plane.md）：pin → 工作区前缀 → 标题正则 → unassigned。
 * 每次归属都带 reason/confidence，面板能看到"为什么归到这个模块"。
 */

/**
 * DSH 自身的目录：跨机器可推导，不含任何个人路径。
 * 宿主进程里 process.execPath 是 DSH 的启动器；命令行里则是 node.exe，推导结果同样安全。
 */
function dshWorkspaces() {
  const out = [];
  const home = homedir();
  if (home) out.push(path.join(home, ".dsh"));
  const exe = process.execPath;
  if (exe) {
    const dir = path.dirname(exe);
    out.push(dir, path.resolve(dir, "..", ".."));
  }
  return out.filter((p, i) => Boolean(p) && out.indexOf(p) === i);
}

/** 默认模块清单：只描述"存在哪一类工作"，不含作者机器的绝对路径；用户可在面板里增删改。 */
export function defaultModules() {
  return [
    { id: "ev", name: "EV 引擎", host: "local", enabled: true, titles: ["ev", "ev引擎", "ev 引擎", "evidence"], workspaces: [] },
    { id: "cb2", name: "CB2 引擎", host: "local", enabled: true, titles: ["cb2", "cb2引擎", "cb2 引擎"], workspaces: [] },
    { id: "il2cpp", name: "IL2CPP", host: "local", enabled: true, titles: ["il2cpp", "il2cpp开发", "unity", "unreal", "ue"], workspaces: [] },
    { id: "dsh", name: "DSH", host: "local", enabled: true, titles: ["dsh", "harness", "polaris", "heap", "session", "plugin"], workspaces: dshWorkspaces() },
    { id: "unassigned", name: "未归类", host: "local", enabled: true, titles: [], workspaces: [] }
  ];
}

export const DEFAULT_MODULES = defaultModules();

export function normalizeModules(raw) {
  const list = Array.isArray(raw) ? raw : DEFAULT_MODULES;
  const out = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const id = typeof item.id === "string" && item.id.length > 0 ? item.id : undefined;
    if (id === undefined) continue;
    out.push({
      id,
      name: typeof item.name === "string" ? item.name : id,
      host: typeof item.host === "string" ? item.host : "local",
      enabled: item.enabled !== false,
      titles: Array.isArray(item.titles) ? item.titles.filter((t) => typeof t === "string" && t.length > 0) : [],
      workspaces: Array.isArray(item.workspaces) ? item.workspaces.filter((w) => typeof w === "string" && w.length > 0) : []
    });
  }
  if (!out.some((m) => m.id === "unassigned")) out.push({ id: "unassigned", name: "未归类", host: "local", enabled: true, titles: [], workspaces: [] });
  return out;
}

function normalizePath(value) {
  return String(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 给一条 agent 记录定模块。返回 { moduleId, reason, confidence }。
 * pins 允许按 agentId 或 sessionId 指定，手工改一次就永久生效（落 settings）。
 */
export function routeAgent(rec, { modules, pins, title }) {
  const byId = pins !== undefined && rec.id !== undefined ? pins[rec.id] : undefined;
  if (typeof byId === "string" && byId.length > 0) return { moduleId: byId, reason: "pinned:agent", confidence: 1 };
  const bySession = pins !== undefined && rec.sessionId !== undefined ? pins[rec.sessionId] : undefined;
  if (typeof bySession === "string" && bySession.length > 0) return { moduleId: bySession, reason: "pinned:session", confidence: 1 };

  const cwd = rec.cwd === undefined ? undefined : normalizePath(rec.cwd);
  if (cwd !== undefined) {
    let best;
    for (const mod of modules) {
      for (const ws of mod.workspaces) {
        const prefix = normalizePath(ws);
        if (prefix.length > 0 && (cwd === prefix || cwd.startsWith(prefix + "/"))) {
          if (best === undefined || prefix.length > best.len) best = { moduleId: mod.id, len: prefix.length, ws };
        }
      }
    }
    if (best !== undefined) return { moduleId: best.moduleId, reason: "workspace:" + best.ws, confidence: 0.95 };
  }

  const text = (title === undefined ? "" : String(title)).toLowerCase();
  if (text.length > 0) {
    for (const mod of modules) {
      for (const pattern of mod.titles) {
        if (text.includes(String(pattern).toLowerCase())) return { moduleId: mod.id, reason: "title:" + pattern, confidence: 0.7 };
      }
    }
  }
  return { moduleId: "unassigned", reason: "fallback", confidence: 0 };
}

export function applyRouting(rec, routing) {
  rec.moduleId = routing.moduleId;
  rec.routeReason = routing.reason;
  rec.routeConfidence = routing.confidence;
  return rec;
}

export default { DEFAULT_MODULES, defaultModules, normalizeModules, routeAgent, applyRouting };

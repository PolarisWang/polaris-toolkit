/**
 * Steward: 模块定义与路由（P0 只做确定性路由，LLM 兜底在 P1 接入）。
 *
 * 路由顺序（docs/steward-design.md 9 章）：pin → 工作区前缀 → 标题正则 → unassigned。
 * 每次归属都带 reason/confidence，面板能看到"为什么归到这个模块"。
 */

export const DEFAULT_MODULES = [
  { id: "ev", name: "EV 引擎", host: "win-main", enabled: true, titles: ["ev", "ev引擎", "ev 引擎", "evidence"], workspaces: [] },
  { id: "cb2", name: "CB2 引擎", host: "win-main", enabled: true, titles: ["cb2", "cb2引擎", "cb2 引擎"], workspaces: [] },
  { id: "il2cpp", name: "IL2CPP", host: "win-main", enabled: true, titles: ["il2cpp", "il2cpp开发", "unity"], workspaces: ["D:\\agent\\il2cpp", "D:\\agent\\chaos-il2cpp", "G:\\ue\\UnrealEngine6"] },
  { id: "dsh", name: "DSH", host: "win-main", enabled: true, titles: ["dsh", "harness", "polaris", "heap", "session", "plugin"], workspaces: ["D:\\agent\\deepseek-harness", "D:\\agent\\polaris-toolkit", "C:\\Users\\haochuan.wang\\AppData\\Local\\Programs\\DeepSeek Harness", "C:\\Users\\haochuan.wang\\.dsh"] },
  { id: "unassigned", name: "未归类", host: "win-main", enabled: true, titles: [], workspaces: [] }
];

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

export default { DEFAULT_MODULES, normalizeModules, routeAgent, applyRouting };

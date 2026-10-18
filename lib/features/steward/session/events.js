/**
 * 会话事件的读取层（C 方案"眼"的地基）。
 *
 * sessionQuery.listEvents 每次都会把整份日志读一遍再解析，面板 5 秒轮询 × 多个会话
 * 足以把宿主堆顶上去。这里按 sessionId 加一层短 TTL 缓存，并把缓存条目数钉死，
 * 让"看会话"这件事的代价与刷新频率解耦。
 */
const DEFAULT_TTL = 4000;
const MAX_ENTRIES = 24;

/** 从 message.content / user-message.content 里拼出纯文本。 */
export function textOf(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (part === null || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n").trim();
}

/** 第一条 tool-call 的名字，用来给聊天记录里的工具调用起个短标签。 */
export function toolNameOf(content) {
  if (!Array.isArray(content)) return "";
  for (const part of content) {
    if (part !== null && typeof part === "object" && part.type === "tool-call" && typeof part.name === "string") return part.name;
  }
  return "";
}

export function createEventReader({ scope, log }) {
  const cache = new Map();

  function query() {
    try { return scope.ctx.get("sessionQuery"); } catch { return undefined; }
  }

  function trim() {
    while (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
  }

  async function read(sessionId, ttlMs) {
    const id = String(sessionId === undefined || sessionId === null ? "" : sessionId).trim();
    if (id === "") return undefined;
    const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_TTL;
    const now = Date.now();
    const hit = cache.get(id);
    if (hit !== undefined && now - hit.at < ttl) return hit.events;
    const q = query();
    if (q === undefined || typeof q.listEvents !== "function") return undefined;
    let list;
    try { list = await q.listEvents(id); }
    catch (error) { log("debug", "steward: read events " + id + " failed: " + String(error)); return undefined; }
    if (!Array.isArray(list)) return undefined;
    cache.delete(id);
    cache.set(id, { at: now, events: list });
    trim();
    return list;
  }

  return {
    read,
    forget(sessionId) { cache.delete(String(sessionId)); },
    clear() { cache.clear(); },
    size() { return cache.size; }
  };
}

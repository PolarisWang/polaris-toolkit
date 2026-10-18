/**
 * Steward: 会话名（只读缓存）。
 *
 * 宿主在 0.2.1 提供 sessionQuery.readTitleSnapshots(ids)，返回 settled 数组
 * （{status:"fulfilled", value:{session, title?}}）。拿不到就退回"会话 id 前 8 位"，
 * 任何异常都只降级不抛。
 */
const TTL_MS = 15_000;

export function createTitleSource({ ctx, log }) {
  const cache = new Map();
  let lastAt = 0;
  let lastError;

  async function refresh(sessionIds) {
    const now = Date.now();
    if (now - lastAt < TTL_MS) return cache;
    lastAt = now;
    let query;
    try { query = ctx.get("sessionQuery"); } catch { query = undefined; }
    if (query === undefined || typeof query.readTitleSnapshots !== "function") return cache;
    const ids = Array.from(new Set((sessionIds || []).filter((v) => typeof v === "string" && v.length > 0))).slice(0, 80);
    if (ids.length === 0) return cache;
    try {
      const out = await query.readTitleSnapshots(ids);
      if (Array.isArray(out)) {
        for (const item of out) {
          if (item === null || typeof item !== "object" || item.status !== "fulfilled") continue;
          const value = item.value === undefined ? {} : item.value;
          const session = value.session;
          const sid = session === undefined || session === null ? undefined : (typeof session === "string" ? session : session.id);
          const title = typeof value.title === "string" && value.title.length > 0 ? value.title : undefined;
          if (sid !== undefined) cache.set(String(sid), title);
        }
      }
    } catch (error) {
      lastError = String(error);
      if (log !== undefined) log("debug", "steward: title refresh failed: " + lastError);
    }
    return cache;
  }

  function get(sessionId) {
    if (sessionId === undefined || sessionId === null) return undefined;
    return cache.get(String(sessionId));
  }

  function size() { return cache.size; }
  function error() { return lastError; }

  return { refresh, get, size, error, cache };
}

export default { createTitleSource };

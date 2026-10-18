/**
 * Steward: 会话名（只读缓存）。
 *
 * 三个来源，按优先级降级：
 *   1. 宿主 sessionQuery.readTitleSnapshots(ids)（0.2.1 真实存在的服务）
 *   2. Heap Guard 的标题缓存（它已经用子进程扫过 session/title 事件）
 *   3. 都没有 → 调用方显示 "session <前 8 位>"
 *
 * 键统一规范成裸 uuid（agent id 是 "session-<uuid>"，会话 id 是裸 uuid），
 * 两种形式都写进 cache，查的时候也归一化，避免两套键永不相交。
 * 任何异常都只降级不抛。
 */
const TTL_MS = 15_000;
const PREFIX = "session-";

function norm(id) {
  if (id === undefined || id === null) return undefined;
  const s = String(id);
  if (s.length === 0) return undefined;
  return s.startsWith(PREFIX) ? s.slice(PREFIX.length) : s;
}

export function createTitleSource({ ctx, log, fallback }) {
  const cache = new Map();
  let lastAt = 0;
  let lastError;

  function put(id, title) {
    if (typeof title !== "string" || title.length === 0) return;
    const key = norm(id);
    if (key === undefined) return;
    cache.set(key, title);
    cache.set(PREFIX + key, title);
  }

  function putAll(rows) {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue;
      put(row.id !== undefined ? row.id : row.sessionId, row.title);
    }
  }

  async function refresh(sessionIds) {
    const now = Date.now();
    const ids = Array.from(new Set((sessionIds || []).map(norm).filter((v) => typeof v === "string" && v.length > 0))).slice(0, 80);
    if (now - lastAt < TTL_MS) return cache;
    lastAt = now;

    let query;
    try { query = ctx.get("sessionQuery"); } catch { query = undefined; }
    if (query !== undefined && typeof query.readTitleSnapshots === "function" && ids.length > 0) {
      try {
        const out = await query.readTitleSnapshots(ids);
        if (Array.isArray(out)) {
          for (const item of out) {
            if (item === null || typeof item !== "object" || item.status !== "fulfilled") continue;
            const value = item.value === undefined ? {} : item.value;
            const session = value.session;
            const sid = session === undefined || session === null ? undefined : (typeof session === "string" ? session : session.id);
            put(sid, value.title);
          }
        }
      } catch (error) {
        lastError = String(error);
        if (log !== undefined) log("debug", "steward: title refresh failed: " + lastError);
      }
    }

    // Heap Guard 的缓存是兜底：它扫的是磁盘日志，能覆盖 sessionQuery 拿不到的会话。
    if (typeof fallback === "function") {
      try { putAll(fallback()); } catch (error) { lastError = String(error); }
    }
    return cache;
  }

  function get(sessionId) {
    const key = norm(sessionId);
    if (key === undefined) return undefined;
    return cache.get(key);
  }

  function size() {
    let n = 0;
    for (const key of cache.keys()) if (!key.startsWith(PREFIX)) n += 1;
    return n;
  }
  function error() { return lastError; }

  return { refresh, get, size, error, cache };
}

export default { createTitleSource };

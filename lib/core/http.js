/**
 * Tiny HTTP helpers: one router per feature, plus body parsing and response
 * writers that never throw on an already-closed socket.
 */
export function sendJson(res, status, value) {
  const body = JSON.stringify(value === undefined ? null : value);
  try {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(body);
  } catch {
    /* socket already gone */
  }
}

export function sendText(res, status, contentType, body) {
  try {
    res.statusCode = status;
    res.setHeader("content-type", contentType);
    res.setHeader("cache-control", "no-store");
    res.end(body);
  } catch {
    /* socket already gone */
  }
}

export function sendHtml(res, status, body) {
  sendText(res, status, "text/html; charset=utf-8", body);
}

export function readBody(req, cap = 65536) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > cap) {
        resolve({ ok: false, error: "body too large" });
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => resolve({ ok: false, error: "request error" }));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw.length === 0) return resolve({ ok: true, value: {} });
      try {
        const value = JSON.parse(raw);
        if (value !== null && typeof value === "object" && !Array.isArray(value)) return resolve({ ok: true, value });
        return resolve({ ok: true, value: { value } });
      } catch {
        return resolve({ ok: false, error: "invalid json body" });
      }
    });
  });
}

/** Exact-match router; the last "*" rule is the fallback. */
export function createRouter() {
  const exact = new Map();
  let fallback = null;
  return {
    add(method, routePath, handler) {
      if (routePath === "*") fallback = handler;
      else exact.set(String(method).toUpperCase() + " " + routePath, handler);
    },
    async handle(req, res, sub) {
      const handler = exact.get(String(req.method).toUpperCase() + " " + sub);
      if (handler !== undefined) {
        await handler(req, res, sub);
        return true;
      }
      if (fallback !== null) {
        await fallback(req, res, sub);
        return true;
      }
      return false;
    },
    size() { return exact.size; }
  };
}

export function queryOf(req) {
  try { return new URL(req.url === undefined ? "/" : req.url, "http://local").searchParams; } catch { return new URLSearchParams(); }
}

export function intOf(value, fallback, min, max) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

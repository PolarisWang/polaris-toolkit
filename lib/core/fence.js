/**
 * Same-origin trust fence for the plugin HTTP routes.
 *
 * Deliberately self-contained (copies the semantics of the shipped plugins'
 * trust-fence helper instead of importing another plugin's internals, which
 * are not a stable API).
 *
 * 两层（评审 P0-3）：
 *   1) fence：只允许 loopback / 已登记的可信 authority，挡掉跨站页面；
 *   2) token：所有 mutating 请求必须带安装级随机令牌（x-polaris-token 头、
 *      Authorization: Bearer 或 polaris_token cookie），挡掉本机其它用户与
 *      不读状态目录的脚本。只读 GET 不受第二层限制。
 */
import crypto from "node:crypto";

/** localhost, ::1, [::1] or a dotted-quad 127.x.x.x. */
export function isLoopbackHostname(hostname) {
  if (typeof hostname !== "string" || hostname.length === 0) return false;
  const h = hostname.trim().toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  if (/^127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(h)) return true;
  return false;
}

/** Authority (host[:port]) of the Host header, lowercased, or "". */
export function requestAuthority(request) {
  const raw = request.headers === undefined ? undefined : request.headers.host;
  if (typeof raw !== "string" || raw.length === 0) return "";
  return raw.trim().toLowerCase();
}

function authorityHost(authority) {
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    return end < 0 ? authority : authority.slice(0, end + 1);
  }
  const colon = authority.indexOf(":");
  return colon < 0 ? authority : authority.slice(0, colon);
}

/**
 * true when the request may talk to this plugin's routes.
 *
 * trustedHosts entries are authorities ("host" or "host:port"); the canonical
 * host part also matches a trusted host with any port.
 */
export function isTrustedApiRequest(request, trustedHosts) {
  const authority = requestAuthority(request);
  if (authority.length === 0) return false;
  const site = request.headers === undefined ? undefined : request.headers["sec-fetch-site"];
  if (typeof site === "string" && site.toLowerCase() === "cross-site") return false;
  const hostname = authorityHost(authority);
  if (isLoopbackHostname(hostname)) return true;
  const list = Array.isArray(trustedHosts) ? trustedHosts : [];
  for (const entry of list) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    const t = entry.trim().toLowerCase();
    if (t === authority) return true;
    if (authorityHost(t) === hostname) return true;
  }
  return false;
}

export const TOKEN_HEADER = "x-polaris-token";
export const TOKEN_COOKIE = "polaris_token";

/** 从请求里取写令牌：显式头 → Bearer → cookie。 */
export function tokenOf(request) {
  const headers = request === undefined || request === null || request.headers === undefined ? {} : request.headers;
  const direct = headers[TOKEN_HEADER];
  if (typeof direct === "string" && direct.trim() !== "") return direct.trim();
  const auth = headers.authorization;
  if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const cookie = headers.cookie;
  if (typeof cookie === "string") {
    for (const part of cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() !== TOKEN_COOKIE) continue;
      const raw = part.slice(eq + 1).trim();
      try { return decodeURIComponent(raw); } catch { return raw; }
    }
  }
  return "";
}

/** 常数时间比较；expected 为空表示这台机器没启用令牌，一律拒绝。 */
export function tokenMatches(expected, provided) {
  if (typeof expected !== "string" || expected.length === 0) return false;
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(provided).digest();
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

/** true for POST/PUT/PATCH/DELETE；GET/HEAD/OPTIONS 视为只读。 */
export function isMutating(method) {
  const m = String(method === undefined || method === null ? "GET" : method).toUpperCase();
  return m !== "GET" && m !== "HEAD" && m !== "OPTIONS";
}

export function writeJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

export function writeText(res, status, contentType, body) {
  res.statusCode = status;
  res.setHeader("content-type", contentType);
  res.setHeader("cache-control", "no-store");
  res.end(body);
}
/**
 * Same-origin trust fence for the plugin HTTP routes.
 *
 * Deliberately self-contained (copies the semantics of the shipped plugins'
 * trust-fence helper instead of importing another plugin's internals, which
 * are not a stable API).
 */

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
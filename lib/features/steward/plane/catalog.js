/**
 * 能力目录（能力平面 §1）：一条能力 = id + 四要素
 * （payload 载荷 / carrier 载体 / target 接收者 / protocol 协议）+ 参数 schema + 限流。
 *
 * 目录只管"有哪些能力、参数是否合法"，不管决策 —— 决策只有一处：主管自己的决策树。
 * 载体实现（IO）在 carriers.js，首批实例在 instances.js。
 */
export const PAYLOADS = ["notice", "report", "record", "directive", "answer", "query", "verdict", "plan", "data"];
export const CARRIERS = ["desktop", "lark.im", "lark.doc", "session", "task", "tool", "peer", "llm", "file", "expr", "tree"];
export const PROTOCOLS = ["fire", "ack", "ask", "stream"];
export const TARGET_KINDS = ["owner", "steward", "session", "module", "task", "host", "workspace", "doc", "peer", "text", "store", "trace", "engine", "facts"];
export const GRANTS = ["denied", "dry-run", "act", "autonomous"];

const ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export function parseTarget(ref) {
  const s = String(ref === undefined || ref === null ? "" : ref);
  const cut = s.indexOf(":");
  if (cut < 0) return { kind: "", id: s };
  return { kind: s.slice(0, cut), id: s.slice(cut + 1) };
}

export function targetMatches(pattern, ref) {
  if (pattern === undefined || pattern === null || pattern === "") return true;
  const list = Array.isArray(pattern) ? pattern : [pattern];
  const want = String(ref === undefined || ref === null ? "" : ref);
  return list.some(function (p) {
    const s = String(p);
    if (s === "*") return true;
    if (s.endsWith("*")) return want.startsWith(s.slice(0, -1));
    return s === want;
  });
}

export function createCatalog(options) {
  const opts = options === undefined ? {} : options;
  const log = typeof opts.log === "function" ? opts.log : function () {};
  const defs = new Map();

  function errorsOf(spec) {
    const out = [];
    if (spec === null || typeof spec !== "object") return ["spec must be an object"];
    if (typeof spec.id !== "string" || !ID_RE.test(spec.id)) out.push("bad id: " + String(spec.id));
    if (PAYLOADS.indexOf(spec.payload) < 0) out.push("bad payload: " + String(spec.payload));
    if (CARRIERS.indexOf(spec.carrier) < 0) out.push("bad carrier: " + String(spec.carrier));
    if (PROTOCOLS.indexOf(spec.protocol) < 0) out.push("bad protocol: " + String(spec.protocol));
    const targets = spec.targets !== undefined ? spec.targets : (spec.target !== undefined ? [spec.target] : []);
    if (!Array.isArray(targets) || targets.length === 0) out.push("targets required");
    else for (const t of targets) {
      const parsed = parseTarget(t);
      const kind = parsed.kind === "" ? parsed.id : parsed.kind;
      if (kind !== "*" && TARGET_KINDS.indexOf(kind) < 0) out.push("bad target kind: " + String(t));
    }
    if (spec.grant !== undefined && GRANTS.indexOf(spec.grant) < 0) out.push("bad grant: " + String(spec.grant));
    return out;
  }

  function define(spec) {
    const errors = errorsOf(spec);
    if (errors.length > 0) throw new Error("invalid capability: " + errors.join("; "));
    if (defs.has(spec.id)) throw new Error("duplicate capability: " + spec.id);
    const norm = Object.assign({}, spec);
    norm.targets = (spec.targets !== undefined ? spec.targets : [spec.target]).slice();
    norm.grant = spec.grant === undefined ? "act" : spec.grant;
    norm.params = spec.params !== undefined && typeof spec.params === "object" ? spec.params : {};
    norm.tags = Array.isArray(spec.tags) ? spec.tags.slice() : [];
    const limits = spec.limits !== undefined && typeof spec.limits === "object" ? spec.limits : {};
    norm.limits = {
      budgetPerHour: Number(limits.budgetPerHour) > 0 ? Math.floor(Number(limits.budgetPerHour)) : 0,
      cooldownSec: Number(limits.cooldownSec) > 0 ? Math.floor(Number(limits.cooldownSec)) : 0,
      timeoutMs: Number(limits.timeoutMs) > 0 ? Math.floor(Number(limits.timeoutMs)) : 15000,
      maxAttempts: Number(limits.maxAttempts) > 0 ? Math.floor(Number(limits.maxAttempts)) : 1
    };
    defs.set(norm.id, norm);
    return norm;
  }

  function defineAll(list) {
    const out = [];
    for (const spec of Array.isArray(list) ? list : []) out.push(define(spec));
    return out;
  }

  function get(id) {
    return defs.get(String(id === undefined || id === null ? "" : id));
  }

  function has(id) {
    return defs.has(String(id));
  }

  function list(filter) {
    const f = filter === undefined || filter === null ? {} : filter;
    const out = [];
    for (const spec of defs.values()) {
      if (f.payload !== undefined && spec.payload !== f.payload) continue;
      if (f.carrier !== undefined && spec.carrier !== f.carrier) continue;
      if (f.protocol !== undefined && spec.protocol !== f.protocol) continue;
      if (f.tag !== undefined && spec.tags.indexOf(f.tag) < 0) continue;
      if (f.q !== undefined && String(f.q) !== "" && spec.id.indexOf(String(f.q)) < 0 && String(spec.title === undefined ? "" : spec.title).indexOf(String(f.q)) < 0) continue;
      out.push(spec);
    }
    return out.sort(function (a, b) { return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); });
  }

  function pick(payload, carrier) {
    const all = list({ payload: payload, carrier: carrier });
    return all.length === 0 ? undefined : all[0];
  }

  function validateParams(id, params) {
    const spec = get(id);
    if (spec === undefined) return { ok: false, error: "unknown-capability:" + String(id) };
    const input = params === undefined || params === null ? {} : params;
    if (typeof spec.schema === "function") {
      try {
        const value = spec.schema(input);
        return { ok: true, value: value === undefined ? input : value };
      } catch (error) {
        return { ok: false, error: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error) };
      }
    }
    if (spec.schema !== null && typeof spec.schema === "object" && typeof spec.schema.validate === "function") {
      try {
        const value = spec.schema.validate(input);
        return { ok: true, value: value === undefined ? input : value };
      } catch (error) {
        return { ok: false, error: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error) };
      }
    }
    if (typeof spec.check === "function") {
      try {
        const res = spec.check(input);
        if (res === undefined) return { ok: true, value: input };
        return res;
      } catch (error) {
        return { ok: false, error: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error) };
      }
    }
    return { ok: true, value: input };
  }

  function describe() {
    const byPayload = {};
    const byCarrier = {};
    for (const spec of defs.values()) {
      byPayload[spec.payload] = (byPayload[spec.payload] === undefined ? 0 : byPayload[spec.payload]) + 1;
      byCarrier[spec.carrier] = (byCarrier[spec.carrier] === undefined ? 0 : byCarrier[spec.carrier]) + 1;
    }
    return { count: defs.size, byPayload: byPayload, byCarrier: byCarrier, ids: Array.from(defs.keys()) };
  }

  function clear() {
    const n = defs.size;
    defs.clear();
    return n;
  }

  /** 实例表的指纹：/api/rules 的 hash 契约改为"能力表指纹"。 */
  function hash() {
    let h = 2166136261;
    for (const id of Array.from(defs.keys()).sort()) {
      for (let i = 0; i < id.length; i += 1) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
    }
    return "plane-" + h.toString(16);
  }

  return {
    define: define,
    defineAll: defineAll,
    clear: clear,
    hash: hash,
    get: get,
    has: has,
    list: list,
    pick: pick,
    validateParams: validateParams,
    describe: describe,
    size: function () { return defs.size; },
    ids: function () { return Array.from(defs.keys()); },
    errorsOf: errorsOf
  };
}

/**
 * 路由矩阵（能力平面 §4）：能不能把某个能力发给某一类对象 —— allow / approval / deny。
 *
 * 四条地址解析规则写死（不可配置关闭）：
 *   1. 实例参数指定 sessionId / target → 用它（管线的 effectiveTarget）
 *   2. 未指定 → 用该主管的 voice.sessionId（编制把它放进 ctx.voiceSessionId）
 *   3. voice.mode = virtual 且能力是 session.* 且没有显式目标 → 拒绝（体检页报 no-voice）
 *   4. 主管永不接收也不作用于自己的 voice 会话（管线按 selfSessionId 判 self-target）
 *
 * 配置：settings.plane.routes = { default: "allow", rules: [{ steward, cap, target, route }] }
 * 规则按顺序匹配，第一个命中生效；每一格支持 * 与 session:* 两种通配。
 */
import { targetMatches } from "./catalog.js";

export const ROUTES = ["allow", "approval", "deny"];
export const SESSION_CAPS = ["steer.session", "cancel.session", "session.create"];

function str(v, fallback) { return v === undefined || v === null ? fallback : String(v); }

export function normalizeRoutes(raw) {
  const r = raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw) ? {} : raw;
  const def = str(r.default, "allow");
  const out = { default: ROUTES.indexOf(def) >= 0 ? def : "allow", rules: [], errors: [] };
  const list = Array.isArray(r.rules) ? r.rules : [];
  for (const it of list) {
    if (it === null || typeof it !== "object") { out.errors.push("route rule must be an object"); continue; }
    const route = str(it.route, "");
    if (ROUTES.indexOf(route) < 0) { out.errors.push("route must be allow|approval|deny: " + route); continue; }
    out.rules.push({ steward: str(it.steward, "*"), cap: str(it.cap, "*"), target: str(it.target, "*"), route: route });
  }
  return out;
}

export function createRoutes(options) {
  const opts = options === undefined || options === null ? {} : options;
  const readSettings = typeof opts.readSettings === "function" ? opts.readSettings : function () { return {}; };
  const stewardOf = typeof opts.stewardOf === "function" ? opts.stewardOf : function () { return undefined; };
  let cache = { at: 0, sig: "", norm: undefined };

  function config() {
    let raw;
    try { raw = readSettings(); } catch { raw = {}; }
    const p = raw !== null && typeof raw === "object" && raw.plane !== null && typeof raw.plane === "object" ? raw.plane : {};
    const sig = JSON.stringify(p.routes === undefined ? null : p.routes);
    if (cache.norm !== undefined && cache.sig === sig && Date.now() - cache.at < 1000) return cache.norm;
    cache = { at: Date.now(), sig: sig, norm: normalizeRoutes(p.routes) };
    return cache.norm;
  }

  function voiceOf(stewardId) {
    const s = stewardOf(String(stewardId));
    const v = s !== undefined && s !== null && s.voice !== undefined && s.voice !== null && typeof s.voice === "object" ? s.voice : {};
    return { mode: str(v.mode, "virtual") === "session" ? "session" : "virtual", sessionId: str(v.sessionId, "") };
  }

  function routeFor(stewardId, capId, target) {
    const cfg = config();
    for (const rule of cfg.rules) {
      if (!targetMatches(rule.steward, String(stewardId))) continue;
      if (!targetMatches(rule.cap, String(capId))) continue;
      if (!targetMatches(rule.target, String(target))) continue;
      return rule.route;
    }
    return cfg.default;
  }

  /** 管线契约：decide(stewardId, capId, target, intent) → "allow" | "approval" | "deny"。 */
  function decide(stewardId, capId, target, intent) {
    if (SESSION_CAPS.indexOf(String(capId)) >= 0) {
      const p = intent !== undefined && intent !== null && intent.params !== undefined && intent.params !== null ? intent.params : {};
      const explicit = str(p.sessionId, "") !== "" || str(p.target, "") !== "" || str(p.to, "") !== "";
      if (voiceOf(stewardId).mode === "virtual" && !explicit) return "deny";
    }
    return routeFor(stewardId, capId, target);
  }

  return {
    decide: decide,
    config: config,
    voiceOf: voiceOf,
    routeFor: routeFor,
    reset: function () { cache = { at: 0, sig: "", norm: undefined }; }
  };
}

export default { createRoutes, normalizeRoutes, ROUTES, SESSION_CAPS };

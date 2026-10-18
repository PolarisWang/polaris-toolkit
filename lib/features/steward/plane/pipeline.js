/**
 * 编排器管线（能力平面 §5）：能力只被调用，决策只在这里落地。
 *
 * 裁决顺序（写死，不服由决策树改）：
 *   人工在场 > 作用域 > 自指 > 路由矩阵 > 授权 > 幂等 > 预算 > 冷却 > 预演/执行
 * 预演是一站：actMode=echo 或 grant=dry-run 时只产出"会做什么"的文案，
 * 不调用载体、不写业务状态，但仍记 intent（含被拒的），保证追查页没有盲区。
 */
import { targetMatches } from "./catalog.js";
import { resolveValue } from "./tree.js";

const IDEM_TTL_MS = 300000;
const MAX_DEPTH = 8;

function str(v, fallback) {
  return v === undefined || v === null ? fallback : String(v);
}

export function createPipeline(options) {
  const opts = options === undefined ? {} : options;
  const catalog = opts.catalog;
  const carriers = opts.carriers;
  const trace = opts.trace === undefined ? undefined : opts.trace;
  const clock = typeof opts.clock === "function" ? opts.clock : Date.now;
  const log = typeof opts.log === "function" ? opts.log : function () {};
  const budget = opts.budget === undefined ? undefined : opts.budget;
  const routes = opts.routes === undefined ? undefined : opts.routes;
  const grants = opts.grants === undefined ? {} : opts.grants;
  const liveOf = typeof opts.live === "function" ? opts.live : function (ctx) { return ctx !== undefined && ctx.live === true; };
  const cooldowns = new Map();
  const idem = new Map();
  const counters = { decided: 0, run: 0, preview: 0, deny: 0, approval: 0, skip: 0, effects: 0, failed: 0 };
  const reasons = {};

  function bump(reason) {
    const key = str(reason, "unknown");
    reasons[key] = (reasons[key] === undefined ? 0 : reasons[key]) + 1;
  }

  function prune() {
    const cut = clock() - IDEM_TTL_MS;
    for (const entry of Array.from(idem.entries())) if (entry[1].at < cut) idem.delete(entry[0]);
    for (const entry of Array.from(cooldowns.entries())) if (entry[1] < cut) cooldowns.delete(entry[0]);
  }

  function cooldownKey(spec, intent) {
    return spec.id + "|" + (intent.subject === "" ? intent.stewardId : intent.subject);
  }

  function grantOf(stewardId, spec) {
    if (typeof grants === "function") {
      try {
        const g = grants(stewardId, spec);
        if (g !== undefined && g !== null && g !== "") return String(g);
      } catch (error) {
        log("warn", "grant function failed: " + String(error !== null && error !== undefined && error.message !== undefined ? error.message : error));
      }
    }
    const per = grants[stewardId];
    if (per !== undefined && per !== null && typeof per === "object") {
      if (per[spec.id] !== undefined) return String(per[spec.id]);
      if (per["*"] !== undefined) return String(per["*"]);
    }
    return spec.grant;
  }

  function normalize(raw, ctx) {
    const r = raw === undefined || raw === null ? {} : raw;
    const spec = catalog.get(r.cap);
    const fallbackTarget = spec !== undefined && spec.targets.length > 0 ? spec.targets[0] : "";
    return {
      id: str(r.id, ""),
      cap: str(r.cap, ""),
      params: r.params !== undefined && r.params !== null && typeof r.params === "object" && !Array.isArray(r.params) ? r.params : {},
      target: str(r.target, fallbackTarget),
      subject: str(r.subject, ctx.subject),
      stewardId: str(r.stewardId, ctx.stewardId),
      idemKey: str(r.idemKey, ""),
      attempt: Number(r.attempt) > 0 ? Math.floor(Number(r.attempt)) : 1,
      by: str(r.by, "steward"),
      at: Number(r.at) > 0 ? Number(r.at) : clock()
    };
  }

  function effectiveTarget(intent, spec) {
    const t = intent.target;
    if (t.indexOf("*") < 0) return t;
    const p = intent.params === undefined || intent.params === null ? {} : intent.params;
    let cand = p.sessionId !== undefined ? p.sessionId : (p.target !== undefined ? p.target : p.to);
    if (cand === undefined || cand === null || cand === "") return t;
    cand = String(cand);
    if (cand.indexOf(":") >= 0) return cand;
    const kind = spec.targets.length > 0 ? spec.targets[0].split(":")[0] : "";
    return kind === "" ? cand : kind + ":" + cand;
  }

  function decide(intent, spec, ctx) {
    if (ctx.humanPresent === true && intent.by !== "owner" && spec.payload === "directive") {
      return { decision: "deny", reason: "human-present", route: "", grant: "" };
    }
    const scope = Array.isArray(ctx.scope) ? ctx.scope : [];
    if (scope.length > 0 && intent.subject !== "" && !scope.some(function (s) { return targetMatches(s, intent.subject); })) {
      return { decision: "deny", reason: "out-of-scope", route: "", grant: "" };
    }
    const selfSession = str(ctx.selfSessionId, "");
    if (selfSession !== "" && spec.payload === "directive") {
      const self = "session:" + selfSession;
      const subject = intent.subject === "" ? "" : (intent.subject.indexOf(":") < 0 ? "session:" + intent.subject : intent.subject);
      if (effectiveTarget(intent, spec) === self || subject === self) {
        return { decision: "deny", reason: "self-target", route: "", grant: "" };
      }
    }
    let route = "";
    if (routes !== undefined && routes !== null && typeof routes.decide === "function") {
      let r;
      try { r = routes.decide(intent.stewardId, spec.id, intent.target, intent); } catch (error) {
        log("warn", "route decide failed: " + String(error !== null && error !== undefined && error.message !== undefined ? error.message : error));
        r = undefined;
      }
      if (r === "deny") return { decision: "deny", reason: "route-denied", route: "deny", grant: "" };
      if (r === "approval") return { decision: "approval", reason: "route-approval", route: "approval", grant: "" };
      if (r !== undefined && r !== null && r !== "") route = String(r);
    }
    const grant = grantOf(intent.stewardId, spec);
    if (grant === "denied") return { decision: "deny", reason: "need-grant", route: route, grant: grant };
    if (grant === "dry-run") return { decision: "preview", reason: "grant-dry-run", route: route, grant: grant };
    if (intent.idemKey !== "" && idem.has(intent.idemKey)) return { decision: "skip", reason: "idempotent", route: route, grant: grant };
    if (budget !== undefined && budget !== null && typeof budget.allow === "function") {
      let allowed = true;
      try { allowed = budget.allow(intent.stewardId, spec.id, intent) !== false; } catch (error) {
        log("warn", "budget check failed: " + String(error !== null && error !== undefined && error.message !== undefined ? error.message : error));
      }
      if (!allowed) return { decision: "deny", reason: "budget-exhausted", route: route, grant: grant };
    }
    if (spec.limits.cooldownSec > 0) {
      const at = cooldowns.get(cooldownKey(spec, intent));
      if (at !== undefined && clock() - at < spec.limits.cooldownSec * 1000) {
        return { decision: "skip", reason: "cooldown", route: route, grant: grant };
      }
    }
    // 判定与片段没有副作用：echo 下也照跑，真正的动作在它们内部 call 时才被预演。
    if (spec.payload === "verdict" || spec.payload === "plan") return { decision: "run", reason: liveOf(ctx) ? "ok" : "dry-run", route: route, grant: grant };
    if (!liveOf(ctx)) return { decision: "preview", reason: "echo", route: route, grant: grant };
    return { decision: "run", reason: "ok", route: route, grant: grant };
  }

  function previewText(spec, params, ctx) {
    const adapter = carriers.get(spec.carrier);
    if (adapter !== undefined && typeof adapter.preview === "function") {
      try { return String(adapter.preview(spec, params, ctx)); } catch { /* fall through */ }
    }
    return spec.id + " → " + spec.carrier;
  }

  async function act(raw, ctxInput, t) {
    const ctx = ctxInput === undefined || ctxInput === null ? {} : ctxInput;
    prune();
    const intent = normalize(raw, Object.assign({ stewardId: "", subject: "" }, ctx));
    const started = clock();
    const span = t === undefined ? undefined : t.span({ kind: "cap", ref: intent.cap, parent: ctx.parentSpan === undefined ? undefined : ctx.parentSpan, at: started });
    const depth = Number(ctx.depth) > 0 ? Number(ctx.depth) : 0;

    function finish(decision, reason, extra) {
      const x = extra === undefined ? {} : extra;
      const ok = x.ok !== undefined ? x.ok === true : (decision === "run" || decision === "preview");
      const at = clock();
      if (span !== undefined) span.end(decision, Math.max(0, at - started), { reason: str(reason, "") });
      const spec = catalog.get(intent.cap);
      if (t !== undefined) {
        t.intent({
          cap: intent.cap,
          carrier: spec === undefined ? "" : spec.carrier,
          payload: spec === undefined ? "" : spec.payload,
          target: intent.target,
          protocol: spec === undefined ? "fire" : spec.protocol,
          route: x.route === undefined ? "" : x.route,
          grant: x.grant === undefined ? "" : x.grant,
          decision: decision,
          reason: str(reason, ""),
          ok: ok,
          preview: decision === "preview",
          at: at,
          extId: x.extId === undefined ? "" : x.extId,
          stewardId: intent.stewardId,
          spanId: span === undefined ? "" : span.id
        });
      }
      counters.decided += 1;
      counters[decision] = (counters[decision] === undefined ? 0 : counters[decision]) + 1;
      if (decision === "deny" || decision === "approval" || decision === "skip") bump(reason);
      return { ok: ok, decision: decision, reason: str(reason, ""), cap: intent.cap, target: intent.target, extId: x.extId === undefined ? "" : x.extId, data: x.data, preview: decision === "preview" ? previewText(spec, intent.params, ctx) : "" };
    }

    const spec = catalog.get(intent.cap);
    if (spec === undefined) return finish("deny", "unknown-capability");
    if (depth > MAX_DEPTH) return finish("deny", "depth-limit");
    const resolved = resolveValue(Object.assign({}, spec.params, intent.params), { facts: ctx.facts === undefined ? {} : ctx.facts, vars: ctx.vars === undefined ? {} : ctx.vars });
    const checked = catalog.validateParams(intent.cap, resolved);
    if (!checked.ok) return finish("deny", "invalid-params:" + String(checked.error));
    const params = checked.value;
    const d = decide(intent, spec, ctx);
    if (d.decision === "deny" || d.decision === "approval" || d.decision === "skip") {
      return finish(d.decision, d.reason, { route: d.route, grant: d.grant });
    }
    if (d.decision === "preview") {
      return finish("preview", d.reason, { route: d.route, grant: d.grant, data: { preview: previewText(spec, params, ctx) } });
    }
    const adapter = carriers.get(spec.carrier);
    if (adapter === undefined) return finish("deny", "carrier-missing:" + spec.carrier, { route: d.route, grant: d.grant });
    const carrierCtx = Object.assign({}, ctx, {
      stewardId: intent.stewardId,
      subject: intent.subject,
      depth: depth + 1,
      call: caller(ctx, t, depth + 1)
    });
    const began = clock();
    let out;
    try {
      out = await adapter.run(spec, params, carrierCtx);
    } catch (error) {
      out = { ok: false, error: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error) };
    }
    const ms = Math.max(0, clock() - began);
    const ok = out !== undefined && out !== null && out.ok !== false;
    if (t !== undefined) {
      t.effect(span === undefined ? "" : span.id, {
        cap: spec.id,
        params: params,
        extId: out !== undefined && out !== null && out.extId !== undefined ? String(out.extId) : "",
        ok: ok,
        errorCode: ok ? "" : str(out !== undefined && out !== null ? out.error : "failed", "failed"),
        ms: ms,
        attempt: intent.attempt
      });
    }
    counters.effects += 1;
    if (!ok) counters.failed += 1;
    if (ok) {
      if (spec.limits.cooldownSec > 0) cooldowns.set(cooldownKey(spec, intent), clock());
      if (intent.idemKey !== "") idem.set(intent.idemKey, { at: clock(), cap: spec.id });
      if (budget !== undefined && budget !== null && typeof budget.charge === "function") {
        try { budget.charge(intent.stewardId, spec.id, intent); } catch { /* ignore */ }
      }
    }
    return finish("run", ok ? "ok" : str(out !== undefined && out !== null ? out.error : "effect-failed", "effect-failed"), {
      route: d.route,
      grant: d.grant,
      ok: ok,
      extId: out !== undefined && out !== null && out.extId !== undefined ? String(out.extId) : "",
      data: out !== undefined && out !== null ? out.data : undefined
    });
  }

  function caller(ctx, t, depth) {
    return async function (cap, params, node) {
      const res = await act({
        cap: cap,
        params: params,
        subject: ctx.subject === undefined ? "" : ctx.subject,
        stewardId: ctx.stewardId === undefined ? "" : ctx.stewardId,
        idemKey: node !== undefined && node !== null && node.idemKey !== undefined ? String(node.idemKey) : ""
      }, Object.assign({}, ctx, { depth: depth }), t);
      return { ok: res.ok && res.decision !== "preview", data: res.data, extId: res.extId, error: res.reason, decision: res.decision };
    };
  }

  async function run(intents, ctxInput) {
    const ctx = Object.assign({ facts: {}, vars: {}, stewardId: "", subject: "", trigger: "pipeline" }, ctxInput === undefined ? {} : ctxInput);
    const list = Array.isArray(intents) ? intents : [intents];
    const t = trace === undefined ? undefined : trace.begin({ trigger: ctx.trigger, steward: ctx.stewardId, subject: ctx.subject, at: ctx.at === undefined ? clock() : ctx.at });
    const results = [];
    for (const raw of list) results.push(await act(raw, ctx, t));
    const failed = results.some(function (r) { return !r.ok; });
    const firstBad = results.filter(function (r) { return !r.ok; })[0];
    if (t !== undefined) t.finish(failed ? "failed" : "ok", failed && firstBad !== undefined ? firstBad.reason : "");
    return { ok: !failed, traceId: t === undefined ? "" : t.id, results: results, decision: results.length === 1 ? results[0].decision : "multi" };
  }

  async function runPlan(plan, ctxInput, opts) {
    const o = opts === undefined || opts === null ? {} : opts;
    const ctx = Object.assign({ facts: {}, vars: {}, stewardId: "", subject: "", event: "plan", trigger: "plan" }, ctxInput === undefined ? {} : ctxInput);
    const outer = o.trace === undefined ? undefined : o.trace;
    const owns = outer === undefined;
    const t = outer === false ? undefined : (owns ? (trace === undefined ? undefined : trace.begin({ trigger: ctx.trigger, steward: ctx.stewardId, subject: ctx.subject })) : outer);
    const root = t === undefined ? undefined : t.span({ kind: "plan", ref: "plan", at: clock() });
    const tree = await import("./tree.js");
    const res = await tree.evalTree(plan, Object.assign({}, ctx, { parentSpan: root === undefined ? "" : root.id, call: caller(ctx, t, 0) }));
    if (root !== undefined) root.end(res.ok ? "ok" : "failed", 0, { calls: res.calls.length });
    if (owns && t !== undefined) t.finish(res.ok ? "ok" : "failed", res.ok ? "" : res.error);
    return Object.assign({ traceId: t === undefined ? "" : t.id }, res);
  }

  return {
    act: act,
    run: run,
    runPlan: runPlan,
    decide: decide,
    normalize: normalize,
    effectiveTarget: effectiveTarget,
    previewText: previewText,
    grantOf: grantOf,
    stats: function () { return Object.assign({}, counters, { reasons: Object.assign({}, reasons), cooldowns: cooldowns.size, idem: idem.size }); },
    reasons: function () { return Object.assign({}, reasons); },
    cooldowns: function () { return cooldowns.size; },
    reset: function () { cooldowns.clear(); idem.clear(); for (const k of Object.keys(reasons)) delete reasons[k]; counters.decided = 0; counters.run = 0; counters.preview = 0; counters.deny = 0; counters.approval = 0; counters.skip = 0; counters.effects = 0; counters.failed = 0; }
  };
}

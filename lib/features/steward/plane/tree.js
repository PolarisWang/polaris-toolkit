/**
 * 决策树（能力平面 §3）：主管唯一的决策源。能力只提供可插入的树片段（presets），
 * 运行时不回看能力内部 —— 想改变行为就改树，或改装备/参数。
 *
 * 节点：
 *   { when: "host/tick", do: <node> }              事件网关，不匹配就跳过
 *   { if: <cond>, then: <node>, else?: <node> }    条件分支
 *   { all: [cond] } / { any: [cond] } / { not: cond }   条件断言（为假则整棵树 skipped）
 *   { choose: [{ if: cond, do: node }], fallback: node }
 *   { seq: [node] } / { par: [node] }              顺序 / 并发
 *   { call: "cap.id", params?: {}, save?: "name", onError?: "abort"|"continue" }
 *   { wait: 5, timeout: 60 }                       等待（ctx.wait 缺省时只记账不真等）
 *   { set: "name", value: any }                    局部变量（字符串支持 {path} 取值）
 *   { noop: true }
 *
 * <cond> 既可以是 rules 表达式（expr.js 的算子），也可以是字符串路径、布尔，
 * 或用 all/any/not 组合。求值用的 facts = ctx.facts + ctx.vars（vars 覆盖）。
 */
import { evaluateExpr, matchEvent, valueAt } from "./expr.js";

export const TREE_NODES = ["when", "if", "all", "any", "not", "choose", "seq", "par", "call", "wait", "set", "noop"];

function flat(ctx) {
  return Object.assign({}, ctx.facts, ctx.vars);
}

function interpolate(text, ctx) {
  if (text.indexOf("{") < 0) return text;
  let out = "";
  let cur = 0;
  while (true) {
    const a = text.indexOf("{", cur);
    if (a < 0) { out += text.slice(cur); break; }
    const b = text.indexOf("}", a + 1);
    if (b < 0) { out += text.slice(cur); break; }
    const path = text.slice(a + 1, b);
    const v = valueAt(flat(ctx), path);
    out += text.slice(cur, a) + (v === undefined || v === null ? "" : String(v));
    cur = b + 1;
  }
  return out;
}

export function resolveValue(value, ctx) {
  if (typeof value === "string") return interpolate(value, ctx);
  if (Array.isArray(value)) return value.map(function (v) { return resolveValue(v, ctx); });
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = resolveValue(value[k], ctx);
    return out;
  }
  return value;
}

export function evalCond(cond, ctx) {
  if (cond === undefined || cond === null || cond === true) return true;
  if (typeof cond === "boolean") return cond;
  if (typeof cond === "string") return Boolean(valueAt(flat(ctx), cond));
  if (Array.isArray(cond)) return cond.every(function (c) { return evalCond(c, ctx); });
  if (typeof cond === "object") {
    const keys = Object.keys(cond);
    if (keys.length === 1 && keys[0] === "all") return (cond.all || []).every(function (c) { return evalCond(c, ctx); });
    if (keys.length === 1 && keys[0] === "any") return (cond.any || []).some(function (c) { return evalCond(c, ctx); });
    if (keys.length === 1 && keys[0] === "not") return !evalCond(cond.not, ctx);
    try { return evaluateExpr(cond, flat(ctx)); } catch { return false; }
  }
  return false;
}

function checkCond(cond, where, errors) {
  if (cond === undefined || cond === null || typeof cond === "boolean" || typeof cond === "string") return;
  if (Array.isArray(cond)) {
    if (cond.length === 0) errors.push(where + ": empty condition list");
    cond.forEach(function (c, i) { checkCond(c, where + "[" + i + "]", errors); });
    return;
  }
  if (typeof cond !== "object") { errors.push(where + ": bad condition"); return; }
  const keys = Object.keys(cond);
  const gate = keys.length === 1 ? keys[0] : undefined;
  if (gate === "all" || gate === "any") {
    const list = Array.isArray(cond[gate]) ? cond[gate] : [];
    if (list.length === 0) errors.push(where + "." + gate + " must be a non-empty array");
    list.forEach(function (c, i) { checkCond(c, where + "." + gate + "[" + i + "]", errors); });
    return;
  }
  if (gate === "not") { checkCond(cond.not, where + ".not", errors); return; }
  try {
    evaluateExpr(cond, {});
  } catch (error) {
    errors.push(where + ": " + String(error !== null && error !== undefined && error.message !== undefined ? error.message : error));
  }
}

export function validateTree(tree, options) {
  const opts = options === undefined ? {} : options;
  const equips = opts.equips === undefined || opts.equips === null ? undefined : new Set(opts.equips);
  const errors = [];
  const warnings = [];
  let count = 0;

  function walk(node, where) {
    count += 1;
    if (node === null || node === undefined) { errors.push(where + ": empty node"); return; }
    if (typeof node !== "object" || Array.isArray(node)) { errors.push(where + ": node must be an object"); return; }
    const keys = Object.keys(node);
    let kind;
    for (const k of TREE_NODES) if (keys.indexOf(k) >= 0) { kind = k; break; }
    if (kind === undefined) { errors.push(where + ": unknown node keys [" + keys.join(",") + "]"); return; }
    if (kind === "when") {
      if (typeof node.when !== "string" || node.when === "") errors.push(where + ".when must be an event pattern");
      if (node.do === undefined) errors.push(where + ".when needs do");
      else walk(node.do, where + ".do");
    } else if (kind === "if") {
      checkCond(node.if, where + ".if", errors);
      if (node.then === undefined) errors.push(where + ".if needs then");
      else walk(node.then, where + ".then");
      if (node.else !== undefined) walk(node.else, where + ".else");
    } else if (kind === "all" || kind === "any") {
      const list = node[kind];
      if (!Array.isArray(list) || list.length === 0) errors.push(where + "." + kind + " must be a non-empty array");
      else list.forEach(function (c, i) { checkCond(c, where + "." + kind + "[" + i + "]", errors); });
    } else if (kind === "not") {
      checkCond(node.not, where + ".not", errors);
    } else if (kind === "choose") {
      const branches = Array.isArray(node.choose) ? node.choose : [];
      if (branches.length === 0) errors.push(where + ".choose needs at least one branch");
      branches.forEach(function (b, i) {
        if (b === null || typeof b !== "object") { errors.push(where + ".choose[" + i + "] must be {if, do}"); return; }
        if (b.if === undefined) errors.push(where + ".choose[" + i + "] needs if");
        else checkCond(b.if, where + ".choose[" + i + "].if", errors);
        if (b.do === undefined) errors.push(where + ".choose[" + i + "] needs do");
        else walk(b.do, where + ".choose[" + i + "].do");
      });
      if (node.fallback === undefined) errors.push(where + ".choose needs fallback");
      else walk(node.fallback, where + ".fallback");
    } else if (kind === "seq" || kind === "par") {
      const list = node[kind];
      if (!Array.isArray(list) || list.length === 0) errors.push(where + "." + kind + " must be a non-empty array");
      else list.forEach(function (n, i) { walk(n, where + "." + kind + "[" + i + "]"); });
    } else if (kind === "call") {
      if (typeof node.call !== "string" || node.call === "") errors.push(where + ".call must be a capability id");
      else if (equips !== undefined && !equips.has(node.call)) warnings.push(where + ": capability not equipped: " + node.call);
      const cb = node.chooser;
      if (cb !== undefined && cb !== "cap") warnings.push(where + ".chooser=" + String(cb) + " is not supported yet");
      if (node.onError !== undefined && node.onError !== "abort" && node.onError !== "continue") errors.push(where + ".onError must be abort|continue");
      if (node.params !== undefined && (typeof node.params !== "object" || node.params === null || Array.isArray(node.params))) errors.push(where + ".params must be an object");
      if (node.save !== undefined && typeof node.save !== "string") errors.push(where + ".save must be a variable name");
    } else if (kind === "wait") {
      if (!(Number(node.wait) >= 0)) errors.push(where + ".wait must be seconds");
      if (node.timeout === undefined) warnings.push(where + ": wait without timeout will park forever");
    } else if (kind === "set") {
      if (typeof node.set !== "string" || node.set === "") errors.push(where + ".set must be a variable name");
      if (node.value === undefined) errors.push(where + ".set needs value");
    }
  }

  walk(tree, typeof opts.where === "string" ? opts.where : "$");
  return { ok: errors.length === 0, errors: errors, warnings: warnings, nodes: count };
}

export async function evalTree(tree, ctxInput) {
  const base = ctxInput === undefined ? {} : ctxInput;
  const ctx = Object.assign({
    event: "",
    facts: {},
    vars: {},
    log: function () {},
    call: async function () { return { ok: false, error: "no-caller" }; },
    wait: undefined
  }, base);
  ctx.vars = Object.assign({}, base.vars === undefined ? {} : base.vars);
  const path = [];
  const calls = [];
  const result = { ok: true, status: "ok", path: path, calls: calls, vars: ctx.vars, error: "" };

  async function run(node, where) {
    if (node === null || node === undefined) return { ok: true };
    if (typeof node !== "object") return { ok: true };
    const keys = Object.keys(node);
    let kind;
    for (const k of TREE_NODES) if (keys.indexOf(k) >= 0) { kind = k; break; }
    if (kind === undefined) return { ok: true };
    if (kind === "when") {
      if (!matchEvent(node.when, ctx.event)) { path.push(where + ":skip(" + node.when + ")"); return { ok: true, skipped: true }; }
      path.push(where + ":when(" + node.when + ")");
      return run(node.do, where + ".do");
    }
    if (kind === "if") {
      if (evalCond(node.if, ctx)) { path.push(where + ":then"); return run(node.then, where + ".then"); }
      path.push(where + ":else");
      if (node.else !== undefined) return run(node.else, where + ".else");
      return { ok: true, skipped: true };
    }
    if (kind === "all" || kind === "any" || kind === "not") {
      const ok = evalCond(node, ctx);
      path.push(where + ":" + kind + "=" + String(ok));
      if (!ok) {
        result.ok = true;
        result.status = "skipped";
        result.error = "condition-false:" + where;
        return { ok: false, stop: true, reason: "condition-false" };
      }
      return { ok: true };
    }
    if (kind === "choose") {
      const branches = Array.isArray(node.choose) ? node.choose : [];
      for (let i = 0; i < branches.length; i += 1) {
        if (evalCond(branches[i].if, ctx)) {
          path.push(where + ":choose[" + i + "]");
          return run(branches[i].do, where + ".choose[" + i + "].do");
        }
      }
      path.push(where + ":fallback");
      return run(node.fallback, where + ".fallback");
    }
    if (kind === "seq") {
      for (let i = 0; i < node.seq.length; i += 1) {
        const r = await run(node.seq[i], where + ".seq[" + i + "]");
        if (r !== undefined && r.stop === true) return r;
      }
      return { ok: true };
    }
    if (kind === "par") {
      const results = await Promise.all(node.par.map(function (n, i) { return run(n, where + ".par[" + i + "]"); }));
      for (const r of results) if (r !== undefined && r.stop === true) return r;
      return { ok: true };
    }
    if (kind === "call") {
      const params = resolveValue(node.params === undefined ? {} : node.params, ctx);
      const began = Date.now();
      let out;
      try {
        out = await ctx.call(node.call, params, node);
      } catch (error) {
        out = { ok: false, error: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error) };
      }
      const ms = Date.now() - began;
      const ok = out !== null && out !== undefined && out.ok !== false;
      calls.push({ cap: node.call, params: params, ok: ok, ms: ms, extId: out !== null && out !== undefined && out.extId !== undefined ? String(out.extId) : "", error: ok ? "" : String(out !== null && out !== undefined && out.error !== undefined ? out.error : "failed") });
      path.push(where + ":call(" + node.call + ")=" + (ok ? "ok" : "err"));
      if (node.save !== undefined && typeof node.save === "string") {
        const data = out !== null && out !== undefined && out.data !== undefined ? out.data : out;
        ctx.vars[node.save] = data;
      }
      if (!ok) {
        if (node.onError === "continue") return { ok: true };
        result.ok = false;
        result.status = "failed";
        result.error = "call-failed:" + node.call + " " + String(out !== null && out !== undefined && out.error !== undefined ? out.error : "");
        return { ok: false, stop: true, reason: "call-failed" };
      }
      return { ok: true };
    }
    if (kind === "wait") {
      const sec = Number(node.wait);
      path.push(where + ":wait(" + String(sec) + ")");
      if (typeof ctx.wait === "function") await ctx.wait(sec, node);
      return { ok: true };
    }
    if (kind === "set") {
      ctx.vars[node.set] = resolveValue(node.value, ctx);
      path.push(where + ":set(" + node.set + ")");
      return { ok: true };
    }
    path.push(where + ":noop");
    return { ok: true };
  }

  const top = await run(tree, "$");
  if (top !== undefined && top.stop === true && result.error === "") result.error = String(top.reason === undefined ? "stop" : top.reason);
  return result;
}

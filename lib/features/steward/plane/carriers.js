/**
 * 载体（能力平面 §1）：真正干 IO 的那一层。每条能力声明它用哪个载体，
 * 载体只认 (instance, params, ctx)，返回 { ok, extId?, data?, error? }。
 *
 * 内置载体里 expr / tree / file 是自足的（判定、片段、落文件）；
 * desktop / lark.im / lark.doc / session / task / tool / peer / llm 是薄适配，
 * 由 index.js 把宿主服务作为函数注入；缺服务时返回 carrier-unavailable，
 * 让编排器记一条 effect 失败而不是把整个 tick 打挂。
 */
import fs from "node:fs";
import path from "node:path";
import { evaluateExpr, severityRank } from "./expr.js";
import { evalTree } from "./tree.js";

function str(v, fallback) {
  return v === undefined || v === null ? fallback : String(v);
}

function short(v, n) {
  let s;
  try { s = typeof v === "string" ? v : JSON.stringify(v); } catch { s = String(v); }
  if (s === undefined || s === null) return "";
  return s.length > n ? s.slice(0, n) + "..." : s;
}

export function builtinCarriers(services) {
  const svc = services === undefined || services === null ? {} : services;
  const dir = svc.dir === undefined || svc.dir === null ? "" : String(svc.dir);
  const log = typeof svc.log === "function" ? svc.log : function () {};

  function bridge(name) {
    const fn = svc[name];
    if (typeof fn !== "function") return { ok: false, error: "carrier-unavailable:" + name };
    return fn;
  }

  function genericRun(name, instance, params, ctx) {
    const fn = bridge(name);
    if (typeof fn !== "function") return { ok: false, error: "carrier-unavailable:" + name };
    try {
      const out = fn(instance, params, ctx);
      return out === undefined || out === null ? { ok: true } : out;
    } catch (error) {
      return { ok: false, error: name + "-failed:" + String(error !== null && error !== undefined && error.message !== undefined ? error.message : error) };
    }
  }

  async function runExpr(instance, params, ctx) {
    const declared = Array.isArray(instance.params !== undefined && instance.params !== null && instance.params.rules !== undefined ? instance.params.rules : []) ? instance.params.rules : [];
    const rules = Array.isArray(params.rules) ? params.rules : declared;
    const facts = Object.assign({}, ctx.facts, params.facts !== null && typeof params.facts === "object" ? params.facts : {});
    const matched = [];
    for (const rule of rules) {
      if (rule === null || typeof rule !== "object") continue;
      let hit = false;
      try { hit = evaluateExpr(rule.if, facts); } catch (error) {
        log("warn", "expr carrier " + instance.id + ": " + String(error !== null && error !== undefined && error.message !== undefined ? error.message : error));
        hit = false;
      }
      if (!hit) continue;
      matched.push({
        id: str(rule.id, instance.id),
        level: str(rule.level, "warning"),
        reason: str(rule.reason, ""),
        evidence: rule.evidence === undefined ? {} : rule.evidence
      });
    }
    if (matched.length === 0) return { ok: true, data: { hit: false, level: "ok", matched: [], reason: "", facts: facts } };
    matched.sort(function (a, b) { return severityRank(b.level) - severityRank(a.level); });
    const top = matched[0];
    return { ok: true, data: { hit: true, level: top.level, matched: matched, reason: top.reason, evidence: top.evidence, facts: facts } };
  }

  async function runTree(instance, params, ctx) {
    const plan = params.plan !== undefined ? params.plan : instance.plan;
    if (plan === undefined || plan === null) return { ok: false, error: "no-plan" };
    const res = await evalTree(plan, ctx);
    return { ok: res.ok, data: res, error: res.ok ? "" : res.error };
  }

  async function runFile(instance, params, ctx) {
    if (dir === "") return { ok: false, error: "carrier-unavailable:file" };
    const name = str(params.name, instance.id.replace(/[^a-z0-9]+/g, "-"));
    const file = path.join(dir, "plane-" + name + ".jsonl");
    const rec = { at: Date.now(), cap: instance.id, steward: str(ctx.stewardId, ""), subject: str(ctx.subject, ""), params: params };
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
    } catch (error) {
      return { ok: false, error: "file-write-failed:" + String(error !== null && error !== undefined && error.message !== undefined ? error.message : error) };
    }
    let bytes = 0;
    try { bytes = fs.statSync(file).size; } catch { bytes = 0; }
    return { ok: true, extId: "file:" + path.basename(file) + ":" + String(bytes), data: { file: file, bytes: bytes } };
  }

  function previewExpr(instance) {
    const rules = Array.isArray(instance.params !== undefined && instance.params !== null && instance.params.rules !== undefined ? instance.params.rules : []) ? instance.params.rules.length : 0;
    return "判定 " + instance.id + "（" + String(rules) + " 条规则）";
  }

  function previewTree(instance) {
    return "片段 " + instance.id + "（" + String(instance.plan === undefined ? 0 : 1) + " 棵树）";
  }

  function previewFile(instance, params) {
    const name = str(params.name, instance.id.replace(/[^a-z0-9]+/g, "-"));
    return "写日志 " + path.join(dir === "" ? "<dir>" : dir, "plane-" + name + ".jsonl");
  }

  function genericPreview(name, instance, params) {
    return instance.id + " → " + name + "(" + short(params, 120) + ")";
  }

  const list = [
    { carrier: "expr", run: runExpr, preview: previewExpr },
    { carrier: "tree", run: runTree, preview: previewTree },
    { carrier: "file", run: runFile, preview: previewFile },
    { carrier: "desktop", run: function (i, p, c) { return genericRun("desktop", i, p, c); }, preview: function (i, p) { return genericPreview("desktop", i, p); } },
    { carrier: "lark.im", run: function (i, p, c) { return genericRun("lark", i, p, c); }, preview: function (i, p) { return genericPreview("lark.im", i, p); } },
    { carrier: "lark.doc", run: function (i, p, c) { return genericRun("larkDoc", i, p, c); }, preview: function (i, p) { return genericPreview("lark.doc", i, p); } },
    { carrier: "session", run: function (i, p, c) { return genericRun("session", i, p, c); }, preview: function (i, p) { return genericPreview("session", i, p); } },
    { carrier: "task", run: function (i, p, c) { return genericRun("task", i, p, c); }, preview: function (i, p) { return genericPreview("task", i, p); } },
    { carrier: "tool", run: function (i, p, c) { return genericRun("tool", i, p, c); }, preview: function (i, p) { return genericPreview("tool", i, p); } },
    { carrier: "peer", run: function (i, p, c) { return genericRun("peer", i, p, c); }, preview: function (i, p) { return genericPreview("peer", i, p); } },
    { carrier: "llm", run: function (i, p, c) { return genericRun("llm", i, p, c); }, preview: function (i, p) { return genericPreview("llm", i, p); } }
  ];
  return list;
}

export function createCarriers(services) {
  const svc = services === undefined || services === null ? {} : services;
  const log = typeof svc.log === "function" ? svc.log : function () {};
  const map = new Map();
  function register(adapter) {
    if (adapter === null || typeof adapter !== "object" || typeof adapter.carrier !== "string") throw new Error("carrier adapter needs a carrier name");
    if (typeof adapter.run !== "function") throw new Error("carrier " + adapter.carrier + " needs run()");
    map.set(adapter.carrier, adapter);
    return adapter;
  }
  for (const a of builtinCarriers(Object.assign({}, svc, { log: log }))) register(a);
  for (const a of Array.isArray(svc.carriers) ? svc.carriers : []) register(a);
  return {
    register: register,
    get: function (carrier) { return map.get(String(carrier)); },
    has: function (carrier) { return map.has(String(carrier)); },
    names: function () { return Array.from(map.keys()); }
  };
}

/**
 * 规则装载：内置 JSON + 本地 overrides，按 id 合并，算一个稳定的 rulesHash
 * 供联邦主从比对漂移（docs/steward-design.md 7.4）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateExpr, severityRank } from "./expr.js";

const FILES = ["agents.json", "system.json", "social.json"];

function builtinDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "builtin");
}

function readJson(file, log) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    log("warn", "rule file unreadable, skipped: " + file + " (" + String(error) + ")");
    return undefined;
  }
}

export function normalizeRule(raw) {
  if (raw === null || typeof raw !== "object") throw new Error("rule must be an object");
  const id = String(raw.id === undefined ? "" : raw.id);
  if (id === "") throw new Error("rule needs an id");
  const severity = typeof raw.severity === "string" && severityRank(raw.severity) > 0 ? raw.severity : "warning";
  const rule = {
    id,
    version: Number(raw.version === undefined ? 1 : raw.version),
    title: typeof raw.title === "string" ? raw.title : id,
    file: typeof raw.file === "string" ? raw.file : "custom",
    when: typeof raw.when === "string" ? raw.when : "*",
    if: raw.if === undefined ? { const: true } : raw.if,
    actions: Array.isArray(raw.actions) ? raw.actions.map((a) => ({
      workflow: String(a.workflow === undefined ? "" : a.workflow),
      params: a.params === undefined || a.params === null ? {} : a.params,
      level: Number(a.level === undefined ? 1 : a.level)
    })) : [],
    cooldownSec: Number(raw.cooldownSec === undefined ? 300 : raw.cooldownSec),
    severity,
    enabledByDefault: raw.enabledByDefault !== false,
    shadowHours: Number(raw.shadowHours === undefined ? 0 : raw.shadowHours),
    params: raw.params === undefined || raw.params === null ? {} : raw.params
  };
  validateExpr(rule.if);
  for (const action of rule.actions) if (action.workflow === "") throw new Error("rule " + id + " has an action without workflow");
  return rule;
}

export function canonicalRules(rules) {
  return rules.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => ({
    id: r.id, version: r.version, when: r.when, if: r.if, actions: r.actions,
    cooldownSec: r.cooldownSec, severity: r.severity, enabledByDefault: r.enabledByDefault,
    shadowHours: r.shadowHours, params: r.params
  }));
}

export function rulesHash(rules) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalRules(rules))).digest("hex").slice(0, 16);
}

export function loadBuiltin(log) {
  const dir = builtinDir();
  const rules = [];
  for (const file of FILES) {
    const raw = readJson(path.join(dir, file), log);
    if (!Array.isArray(raw)) continue;
    for (const item of raw) {
      try { rules.push(normalizeRule(Object.assign({ file }, item))); } catch (error) { log("warn", "builtin rule rejected in " + file + ": " + String(error)); }
    }
  }
  return rules;
}

export function loadOverrides(dir, log) {
  const out = {};
  const overridesDir = path.join(dir, "overrides");
  let names = [];
  try { names = fs.readdirSync(overridesDir).filter((n) => n.endsWith(".json")); } catch { return out; }
  for (const name of names) {
    const raw = readJson(path.join(overridesDir, name), log);
    if (raw === null || typeof raw !== "object") continue;
    const list = Array.isArray(raw) ? raw : Object.keys(raw).map((id) => Object.assign({ id }, raw[id]));
    for (const item of list) {
      if (item === null || typeof item !== "object" || item.id === undefined) continue;
      out[String(item.id)] = item;
    }
  }
  return out;
}

/** 有效规则 = 内置 + overrides（enabled/params/severity/cooldown 可覆写）。 */
export function buildRuleSet(options) {
  const o = options === undefined || options === null ? {} : options;
  const log = typeof o.log === "function" ? o.log : () => {};
  const builtin = Array.isArray(o.builtin) ? o.builtin : loadBuiltin(log);
  const overrides = o.overrides === undefined ? {} : o.overrides;
  const rules = [];
  for (const rule of builtin) {
    const patch = overrides[rule.id];
    if (patch === undefined) { rules.push(Object.assign({}, rule)); continue; }
    const merged = Object.assign({}, rule, {
      enabled: patch.enabled === undefined ? undefined : patch.enabled === true,
      params: Object.assign({}, rule.params, patch.params === undefined ? {} : patch.params),
      severity: patch.severity === undefined ? rule.severity : patch.severity,
      cooldownSec: patch.cooldownSec === undefined ? rule.cooldownSec : Number(patch.cooldownSec)
    });
    rules.push(merged);
  }
  for (const id of Object.keys(overrides)) {
    if (builtin.some((r) => r.id === id)) continue;
    const patch = overrides[id];
    if (patch.enabled === false) continue;
    try { rules.push(normalizeRule(Object.assign({ id, file: "override" }, patch))); } catch (error) { log("warn", "override rule rejected: " + String(error)); }
  }
  return { rules, hash: rulesHash(rules), overrides };
}
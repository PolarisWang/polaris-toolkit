/**
 * 表达式求值（能力平面 §11：从 rules/expr.js 迁入 expr 载体）：
 * 一个小而确定的求值器（不 eval、不 Function）。
 *
 *   { eq: ["status", "running"] }       字段 equals 值（点号取嵌套）
 *   { ne | gt | gte | lt | lte: [...] }
 *   { in: ["module", ["ev","cb2"]] }     字段在数组里
 *   { nin: [...] }
 *   { exists: "question" } / { absent: "question" }
 *   { regex: ["title", "^ev-"] }
 *   { all: [expr, ...] } / { any: [expr, ...] } / { not: expr }
 *   { const: true }                      常量，便于测试与灰度
 *
 * 判定能力（judge.*）与决策树的 if 分支都用它，算子集合是唯一事实来源。
 */
const OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "exists", "absent", "regex", "all", "any", "not", "const"];

export function valueAt(facts, path) {
  if (typeof path !== "string") return undefined;
  const parts = path.split(".");
  let cur = facts;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function compare(op, a, b) {
  if (op === "eq") return a === b;
  if (op === "ne") return a !== b;
  if (op === "gt") return Number(a) > Number(b);
  if (op === "gte") return Number(a) >= Number(b);
  if (op === "lt") return Number(a) < Number(b);
  if (op === "lte") return Number(a) <= Number(b);
  return false;
}

export function evaluateExpr(expr, facts) {
  if (expr === undefined || expr === null) return true;
  if (typeof expr === "boolean") return expr;
  if (typeof expr !== "object" || Array.isArray(expr)) throw new Error("bad rule expression: " + JSON.stringify(expr));
  const keys = Object.keys(expr);
  if (keys.length !== 1) throw new Error("rule expression must have exactly one operator: " + JSON.stringify(expr));
  const op = keys[0];
  const arg = expr[op];
  if (OPS.indexOf(op) < 0) throw new Error("unknown rule operator: " + op);
  if (op === "const") return Boolean(arg);
  if (op === "all") return (arg || []).every((e) => evaluateExpr(e, facts));
  if (op === "any") return (arg || []).some((e) => evaluateExpr(e, facts));
  if (op === "not") return !evaluateExpr(arg, facts);
  if (op === "exists") return valueAt(facts, arg) !== undefined && valueAt(facts, arg) !== null;
  if (op === "absent") return valueAt(facts, arg) === undefined || valueAt(facts, arg) === null;
  if (!Array.isArray(arg) || arg.length !== 2) throw new Error("operator " + op + " needs [field, value]");
  const left = valueAt(facts, arg[0]);
  const right = arg[1];
  if (op === "in") return Array.isArray(right) && right.indexOf(left) >= 0;
  if (op === "nin") return Array.isArray(right) && right.indexOf(left) < 0;
  if (op === "regex") {
    let re;
    try { re = new RegExp(String(right)); } catch { return false; }
    return typeof left === "string" && re.test(left);
  }
  return compare(op, left, right);
}

export function validateExpr(expr) {
  evaluateExpr(expr, {});
  return true;
}

export const SEVERITY_ORDER = { info: 1, warning: 2, error: 3, critical: 4 };

export function severityRank(severity) {
  return SEVERITY_ORDER[severity] === undefined ? 0 : SEVERITY_ORDER[severity];
}

/** 事件类型匹配：支持结尾星号，如 agent/*。 */
export function matchEvent(ruleWhen, eventType) {
  if (typeof ruleWhen !== "string" || ruleWhen === "*") return true;
  if (ruleWhen.endsWith("*")) return String(eventType).startsWith(ruleWhen.slice(0, -1));
  return ruleWhen === eventType;
}

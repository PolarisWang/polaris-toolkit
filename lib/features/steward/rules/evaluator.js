/**
 * 规则求值：给定一个事件，算出该触发哪些工作流。
 *
 * - 冷却：同一 rule+subject 在 cooldownSec 内只触发一次；
 * - 冲突：同一 subject 上同一条工作流只保留 severity 最高的那条；
 * - 灰度：shadowHours > 0 的规则在窗口内只记录 decision（shadow: true），
 *   由调用方决定是否真跑工作流（引擎的 run.shadow 会跳过副作用）。
 */
import { evaluateExpr, matchEvent, severityRank } from "./expr.js";

export function createEvaluator(options) {
  const opt = options === undefined || options === null ? {} : options;
  const clock = typeof opt.clock === "function" ? opt.clock : () => Date.now();
  const log = typeof opt.log === "function" ? opt.log : () => {};
  let ruleSet = opt.ruleSet === undefined ? { rules: [] } : opt.ruleSet;
  const lastFired = new Map();
  const counters = { evaluated: 0, matched: 0, suppressed: 0, shadowed: 0 };

  function setRuleSet(next) { ruleSet = next; }

  function enabledRules() {
    return (ruleSet.rules || []).filter((r) => r.enabled !== false && r.enabledByDefault !== false);
  }

  function evaluate(event) {
    const ev = event === undefined || event === null ? {} : event;
    const facts = Object.assign({}, ev.payload === undefined ? {} : ev.payload, ev.facts === undefined ? {} : ev.facts, {
      eventType: ev.type,
      subject: ev.subject,
      at: ev.at === undefined ? clock() : ev.at
    });
    const now = facts.at;
    const decisions = [];
    const suppressed = [];
    counters.evaluated += 1;

    for (const rule of enabledRules()) {
      if (!matchEvent(rule.when, ev.type)) continue;
      let hit = false;
      try { hit = evaluateExpr(rule.if, facts); } catch (error) { log("warn", "rule " + rule.id + " expression failed: " + String(error)); continue; }
      if (!hit) continue;
      counters.matched += 1;
      const key = rule.id + "|" + String(ev.subject);
      const last = lastFired.get(key);
      const cooldownMs = Number(rule.cooldownSec) * 1000;
      if (last !== undefined && now - last < cooldownMs) {
        counters.suppressed += 1;
        suppressed.push({ ruleId: rule.id, reason: "cooldown", until: last + cooldownMs });
        continue;
      }
      lastFired.set(key, now);
      const shadow = Number(rule.shadowHours) > 0 && Number(rule.shadowHours) * 3_600_000 > 0;
      if (shadow) counters.shadowed += 1;
      decisions.push({
        ruleId: rule.id,
        title: rule.title,
        severity: rule.severity,
        subject: ev.subject,
        actions: rule.actions,
        params: rule.params,
        shadow,
        at: now,
        facts: { eventType: ev.type, subject: ev.subject }
      });
    }

    return { decisions: resolveConflicts(decisions, suppressed), suppressed, counters: Object.assign({}, counters) };
  }

  function stats() {
    return Object.assign({ rules: (ruleSet.rules || []).length, hash: ruleSet.hash === undefined ? null : ruleSet.hash }, counters);
  }

  function resetCooldowns() { lastFired.clear(); }

  return { evaluate, stats, setRuleSet, resetCooldowns, ruleSet: () => ruleSet };
}

/** 同 subject 同 workflow：severity 高者胜，平手取先出现的。 */
export function resolveConflicts(decisions, suppressed) {
  const kept = [];
  const sink = Array.isArray(suppressed) ? suppressed : [];
  for (const decision of decisions) {
    let blocked = false;
    for (const other of kept.slice()) {
      if (other.subject !== decision.subject) continue;
      const same = other.actions.some((a) => decision.actions.some((b) => b.workflow === a.workflow));
      if (!same) continue;
      const mine = severityRank(decision.severity);
      const theirs = severityRank(other.severity);
      if (mine > theirs) {
        kept.splice(kept.indexOf(other), 1);
        sink.push({ ruleId: other.ruleId, reason: "conflict", lostTo: decision.ruleId });
      } else {
        blocked = true;
        sink.push({ ruleId: decision.ruleId, reason: "conflict", lostTo: other.ruleId });
        break;
      }
    }
    if (!blocked) kept.push(decision);
  }
  return kept;
}

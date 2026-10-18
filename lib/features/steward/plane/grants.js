/**
 * 授权映射（能力平面 §2/§5）：把 policy.js 的 actLevel 翻译成管线认识的 grant。
 *
 * 判定（verdict）与片段（plan）自身没有副作用，恒为 act —— 它们的副作用在
 * 里面 call 的动作能力上，逐个过闸：L1 只放通知，L2 加只读动作，L3 才能写。
 * actMode=echo 仍然在管线的最外层生效（动作变成预演），两者是独立的闸门。
 */
import { ACTION_LEVELS } from "../policy.js";

const RANK = { L1: 0, L2: 1, L3: 2 };

/** 能力 id → policy.js 的动作名。没列出的按能力 id 自身查表，查不到按 L3（默认收紧）。 */
const CAP_ACTION = {
  "notify.desktop": "notify.send",
  "notify.lark": "notify.send",
  "report.digest": "digest.send",
  "ask.owner": "task.create",
  "record.journal": "collect",
  "collect.sample": "collect",
  "slim.host": "slim",
  "steer.session": "agent.steer",
  "cancel.session": "agent.cancel",
  "session.create": "session.create",
  "task.create": "task.create",
  "task.dispatch": "task.dispatch",
  "settings.write": "settings.write",
  "peer.send": "notify.send"
};

export function actionFor(capId) {
  const id = String(capId === undefined || capId === null ? "" : capId);
  return CAP_ACTION[id] !== undefined ? CAP_ACTION[id] : id;
}

export function needOf(spec) {
  const action = actionFor(spec !== undefined && spec !== null ? spec.id : "");
  return ACTION_LEVELS[action] !== undefined ? ACTION_LEVELS[action] : "L3";
}

/** 返回 "act" | "denied"（dry-run 由编制里的 equip 覆盖或 grant=dry-run 指定）。 */
export function grantFor(spec, actLevel, overrides) {
  if (spec === undefined || spec === null) return "denied";
  if (spec.payload === "verdict" || spec.payload === "plan") return "act";
  if (overrides !== undefined && overrides !== null && typeof overrides === "object") {
    if (overrides[spec.id] !== undefined) return String(overrides[spec.id]);
    if (overrides["*"] !== undefined) return String(overrides["*"]);
  }
  const have = RANK[String(actLevel)] === undefined ? RANK.L2 : RANK[String(actLevel)];
  const need = RANK[needOf(spec)] === undefined ? RANK.L3 : RANK[needOf(spec)];
  return have >= need ? "act" : "denied";
}

export function describeGrants(actLevel) {
  const out = { level: String(actLevel), allows: [], denies: [] };
  for (const cap of Object.keys(CAP_ACTION)) {
    const spec = { id: cap, payload: "action" };
    (grantFor(spec, actLevel) === "act" ? out.allows : out.denies).push(cap);
  }
  return out;
}

export default { grantFor, actionFor, needOf, describeGrants };

/**
 * 交接摘要：轮换前写给下一任总管。只写"现在什么状态、什么还没做完、谁在等谁"，
 * 不复述历史对话（那是 session log 的职责）。
 */
import { renderRollup } from "./rollup.js";

export function buildHandoff(input) {
  const i = input === undefined || input === null ? {} : input;
  const lines = [];
  lines.push("# 总管交接摘要");
  lines.push("");
  lines.push("生成于 " + new Date(i.now === undefined ? Date.now() : i.now).toISOString() + "，原因：" + String(i.reason === undefined ? "rotate" : i.reason));
  lines.push("");
  if (i.rollup !== undefined && i.rollup !== null) {
    lines.push("## 当前态势");
    lines.push("");
    lines.push(renderRollup(i.rollup));
    lines.push("");
  }
  const pending = Array.isArray(i.pending) ? i.pending : [];
  lines.push("## 未决事项");
  lines.push("");
  if (pending.length === 0) lines.push("- 无");
  for (const item of pending) {
    const bits = [];
    if (item.kind !== undefined) bits.push(String(item.kind));
    if (item.subject !== undefined) bits.push("subject=" + String(item.subject));
    if (item.deadline !== undefined && item.deadline !== null) bits.push("deadline=" + new Date(Number(item.deadline)).toISOString());
    lines.push("- " + String(item.title === undefined ? item.id : item.title) + (bits.length === 0 ? "" : " (" + bits.join(", ") + ")"));
  }
  const decisions = Array.isArray(i.decisions) ? i.decisions : [];
  if (decisions.length > 0) {
    lines.push("");
    lines.push("## 最近决策");
    lines.push("");
    for (const d of decisions.slice(0, 10)) lines.push("- " + String(d.summary === undefined ? d.id : d.summary));
  }
  lines.push("");
  lines.push("## 给下一任的提示");
  lines.push("");
  lines.push("- 先看面板的“待决”，再看 DLQ；不要重放你没读过的动作。");
  lines.push("- 行动前确认 settings.autoAct 与动作等级；L3 只对白名单。");
  return lines.join("\n");
}

/**
 * 预算口径回归（评审 P1-C）：预演/被拒/信号/记账条目不占 budgetPerHour，
 * 否则 5 秒心跳 + echo 预演就能把额度烧满，随后 brain 会抑制所有工作流。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../lib/features/steward/core/store.js";
import { createViews } from "../lib/features/steward/state.js";

function tempStore() {
  return createStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "polaris-budget-")), log: () => {} });
}

test("chargeOf counts only real actions", () => {
  const store = tempStore();
  const charged = (action) => store.chargeOf(action);

  assert.equal(charged({ kind: "echo" }), false, "预演不占预算");
  assert.equal(charged({ kind: "denied" }), false, "被拦不占预算");
  assert.equal(charged({ kind: "signal", severity: "critical" }), false, "信号不占预算");
  assert.equal(charged({ kind: "settings" }), false, "改设置不占预算");
  assert.equal(charged({ kind: "approval" }), false, "审批记账不占预算");
  assert.equal(charged({ kind: "route" }), false, "归类不占预算");
  assert.equal(charged({ kind: "chat" }), false, "面板发话不占预算");
  assert.equal(charged({ kind: "task", message: "新建交办 #1 看看" }), false, "建单不占预算");
  assert.equal(charged({ kind: "task", message: "交办 #1 完成：搞定" }), false, "报完成不占预算");
  assert.equal(charged({ kind: "task", message: "交办 #1 取消" }), false, "取消不占预算");

  assert.equal(charged({ kind: "escalate", message: "已催 x" }), true, "真催了要占");
  assert.equal(charged({ kind: "act", message: "notify.desktop" }), true, "能力执行要占");
  assert.equal(charged({ kind: "task", message: "交办 #1 已派给 session-abc" }), true, "派发要占");
  assert.equal(charged({ kind: "task", message: "交办 #1 发送失败：busy" }), true, "失败重试也消耗过额度");
  assert.equal(charged({ kind: "act", preview: true }), false, "preview 标记优先");
  assert.equal(charged({ kind: "signal", charge: true }), true, "显式 charge=true 覆盖");
  assert.equal(charged({ kind: "act", charge: false }), false, "显式 charge=false 覆盖");

  store.flush();
  fs.rmSync(store.dir, { recursive: true, force: true });
});

test("budgetView counts real actions over the whole journal window", () => {
  const store = tempStore();
  const now = Date.now();
  // 心跳/预演/信号 10 条空转 + 2 条真动作。
  for (let i = 0; i < 10; i += 1) store.pushAction({ kind: i % 2 === 0 ? "echo" : "signal", at: now - 1000, message: "noise " + i });
  store.pushAction({ kind: "escalate", at: now - 500, message: "已催 session-a" });
  store.pushAction({ kind: "task", at: now - 400, message: "交办 #7 已派给 session-b" });
  store.pushAction({ kind: "escalate", at: now - 3_700_000, message: "一小时以前的，不该计入" });

  const views = createViews({
    store,
    titles: { size: () => 0 },
    health: { last: null },
    events: {},
    modules: () => [],
    readSettings: () => ({ budgetPerHour: 60, federation: { hostId: "test" } }),
    approvals: {},
    engine: undefined,
    scope: { metrics: { snapshot: () => ({}) } }
  });
  const budget = views.budgetView(now);
  assert.equal(budget.used, 2, "只有两条真动作占预算");
  assert.equal(budget.entries, 12, "一小时内的全部记账条目");
  assert.equal(budget.free, 10, "空转条目数");
  assert.equal(budget.max, 60);
  assert.equal(budget.pct, Math.round((2 / 60) * 1000) / 10);

  store.flush();
  fs.rmSync(store.dir, { recursive: true, force: true });
});

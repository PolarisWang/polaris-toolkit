/**
 * 内置工作流：规则只负责"发现"，工作流负责"做事"。
 *
 * 每个 wf 都很短，真正的复杂度在引擎（重试/幂等/等待/租约）与执行器里。
 * 约定：vars 里带 { subject, title, text, level, moduleId, ... }。
 *
 * 注意：ctx.effect() 返回 { ok, value }（value 才是副作用函数的返回值），
 * 所以取结果一律用 .value，别拿外层 ok 当业务结果。
 */
import { buildRollup, renderRollup } from "../session/rollup.js";

function str(v, fallback) {
  return typeof v === "string" && v !== "" ? v : fallback;
}

function valueOf(effect) {
  return effect === undefined || effect === null ? undefined : effect.value;
}

export function defineWorkflows(options) {
  const o = options === undefined ? {} : options;
  const engine = o.engine;
  const notify = o.notify;
  const actions = o.actions === undefined ? {} : o.actions;
  const settings = typeof o.settings === "function" ? o.settings : () => ({});
  const hostCtx = typeof o.hostCtx === "function" ? o.hostCtx : () => undefined;
  const log = typeof o.log === "function" ? o.log : () => {};

  function notifyVia(title, text, level, subject) {
    if (notify === undefined) return { ok: true, skipped: "no-notifier" };
    return notify.send({ title, text, level, subject });
  }

  /** 通用：发一条通知。 */
  engine.define({
    name: "wf.notify",
    version: 1,
    start: "send",
    steps: {
      async send(ctx) {
        const v = ctx.vars;
        const effect = await ctx.effect("notify", str(v.subject, "unknown"), {
          title: str(v.title, "Polaris 通知"), text: String(v.text === undefined ? "" : v.text), level: str(v.level, "warning")
        }, async () => notifyVia(str(v.title, "Polaris 通知"), String(v.text === undefined ? "" : v.text), str(v.level, "warning"), v.subject));
        const sent = valueOf(effect);
        return { done: true, output: { notified: sent !== undefined && sent !== null && sent.ok === true } };
      }
    }
  });

  /** 请示：建审批 → 等答复或超时 → 结束（结果留在 output 里）。 */
  engine.define({
    name: "wf.ask",
    version: 1,
    start: "open",
    steps: {
      async open(ctx) {
        const v = ctx.vars;
        const approve = actions.approval;
        if (approve === undefined) return { done: true, output: { skipped: "no-approval-store" } };
        const ttlMs = Number(v.ttlMs === undefined ? 1_800_000 : v.ttlMs);
        ctx.setVar("deadline", ctx.now + ttlMs);
        const effect = await ctx.effect("approval", str(v.subject, "unknown"), {
          title: str(v.title, "请示"), detail: String(v.detail === undefined ? "" : v.detail), level: str(v.level, "warning")
        }, async () => approve.create({
          title: str(v.title, "请示"), detail: String(v.detail === undefined ? "" : v.detail),
          subject: v.subject, moduleId: v.moduleId, level: str(v.level, "warning"), ttlMs
        }));
        const row = valueOf(effect);
        ctx.setVar("approvalId", row === undefined || row === null ? null : row.id);
        return { next: "wait" };
      },
      async wait(ctx) {
        const v = ctx.vars;
        if (v.approvalId === null || v.approvalId === undefined) return { done: true, output: { skipped: "no-approval" } };
        const approve = actions.approval;
        const row = approve === undefined ? null : approve.get(v.approvalId);
        if (row !== null && row !== undefined && row.status !== "open") {
          return { done: true, output: { answered: row.status, answer: row.answer } };
        }
        const deadline = Number(v.deadline === undefined ? 0 : v.deadline);
        if (deadline > 0 && ctx.now >= deadline) {
          if (approve !== undefined) approve.expire(v.approvalId);
          return { done: true, output: { answered: "expired" } };
        }
        return { waitUntil: deadline > 0 ? deadline : ctx.now + 60_000 };
      }
    }
  });

  /** agent 卡住：先通知；只有 autoAct 打开且 stallSteer 打开时才 steer 父会话。 */
  engine.define({
    name: "wf.agent.stall",
    version: 1,
    start: "inspect",
    steps: {
      async inspect(ctx) {
        const v = ctx.vars;
        const cfg = settings();
        const caps = cfg.actions === undefined || cfg.actions === null ? {} : cfg.actions;
        const minutes = Math.round(Number(v.silenceMs === undefined ? 0 : v.silenceMs) / 60_000);
        const effect = await ctx.effect("notify", str(v.subject, "unknown"), { title: "agent 卡住", text: str(v.text, "已静默 " + minutes + " 分钟"), level: "warning" }, async () => notifyVia(
          "agent 卡住：" + str(v.title, str(v.subject, "unknown")),
          "已静默 " + minutes + " 分钟，模块 " + str(v.moduleId, "unassigned"),
          "warning", v.subject
        ));
        const sent = valueOf(effect);
        ctx.setVar("notified", sent !== undefined && sent !== null && sent.ok === true);
        if (cfg.autoAct !== true || caps.stallSteer !== true) return { done: true, output: { acted: false } };
        return { next: "steer" };
      },
      async steer(ctx) {
        const v = ctx.vars;
        const prompt = actions.prompt;
        if (prompt === undefined) return { done: true, output: { acted: false, reason: "no-prompter" } };
        if (typeof v.parentSessionId !== "string" || v.parentSessionId === "") return { done: true, output: { acted: false, reason: "no-parent" } };
        const effect = await ctx.effect("prompt", v.parentSessionId, { text: "子系统静默，请确认进度" }, async () => prompt.prompt(hostCtx(), {
          sessionId: v.parentSessionId, mode: "followup",
          requestId: "stall:" + String(v.subject === undefined ? ctx.run.subject : v.subject) + ":" + String(ctx.run.id)
        }));
        const sent = valueOf(effect);
        return { done: true, output: { acted: sent !== undefined && sent !== null && sent.ok === true } };
      }
    }
  });

  /** 宿主保护：heap 高水位时通知；真正的清理动作默认关闭。 */
  engine.define({
    name: "wf.host.protect",
    version: 1,
    start: "notify",
    steps: {
      async notify(ctx) {
        const v = ctx.vars;
        const cfg = settings();
        const caps = cfg.actions === undefined || cfg.actions === null ? {} : cfg.actions;
        const text = "堆 " + String(v.usedMB === undefined ? "?" : v.usedMB) + "MB / " + String(v.limitMB === undefined ? "?" : v.limitMB) + "MB（" + String(v.pct === undefined ? "?" : v.pct) + "%）";
        const effect = await ctx.effect("notify", "host", { title: "宿主内存高水位", text, level: str(v.level, "critical") }, async () => notifyVia("宿主内存高水位", text, str(v.level, "critical"), "host"));
        const sent = valueOf(effect);
        ctx.setVar("notified", sent !== undefined && sent !== null && sent.ok === true);
        if (cfg.autoAct !== true || caps.heapSlim !== true) return { done: true, output: { acted: false } };
        return { next: "slim" };
      },
      async slim(ctx) {
        const slim = actions.slim;
        if (slim === undefined) return { done: true, output: { acted: false, reason: "no-slimmer" } };
        const effect = await ctx.effect("slim", "host", { level: 3 }, async () => slim(3));
        const done = valueOf(effect);
        return { done: true, output: { acted: done !== undefined && done !== null && done.ok === true, result: done === undefined ? null : done } };
      }
    }
  });

  /** 定期汇报：把 rollup 渲染成一段话发出去（默认关闭）。 */
  engine.define({
    name: "wf.digest",
    version: 1,
    start: "render",
    steps: {
      async render(ctx) {
        const v = ctx.vars;
        const rollup = buildRollup({
          agents: Array.isArray(v.agents) ? v.agents : [],
          runs: Array.isArray(v.runs) ? v.runs : [],
          signals: Array.isArray(v.signals) ? v.signals : [],
          approvals: Array.isArray(v.approvals) ? v.approvals : [],
          health: v.health, now: ctx.now
        });
        const text = renderRollup(rollup);
        await ctx.effect("notify", "digest", { text }, async () => notifyVia("Polaris 汇报", text, "info", "digest"));
        return { done: true, output: { chars: text.length } };
      }
    }
  });

  return engine;
}
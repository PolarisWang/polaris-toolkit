/**
 * 体检（能力平面 §6.7）：把"哪条设计有毛病"直接翻译成结论 + 修法入口，不让人读日志。
 *
 * 九类归因：route-denied / need-grant / no-voice / stuck-step / budget-exhausted /
 * cap-failed / silent-steward / dead-branch / noisy-branch。只在命中时产出条目，
 * 全绿时 checks 为空 —— 面板只显示结论与跳转。
 */
import { SESSION_CAPS } from "./routes.js";

function str(v, fallback) { return v === undefined || v === null ? fallback : String(v); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

export function createDoctor(options) {
  const opts = options === undefined || options === null ? {} : options;
  const plane = opts.plane === undefined || opts.plane === null ? {} : opts.plane;
  const clock = typeof opts.clock === "function" ? opts.clock : Date.now;
  const silentMs = num(opts.silentMs) > 0 ? num(opts.silentMs) : 600000;
  const windowMs = num(opts.windowMs) > 0 ? num(opts.windowMs) : 86400000;

  function safe(fn, fallback) {
    try {
      const v = fn();
      return v === undefined ? fallback : v;
    } catch { return fallback; }
  }

  function reasonCount(reasons, agg, key) {
    const byReason = agg.byReason === undefined ? {} : agg.byReason;
    return num(reasons[key]) + num(byReason[key]);
  }

  function run() {
    const now = clock();
    const agg = safe(function () { return plane.trace.aggregates(); }, { traces: 0, intents: 0, effects: 0, byReason: {}, byDecision: {}, byTrigger: {}, byCap: {}, effectFails: [] });
    const stewards = safe(function () { return plane.stewards(); }, []);
    const capabilities = safe(function () { return plane.describe().capabilities; }, []);
    const stats = safe(function () { return plane.stats(); }, {});
    const pipeline = stats.pipeline === undefined || stats.pipeline === null ? {} : stats.pipeline;
    const reasons = pipeline.reasons === undefined || pipeline.reasons === null ? {} : pipeline.reasons;
    const checks = [];

    function add(id, level, title, conclusion, fix, evidence) {
      checks.push({ id: id, level: level, title: title, conclusion: conclusion, fix: fix, evidence: evidence === undefined ? {} : evidence });
    }

    const denied = reasonCount(reasons, agg, "route-denied");
    if (denied > 0) add("route-denied", "error", "被路由矩阵拒绝", denied + " 次调用被路由判成 deny —— 这类对象类主管永远发不出去。", { page: "routes" }, { count: denied });

    const grant = reasonCount(reasons, agg, "need-grant");
    if (grant > 0) add("need-grant", "error", "主管没有这项授权", grant + " 次调用因授权不足被拒；要么调 actLevel，要么改这条编制的装备。", { page: "stewards" }, { count: grant });

    const virtual = [];
    for (const s of stewards) {
      const voice = s.voice === undefined || s.voice === null ? {} : s.voice;
      if (str(voice.mode, "virtual") !== "virtual") continue;
      const caps = s.equips === undefined ? [] : s.equips;
      if (caps.some(function (c) { return SESSION_CAPS.indexOf(c) >= 0; })) virtual.push(s.id);
    }
    if (virtual.length > 0) add("no-voice", "warn", "virtual 发声却要操作会话", virtual.join("、") + " 的音色是 virtual，却装备了 session.* 能力；要么配 voice.sessionId，要么换能力。", { page: "stewards", target: virtual[0] }, { stewards: virtual });

    const stuck = reasonCount(reasons, agg, "wait-timeout");
    if (stuck > 0) add("stuck-step", "warn", "等待步骤卡住", stuck + " 次 wait 超时，超时之后的步骤没有执行。", { page: "stewards" }, { count: stuck });

    const budget = reasonCount(reasons, agg, "budget-exhausted");
    if (budget > 0) add("budget-exhausted", "warn", "预算已满，动作被抑制", budget + " 次动作因预算没做；审计里看是谁烧掉的。", { page: "audit" }, { count: budget });

    const fails = agg.effectFails === undefined ? [] : agg.effectFails;
    if (fails.length > 0) {
      const byCode = {};
      for (const f of fails) {
        const k = str(f.errorCode, "failed");
        byCode[k] = num(byCode[k]) + 1;
      }
      const top = Object.keys(byCode).sort(function (a, b) { return byCode[b] - byCode[a]; }).slice(0, 3).map(function (k) { return { errorCode: k, count: byCode[k] }; });
      add("cap-failed", "error", "能力执行失败", fails.length + " 次调用失败（" + top.map(function (t) { return t.errorCode + "×" + t.count; }).join("、") + "）。", { page: "capabilities" }, { top: top, total: fails.length });
    }

    for (const s of stewards) {
      if (s.enabled === false) continue;
      const events = s.events === undefined || s.events.length === 0 ? ["host/tick"] : s.events;
      let last = 0;
      for (const ev of events) {
        const hit = safe(function () { return plane.trace.history({ trigger: ev, limit: 1 }); }, []);
        if (hit.length > 0) last = Math.max(last, num(hit[0].startedAt));
      }
      const ticking = events.indexOf("host/tick") >= 0 || events.indexOf("agent/tick") >= 0;
      if (ticking && last > 0 && now - last > silentMs) {
        add("silent-steward", "error", "主管停摆", s.id + " 的 tick 已经 " + String(Math.round((now - last) / 60000)) + " 分钟没有触发过。", { page: "stewards", target: s.id }, { lastAt: last, silentMs: now - last });
      }
      const byTrigger = agg.byTrigger === undefined ? {} : agg.byTrigger;
      const seen = events.some(function (ev) { return num(byTrigger[ev]) > 0; });
      if (!seen && last === 0) add("dead-branch", "warn", "编制从未命中", s.id + " 监听的 " + events.join("/") + " 在窗口内没有产生过 trace，可能白写。", { page: "stewards", target: s.id }, { events: events, windowMs: windowMs });
    }

    const noisy = [];
    const caps = agg.byCap === undefined ? {} : agg.byCap;
    for (const id of Object.keys(caps)) {
      const c = caps[id];
      const total = num(c.total);
      const idle = num(c.skip) + num(c.preview);
      if (total >= 5 && idle * 100 / total > 80) noisy.push({ cap: id, total: total, skip: num(c.skip), preview: num(c.preview) });
    }
    if (noisy.length > 0) {
      add("noisy-branch", "warn", "分支空转", noisy.slice(0, 3).map(function (n) { return n.cap + "（" + String(n.total) + " 次里 " + String(n.skip) + " 跳过 / " + String(n.preview) + " 预演）"; }).join("；") + "，多半是重复写或 echo 还没切 live。", { page: "stewards" }, { noisy: noisy.slice(0, 5) });
    }

    const byDecision = agg.byDecision === undefined ? {} : agg.byDecision;
    return {
      ok: true,
      generatedAt: now,
      healthy: checks.length === 0,
      windowMs: windowMs,
      counts: { traces: num(agg.traces), intents: num(agg.intents), effects: num(agg.effects), capabilities: capabilities.length, stewards: stewards.length, denied: num(byDecision.deny) },
      checks: checks
    };
  }

  return { run: run, silentMs: function () { return silentMs; } };
}

export default { createDoctor };

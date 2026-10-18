/**
 * 持久工作流引擎。
 *
 * 设计要点（docs/steward-design.md 第 6 章）：
 *   1. 所有副作用都走 ctx.effect()，它先写 actions 的 intent 行、再执行、再写 result；
 *      同一个 idemKey 只会真正执行一次，重放时直接返回上次的 result。
 *   2. 所有等待都落库（timers 表 + runs.wake_at），进程重启后由 tick() 继续推进。
 *   3. 步骤失败按指数退避重试，超过 maxAttempts 进 dlq，run 标 failed。
 *   4. 按 subject 加租约，同一 subject 上的 run 串行推进（lease_until + lease_owner）。
 *   5. 时钟可注入，测试可以在毫秒内把 24 小时跑完。
 *
 * 步骤处理器收到的 ctx：
 *   { run, vars, step, input, now, clock, db, log, owner,
 *     effect(kind, target, payload, fn, level), setVar(k,v), getRun(), idem(suffix) }
 *
 * 处理器返回值：
 *   undefined / 任意值        -> 步骤完成，output 记为该值
 *   { done: true, output }    -> 同上
 *   { wait: 毫秒 }            -> 创建定时器，run 进入 waiting
 *   { waitUntil: 时间戳 }     -> 同上，绝对时间
 *   { next: "stepId" }        -> 跳到指定步骤（分支）
 *   { fail: "原因", retry }   -> 失败；retry 缺省 true
 */
import crypto from "node:crypto";

const ACTIVE = ["pending", "running", "waiting"];

export function createEngine(options) {
  const opt = options === undefined || options === null ? {} : options;
  const db = opt.db;
  if (db === undefined) throw new Error("engine needs a db");
  const clock = typeof opt.clock === "function" ? opt.clock : () => Date.now();
  const log = typeof opt.log === "function" ? opt.log : () => {};
  const owner = typeof opt.owner === "string" ? opt.owner : "local";
  const leaseMs = Number(opt.leaseMs === undefined ? 60_000 : opt.leaseMs);
  const maxAttempts = Number(opt.maxAttempts === undefined ? 3 : opt.maxAttempts);
  const backoffMs = Number(opt.backoffMs === undefined ? 2_000 : opt.backoffMs);
  const graceMs = Number(opt.graceMs === undefined ? 15_000 : opt.graceMs);
  const recovery = typeof opt.recovery === "function" ? opt.recovery : undefined;
  const onFinish = typeof opt.onFinish === "function" ? opt.onFinish : undefined;
  const defs = new Map();

  function define(def) {
    if (def === undefined || typeof def.name !== "string") throw new Error("workflow needs a name");
    const steps = def.steps === undefined ? {} : def.steps;
    if (typeof def.start !== "string" || steps[def.start] === undefined) throw new Error("workflow " + def.name + " has no valid start step");
    for (const id of Object.keys(steps)) {
      let step = steps[id];
      // 允许把步骤直接写成函数：steps: { send: async (ctx) => ... }
      if (typeof step === "function") { step = { run: step }; steps[id] = step; }
      if (step === null || typeof step !== "object") throw new Error("workflow " + def.name + " step " + id + " is not an object");
      if (step.next !== undefined && steps[step.next] === undefined) throw new Error("workflow " + def.name + " step " + id + " points at unknown step " + step.next);
    }
    const frozen = Object.assign({}, def, { steps, version: Number(def.version === undefined ? 1 : def.version) });
    defs.set(frozen.name, frozen);
    return frozen;
  }

  function defOf(name) {
    const def = defs.get(name);
    if (def === undefined) throw new Error("unknown workflow: " + name);
    return def;
  }

  function newRunId() {
    return "run-" + Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
  }

  function start(name, options2) {
    const o = options2 === undefined || options2 === null ? {} : options2;
    const def = defOf(name);
    if (typeof o.id === "string") {
      const existing = db.get("runs", { id: o.id });
      if (existing !== undefined) return existing;
    }
    const now = clock();
    const run = {
      id: typeof o.id === "string" ? o.id : newRunId(),
      wf: def.name,
      wf_version: def.version,
      trace_id: typeof o.traceId === "string" ? o.traceId : "trace-" + crypto.randomBytes(6).toString("hex"),
      host_id: typeof o.hostId === "string" ? o.hostId : "local",
      module_id: typeof o.moduleId === "string" ? o.moduleId : "unassigned",
      subject: typeof o.subject === "string" ? o.subject : "global",
      status: "pending",
      vars_json: o.vars === undefined ? {} : o.vars,
      current_step: def.start,
      wake_at: null,
      deadline: typeof o.deadline === "number" ? o.deadline : null,
      lease_until: null,
      lease_owner: null,
      shadow: o.shadow === true ? 1 : 0,
      error: null,
      attempts: 0,
      created_at: now,
      updated_at: now
    };
    return db.insert("runs", run);
  }

  function get(id) {
    return db.get("runs", { id });
  }

  function list(filter) {
    const f = filter === undefined || filter === null ? {} : filter;
    let rows = db.all("runs");
    if (Array.isArray(f.status)) rows = rows.filter((r) => f.status.indexOf(r.status) >= 0);
    else if (typeof f.status === "string") rows = rows.filter((r) => r.status === f.status);
    if (typeof f.hostId === "string") rows = rows.filter((r) => r.host_id === f.hostId);
    if (typeof f.subject === "string") rows = rows.filter((r) => r.subject === f.subject);
    rows.sort((a, b) => b.updated_at - a.updated_at);
    const limit = typeof f.limit === "number" ? f.limit : 50;
    return rows.slice(0, limit);
  }

  function setRun(run, fields) {
    const next = Object.assign({}, fields, { updated_at: clock() });
    db.update("runs", { id: run.id }, next);
    return db.get("runs", { id: run.id });
  }

  function stepRow(runId, stepId, attempt) {
    return db.get("steps", { run_id: runId, step_id: stepId, attempt });
  }

  function lastAttempt(runId, stepId) {
    const rows = db.all("steps").filter((r) => r.run_id === runId && r.step_id === stepId);
    let max = 0;
    for (const row of rows) max = Math.max(max, Number(row.attempt));
    return max;
  }

  function leaseKey(subject) {
    return "lease:" + subject;
  }

  /** 同一 subject 上的 run 串行：拿不到租约就等下一 tick。 */
  function claim(run, now) {
    const key = leaseKey(run.subject);
    const held = db.get("subjects", { id: key });
    if (held !== undefined && Number(held.owner_at) > now && held.reason !== run.id) return false;
    if (held === undefined) db.insert("subjects", { id: key, kind: "lease", host_id: run.host_id, module_id: run.module_id, owner_at: now + leaseMs, pinned: 0, reason: run.id, confidence: 1 });
    else db.update("subjects", { id: key }, { owner_at: now + leaseMs, reason: run.id, host_id: run.host_id, module_id: run.module_id });
    db.update("runs", { id: run.id }, { lease_until: now + leaseMs, lease_owner: owner });
    return true;
  }

  function release(run) {
    const held = db.get("subjects", { id: leaseKey(run.subject) });
    if (held !== undefined && held.reason === run.id) db.update("subjects", { id: leaseKey(run.subject) }, { owner_at: 0, reason: null });
  }

  function finish(run, status, error) {
    release(run);
    for (const timer of db.all("timers").filter((t) => t.run_id === run.id)) db.remove("timers", { id: timer.id });
    const next = setRun(run, { status, error: error === undefined ? null : String(error), wake_at: null });
    if (status === "done" || status === "failed" || status === "cancelled") {
      if (onFinish !== undefined) {
        try { onFinish(next); } catch (err) { log("warn", "engine onFinish failed: " + String(err)); }
      }
    }
    return next;
  }

  function toDlq(run, stepId, reason, payload) {
    try {
      db.insert("dlq", { run_id: run.id, step_id: stepId === undefined ? null : stepId, reason: String(reason), payload_json: payload === undefined ? null : payload, at: clock(), resolved: 0 });
    } catch (err) {
      log("warn", "engine dlq insert failed: " + String(err));
    }
  }

  function idemKey(run, stepId, suffix) {
    return [run.id, stepId, suffix === undefined ? "main" : String(suffix)].join("|");
  }

  /** 三段式副作用：intent -> 执行 -> result；同一 idemKey 只执行一次。 */
  function effectFor(run, stepId, pending) {
    return function effect(kind, target, payload, fn, level) {
      const promise = runEffect(run, stepId, kind, target, payload, fn, level);
      if (Array.isArray(pending)) pending.push(promise);
      return promise;
    };
  }

  async function runEffect(run, stepId, kind, target, payload, fn, level) {
    {
      const key = idemKey(run, stepId, kind + ":" + String(target));
      const existing = db.find("actions", { idem_key: key })[0];
      if (existing !== undefined && existing.result !== null && existing.result !== undefined) {
        let parsed = existing.result;
        try { parsed = JSON.parse(existing.result); } catch { /* plain string */ }
        return { ok: true, replayed: true, value: parsed };
      }
      const now = clock();
      let row = existing;
      if (row === undefined) {
        row = db.insert("actions", {
          idem_key: key, run_id: run.id, step_id: stepId, host_id: run.host_id,
          kind: String(kind), target: target === undefined ? null : String(target),
          payload_json: payload === undefined ? null : payload, level: Number(level === undefined ? 1 : level),
          result: null, error: null, at: now
        });
      }
      if (run.shadow === 1) {
        db.update("actions", { id: row.id }, { result: JSON.stringify({ shadow: true }), at: now });
        return { ok: true, shadow: true, value: { shadow: true } };
      }
      try {
        const value = fn === undefined ? undefined : await fn();
        db.update("actions", { id: row.id }, { result: JSON.stringify(value === undefined ? null : value), at: clock() });
        return { ok: true, value };
      } catch (error) {
        db.update("actions", { id: row.id }, { error: String(error), at: clock() });
        throw error;
      }
    }
  }

  async function runStep(run, stepId, now) {
    const def = defOf(run.wf);
    const step = def.steps[stepId];
    const attempt = lastAttempt(run.id, stepId) + 1;
    const idem = idemKey(run, stepId);
    const vars = run.vars_json !== null && typeof run.vars_json === "object" ? run.vars_json : {};
    /** resumed: 这次不是首次尝试（上一次等待到期或上一次失败退避到期）。 */
    const resumed = attempt > 1;
    const input = { attempt, vars, resumed };
    db.insert("steps", {
      run_id: run.id, step_id: stepId, kind: step.kind === undefined ? "call" : step.kind,
      attempt, status: step.effect === true ? "intent" : "running",
      intent_at: now, done_at: null, input_json: input, output_json: null, idem_key: idem
    });
    db.update("runs", { id: run.id }, { status: "running", attempts: Number(run.attempts === undefined ? 0 : run.attempts) + 1, updated_at: now });

    const pending = [];
    const ctx = {
      run, step, vars, input, resumed, now, clock, db, log, owner,
      setVar(k, v) { vars[k] = v; db.update("runs", { id: run.id }, { vars_json: vars }); },
      getRun() { return db.get("runs", { id: run.id }); },
      idem(suffix) { return idemKey(run, stepId, suffix); },
      effect: effectFor(run, stepId, pending)
    };

    let result;
    try {
      result = typeof step.run === "function" ? await step.run(ctx) : { done: true };
    } catch (error) {
      result = { fail: String(error), retry: true };
    }
    // 步骤里可能 fire-and-forget 地调了 ctx.effect（没 await），这里统一等它落库，
    // 否则 tick 结束时 result 还没写，副作用是否发生的判断就会错。
    if (pending.length > 0) {
      const settled = await Promise.allSettled(pending);
      const rejected = settled.find((item) => item.status === "rejected");
      if (rejected !== undefined && (result === null || typeof result !== "object" || !Object.prototype.hasOwnProperty.call(result, "fail"))) {
        result = { fail: String(rejected.reason), retry: true };
      }
    }

    const failed = result !== null && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "fail");
    if (failed) {
      const retry = result.retry !== false;
      db.update("steps", { run_id: run.id, step_id: stepId, attempt }, { status: "failed", done_at: clock(), output_json: { error: String(result.fail) } });
      const attemptCount = attempt;
      if (retry && attemptCount < maxAttempts) {
        const wakeAt = clock() + backoffMs * Math.pow(2, attemptCount - 1);
        db.insert("timers", { id: run.id + ":" + stepId + ":retry:" + attempt, run_id: run.id, step_id: stepId, fire_at: wakeAt, kind: "retry", payload_json: { attempt: attemptCount } });
        setRun(run, { status: "waiting", wake_at: wakeAt });
        return { state: "waiting" };
      }
      toDlq(run, stepId, result.fail, { attempt: attemptCount });
      finish(run, "failed", result.fail);
      return { state: "failed" };
    }

    if (result !== null && typeof result === "object" && (Object.prototype.hasOwnProperty.call(result, "wait") || Object.prototype.hasOwnProperty.call(result, "waitUntil"))) {
      const wakeAt = Object.prototype.hasOwnProperty.call(result, "waitUntil") ? Number(result.waitUntil) : clock() + Number(result.wait);
      db.update("steps", { run_id: run.id, step_id: stepId, attempt }, { status: "done", done_at: clock(), output_json: { waited: true } });
      db.insert("timers", { id: run.id + ":" + stepId + ":wait:" + wakeAt, run_id: run.id, step_id: stepId, fire_at: wakeAt, kind: "wait", payload_json: null });
      setRun(run, { status: "waiting", wake_at: wakeAt });
      return { state: "waiting" };
    }

    const output = result !== null && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "output") ? result.output : result;
    const next = result !== null && typeof result === "object" && typeof result.next === "string" ? result.next : step.next;
    db.update("steps", { run_id: run.id, step_id: stepId, attempt }, { status: "done", done_at: clock(), output_json: output === undefined ? null : output });
    if (typeof next === "string") {
      if (def.steps[next] === undefined) {
        toDlq(run, stepId, "next step missing: " + next, null);
        finish(run, "failed", "next step missing: " + next);
        return { state: "failed" };
      }
      setRun(run, { current_step: next, status: "running", wake_at: null });
      return { state: "advanced" };
    }
    finish(run, "done");
    return { state: "done" };
  }

  /** intent 行停在半路（进程死在执行与写 result 之间）交给恢复钩子裁决。 */
  function recoverAmbiguous(run, now) {
    const stepId = run.current_step;
    const attempt = lastAttempt(run.id, stepId);
    const row = stepRow(run.id, stepId, attempt);
    if (row === undefined || row.status !== "intent") return false;
    if (now - Number(row.intent_at) < graceMs) return false;
    let verdict = "fail";
    if (recovery !== undefined) {
      try { verdict = recovery({ run, step: row, now, db }) || "fail"; } catch (error) { log("warn", "recovery hook failed: " + String(error)); }
    }
    if (verdict === "done") {
      db.update("steps", { run_id: run.id, step_id: stepId, attempt }, { status: "done", done_at: now, output_json: { recovered: true } });
      const def = defOf(run.wf);
      const next = def.steps[stepId] === undefined ? undefined : def.steps[stepId].next;
      if (typeof next === "string") setRun(run, { current_step: next, status: "running" });
      else finish(run, "done");
      return true;
    }
    db.update("steps", { run_id: run.id, step_id: stepId, attempt }, { status: "failed", done_at: now, output_json: { recovered: "fail" } });
    toDlq(run, stepId, "ambiguous effect after restart", { attempt });
    finish(run, "failed", "ambiguous effect after restart");
    return true;
  }

  function dueTimers(now) {
    return db.all("timers").filter((t) => Number(t.fire_at) <= now).sort((a, b) => Number(a.fire_at) - Number(b.fire_at));
  }

  async function tick(nowArg) {
    const now = typeof nowArg === "number" ? nowArg : clock();
    const summary = { advanced: 0, waiting: 0, done: 0, failed: 0, timers: 0, skipped: 0 };
    for (const timer of dueTimers(now)) {
      db.remove("timers", { id: timer.id });
      const run = db.get("runs", { id: timer.run_id });
      if (run === undefined || ACTIVE.indexOf(run.status) < 0) continue;
      setRun(run, { status: "running", wake_at: null });
      summary.timers += 1;
    }

    const due = db.all("runs").filter((r) => ACTIVE.indexOf(r.status) >= 0);
    for (const run of due) {
      if (run.deadline !== null && Number(run.deadline) > 0 && now > Number(run.deadline)) {
        toDlq(run, run.current_step, "deadline exceeded", { deadline: run.deadline });
        finish(run, "failed", "deadline exceeded");
        summary.failed += 1;
        continue;
      }
      if (run.wake_at !== null && Number(run.wake_at) > now) { summary.skipped += 1; continue; }
      if (!claim(run, now)) { summary.skipped += 1; continue; }
      let guard = 0;
      let current = db.get("runs", { id: run.id });
      while (guard < 64) {
        guard += 1;
        if (current === undefined || ACTIVE.indexOf(current.status) < 0) break;
        if (current.wake_at !== null && Number(current.wake_at) > now) break;
        if (recoverAmbiguous(current, now)) { current = db.get("runs", { id: run.id }); summary.advanced += 1; continue; }
        const outcome = await runStep(current, current.current_step, now);
        current = db.get("runs", { id: run.id });
        if (outcome.state === "waiting") { summary.waiting += 1; break; }
        if (outcome.state === "failed") { summary.failed += 1; break; }
        if (outcome.state === "done") { summary.done += 1; break; }
        summary.advanced += 1;
      }
      release(current === undefined ? run : current);
    }
    db.flush();
    return summary;
  }

  function cancel(id, reason) {
    const run = db.get("runs", { id });
    if (run === undefined) return undefined;
    if (ACTIVE.indexOf(run.status) < 0) return run;
    for (const timer of db.all("timers").filter((t) => t.run_id === id)) db.remove("timers", { id: timer.id });
    return finish(run, "cancelled", reason);
  }

  function deliver(id, name, payload) {
    const run = db.get("runs", { id });
    if (run === undefined) return undefined;
    const vars = run.vars_json !== null && typeof run.vars_json === "object" ? run.vars_json : {};
    vars.signals = vars.signals === undefined ? {} : vars.signals;
    vars.signals[name] = payload === undefined ? true : payload;
    return setRun(run, { vars_json: vars, status: "running", wake_at: null });
  }

  function stats() {
    const runs = db.all("runs");
    const out = { total: runs.length, pending: 0, running: 0, waiting: 0, done: 0, failed: 0, cancelled: 0, timers: db.all("timers").length, dlq: db.all("dlq").filter((r) => Number(r.resolved) === 0).length };
    for (const run of runs) if (out[run.status] !== undefined) out[run.status] += 1;
    return out;
  }

  return { define, defs, start, get, list, tick, cancel, deliver, stats, clock, owner, db };
}
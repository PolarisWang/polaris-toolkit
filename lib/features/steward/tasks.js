/**
 * 任务表（C 方案里的"手"）：主人交办 → 派进某个会话 → 跟进 → 收口。
 *
 * 状态机：queued -> assigned -> running -> review -> done / failed
 *         任何未结束状态都可以 cancelled。
 *
 * 三条纪律：
 *  1) 派发要过两级闸门：actLevel 不够（policy.gate）不动手，actMode=echo 只打印不发送。
 *  2) 一个 tick 最多派 concurrency 单，且同一单失败 maxAttempts 次就熄火，不会无限重试。
 *  3) 会话侧只用 sessionController.prompt(mode=followup)，不抢跑、不打断正在跑的轮次。
 */
const STATUSES = ["queued", "assigned", "running", "review", "done", "failed", "cancelled"];
const OPEN_STATUSES = ["queued", "assigned", "running", "review"];

function nowMs() { return Date.now(); }

function textOr(value, fallback) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  return text === "" ? fallback : text;
}

export function createTasks({ scope, db, store, log, readSettings, policy, chat, prompter }) {
  function guard() {
    if (db === undefined || db === null) return { ok: false, reason: "db-unavailable" };
    return undefined;
  }

  function shape(row) {
    if (row === null || row === undefined) return undefined;
    return {
      id: Number(row.id),
      title: String(row.title === undefined || row.title === null ? "" : row.title),
      brief: String(row.brief === undefined || row.brief === null ? "" : row.brief),
      acceptance: String(row.acceptance === undefined || row.acceptance === null ? "" : row.acceptance),
      status: String(row.status === undefined ? "queued" : row.status),
      target: String(row.target === undefined ? "" : row.target),
      sessionId: row.session_id === null || row.session_id === undefined ? "" : String(row.session_id),
      moduleId: String(row.module_id === undefined || row.module_id === null ? "unassigned" : row.module_id),
      origin: String(row.origin === undefined || row.origin === null ? "owner" : row.origin),
      priority: Number(row.priority === undefined || row.priority === null ? 5 : row.priority),
      result: String(row.result === undefined || row.result === null ? "" : row.result),
      error: String(row.error === undefined || row.error === null ? "" : row.error),
      attempts: Number(row.attempts === undefined || row.attempts === null ? 0 : row.attempts),
      createdAt: Number(row.created_at === undefined ? 0 : row.created_at),
      updatedAt: Number(row.updated_at === undefined ? 0 : row.updated_at),
      assignedAt: Number(row.assigned_at === undefined ? 0 : row.assigned_at),
      doneAt: Number(row.done_at === undefined ? 0 : row.done_at),
      archived: row.archived === 1 || row.archived === true
    };
  }

  function allRows() {
    const g = guard();
    if (g !== undefined) return [];
    try { return db.all("tasks").map(shape); } catch (error) { log("warn", "steward: read tasks failed: " + String(error)); return []; }
  }

  /** 归档的行不再参与排队/统计，但仍然可以 get() 出来查历史。 */
  function activeRows() {
    return allRows().filter((row) => row.archived !== true);
  }

  function get(id) {
    const g = guard();
    if (g !== undefined) return undefined;
    const num = Number(id);
    if (!Number.isFinite(num)) return undefined;
    try {
      const row = db.get("tasks", { id: num });
      return row === undefined ? undefined : shape(row);
    } catch { return undefined; }
  }

  function ranking(row) {
    const statusRank = { running: 0, review: 1, assigned: 2, queued: 3, failed: 4, done: 5, cancelled: 6 };
    const a = statusRank[row.status] === undefined ? 9 : statusRank[row.status];
    return a;
  }

  function list(input) {
    const status = input !== null && typeof input === "object" && typeof input.status === "string" ? input.status : "";
    const limit = input !== null && typeof input === "object" && Number(input.limit) > 0 ? Math.min(200, Math.floor(Number(input.limit))) : 50;
    const wantArchived = input !== null && typeof input === "object" && input.archived === true;
    let rows = allRows().filter((row) => (row.archived === true) === wantArchived);
    if (status !== "" && status !== "all") rows = rows.filter((row) => row.status === status);
    rows.sort((a, b) => {
      const d = ranking(a) - ranking(b);
      if (d !== 0) return d;
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.id - a.id;
    });
    return rows.slice(0, limit);
  }

  function summary() {
    const rows = activeRows();
    const counts = {};
    for (const status of STATUSES) counts[status] = 0;
    for (const row of rows) if (counts[row.status] !== undefined) counts[row.status] += 1;
    return {
      counts,
      open: rows.filter((row) => OPEN_STATUSES.indexOf(row.status) >= 0).length,
      total: rows.length,
      running: counts.running,
      queued: counts.queued,
      review: counts.review
    };
  }

  function write(id, fields) {
    const g = guard();
    if (g !== undefined) return undefined;
    return db.update("tasks", { id: Number(id) }, fields);
  }

  function create(input) {
    const g = guard();
    if (g !== undefined) return { ok: false, reason: g.reason };
    const title = textOr(input === undefined || input === null ? "" : input.title, "");
    if (title === "") return { ok: false, reason: "title-required" };
    if (title.length > 200) return { ok: false, reason: "title-too-long" };
    const at = nowMs();
    let row;
    try {
      row = db.insert("tasks", {
        title,
        brief: textOr(input.brief, ""),
        acceptance: textOr(input.acceptance, ""),
        status: "queued",
        target: textOr(input.target, ""),
        session_id: textOr(input.sessionId, ""),
        module_id: textOr(input.moduleId, "unassigned"),
        origin: textOr(input.origin, "owner"),
        priority: Number.isFinite(Number(input.priority)) ? Math.max(0, Math.min(9, Math.floor(Number(input.priority)))) : 5,
        result: "",
        attempts: 0,
        error: "",
        created_at: at,
        updated_at: at,
        assigned_at: 0,
        done_at: 0
      });
    } catch (error) {
      return { ok: false, reason: "insert-failed: " + String(error) };
    }
    const shaped = shape(row);
    store.pushAction({ kind: "task", ok: true, message: "新建交办 #" + shaped.id + " " + title.slice(0, 40) });
    return { ok: true, task: shaped };
  }

  function update(id, patch) {
    const row = get(id);
    if (row === undefined) return { ok: false, reason: "not-found" };
    if (patch === undefined || patch === null || typeof patch !== "object") return { ok: false, reason: "empty-patch" };
    const fields = {};
    if (typeof patch.title === "string" && patch.title.trim() !== "") fields.title = patch.title.trim().slice(0, 200);
    if (typeof patch.brief === "string") fields.brief = patch.brief;
    if (typeof patch.acceptance === "string") fields.acceptance = patch.acceptance;
    if (typeof patch.target === "string") fields.target = patch.target.trim();
    if (typeof patch.moduleId === "string" && patch.moduleId.trim() !== "") fields.module_id = patch.moduleId.trim();
    if (Number.isFinite(Number(patch.priority))) fields.priority = Math.max(0, Math.min(9, Math.floor(Number(patch.priority))));
    if (Object.keys(fields).length === 0) return { ok: false, reason: "no-recognized-field" };
    fields.updated_at = nowMs();
    write(id, fields);
    return { ok: true, task: get(id) };
  }

  function promptFor(row) {
    const lines = ["【交办 #" + row.id + "】" + row.title];
    if (row.brief !== "") lines.push("要求：" + row.brief);
    if (row.acceptance !== "") lines.push("验收标准：" + row.acceptance);
    lines.push("完成后用 steward_report 回一句话结论（做成了什么 / 没做成卡在哪），不要再问要不要继续。");
    return lines.join("\n");
  }

  /** target -> 会话 id；需要就新开一个。返回 {ok, sessionId, created} 或 {ok:false, reason}。 */
  async function resolveSession(row) {
    const target = row.target;
    if (row.sessionId !== "") return { ok: true, sessionId: row.sessionId, created: false };
    if (target.indexOf("session:") === 0) return { ok: true, sessionId: target.slice(8).trim(), created: false };
    if (target.indexOf("agent:") === 0) {
      const agentId = target.slice(6).trim();
      const rec = store.agents.get(agentId);
      const sessionId = rec === undefined ? "" : String(rec.sessionId === undefined ? "" : rec.sessionId);
      if (sessionId === "") return { ok: false, reason: "agent-has-no-session" };
      return { ok: true, sessionId, created: false };
    }
    if (chat === undefined || typeof chat.create !== "function") return { ok: false, reason: "chat-unavailable" };
    const created = await chat.create({ bootstrap: false });
    if (created === undefined || created.ok !== true) return { ok: false, reason: "create-session-failed: " + String(created === undefined ? "no-result" : created.reason) };
    // 建了就别丢：写回 session_id，重试时复用同一个会话而不是每轮新开一个。
    write(row.id, { session_id: String(created.sessionId), updated_at: nowMs() });
    return { ok: true, sessionId: String(created.sessionId), created: true };
  }

  async function dispatch(id, opts) {
    const g = guard();
    if (g !== undefined) return { ok: false, reason: g.reason };
    const row = get(id);
    if (row === undefined) return { ok: false, reason: "not-found" };
    if (["done", "failed", "cancelled"].indexOf(row.status) >= 0) return { ok: false, reason: "already-closed" };
    const manual = opts !== null && typeof opts === "object" && opts.manual === true;
    if (!manual && policy !== undefined && typeof policy.gate === "function") {
      const verdict = policy.gate("task.dispatch");
      if (verdict.ok !== true) {
        // 只在第一次被拦时留痕：tick 每 5 秒重试一次，重复记账会把 journal 和预算烧穿。
        const mark = "policy-" + verdict.reason;
        if (row.error !== mark) {
          write(id, { error: mark, updated_at: nowMs() });
          store.pushAction({ kind: "task", ok: false, message: "交办 #" + row.id + " 被授权层拦下（需要 " + verdict.needs + "，当前 " + verdict.level + "）" });
        }
        return { ok: false, reason: mark, level: verdict.level, needs: verdict.needs };
      }
    }
    const text = promptFor(row);
    const at0 = nowMs();
    // echo 模式（默认）：只打印拟发送的内容，不建会话、不发消息 —— 预览不该有副作用。
    if (readSettings().actMode !== "live") {
      // 预演不算一次尝试：attempts 不动，才不会被 maxAttempts 误判成用光重试。
      const preview = row.sessionId !== "" ? row.sessionId : (row.target !== "" ? row.target : "（未指定会话，live 时会新开一个）");
      const first = manual || row.result.indexOf("echo：") !== 0;
      write(id, { status: "assigned", assigned_at: at0, updated_at: at0, error: "", result: "echo：动作已生成但未发送（actMode=live 后重派）" });
      if (first) store.pushAction({ kind: "echo", ok: true, message: "交办 #" + row.id + " -> " + preview + "\n" + text });
      return { ok: true, echo: true, sessionId: row.sessionId, task: get(id) };
    }
    const resolved = await resolveSession(row);
    if (resolved.ok !== true) {
      const reason0 = String(resolved.reason);
      const attempts0 = row.attempts + 1;
      const closed0 = attempts0 >= (Number(readSettings().tasks.maxAttempts) || 3);
      write(id, { status: closed0 ? "failed" : "queued", attempts: attempts0, error: reason0, updated_at: nowMs() });
      store.pushAction({ kind: "task", ok: false, message: "交办 #" + row.id + " 派发失败：" + reason0 + (closed0 ? "（已达最大重试次数）" : "") });
      return { ok: false, reason: reason0, attempts: attempts0 };
    }
    const sessionId = resolved.sessionId;
    let sent;
    if (prompter === undefined || typeof prompter.prompt !== "function") sent = { ok: false, reason: "prompter-unavailable" };
    else sent = await prompter.prompt(scope.ctx, {
      sessionId, content: [{ type: "text", text }], mode: "followup",
      requestId: "steward-task-" + row.id + "-" + (row.attempts + 1)
    });
    const ok = sent !== undefined && sent.ok === true;
    const echo = ok && sent.echo === true;
    const attempts = row.attempts + 1;
    const at = nowMs();
    if (echo) {
      write(id, { status: "assigned", session_id: sessionId, assigned_at: at, updated_at: at, error: "", result: "echo：动作已生成但未发送（actMode=live 后重派）" });
      store.pushAction({ kind: "echo", ok: true, message: "交办 #" + row.id + " -> " + sessionId + "\n" + text });
      return { ok: true, echo: true, sessionId, task: get(id) };
    }
    if (!ok) {
      const reason = String(sent === undefined ? "no-result" : sent.reason);
      const maxAttempts = Number(readSettings().tasks.maxAttempts) || 3;
      const failed = attempts >= maxAttempts;
      write(id, { status: failed ? "failed" : "queued", attempts, error: reason, updated_at: at, session_id: sessionId });
      store.pushAction({ kind: "task", ok: false, message: "交办 #" + row.id + " 发送失败：" + reason + (failed ? "（已达最大重试次数）" : "") });
      return { ok: false, reason, attempts, task: get(id) };
    }
    write(id, { status: "running", session_id: sessionId, attempts, assigned_at: at, updated_at: at, error: "", result: "" });
    store.pushAction({ kind: "task", ok: true, message: "交办 #" + row.id + " 已派给 " + sessionId });
    return { ok: true, echo: false, sessionId, task: get(id) };
  }

  function isClosed(row) {
    return row.status === "done" || row.status === "failed" || row.status === "cancelled";
  }

  function complete(id, opts) {
    const row = get(id);
    if (row === undefined) return { ok: false, reason: "not-found" };
    if (isClosed(row)) return { ok: false, reason: "already-closed", task: row };
    const result = textOr(opts !== null && typeof opts === "object" ? opts.result : "", "手动标记完成");
    const at = nowMs();
    write(id, { status: "done", result, done_at: at, updated_at: at });
    store.pushAction({ kind: "task", ok: true, message: "交办 #" + row.id + " 完成：" + result.slice(0, 60) });
    return { ok: true, task: get(id) };
  }

  function fail(id, opts) {
    const row = get(id);
    if (row === undefined) return { ok: false, reason: "not-found" };
    if (isClosed(row)) return { ok: false, reason: "already-closed", task: row };
    const reason = textOr(opts !== null && typeof opts === "object" ? opts.reason : "", "手动标记失败");
    const at = nowMs();
    write(id, { status: "failed", error: reason, done_at: at, updated_at: at });
    store.pushAction({ kind: "task", ok: false, message: "交办 #" + row.id + " 失败：" + reason.slice(0, 60) });
    return { ok: true, task: get(id) };
  }

  function cancel(id) {
    const row = get(id);
    if (row === undefined) return { ok: false, reason: "not-found" };
    if (isClosed(row)) return { ok: false, reason: "already-closed", task: row };
    const at = nowMs();
    write(id, { status: "cancelled", updated_at: at, done_at: at });
    store.pushAction({ kind: "task", ok: true, message: "交办 #" + row.id + " 取消" });
    return { ok: true, task: get(id) };
  }

  /** 会话一轮结束：把该会话上 running 的单一律推进到 review，等主人验收。 */
  function onTurnEnd(sessionId) {
    const id = String(sessionId === undefined || sessionId === null ? "" : sessionId);
    if (id === "") return 0;
    let moved = 0;
    for (const row of activeRows()) {
      if (row.status !== "running") continue;
      if (row.sessionId !== id) continue;
      write(row.id, { status: "review", updated_at: nowMs(), result: "会话已跑完一轮，等待验收" });
      moved += 1;
      store.pushAction({ kind: "task", ok: true, message: "交办 #" + row.id + " 进入待验收" });
    }
    return moved;
  }

  /**
   * 归档（评审 P1-D）：已了结且超过 retainDays 的单子标记 archived，
   * 列表/统计/自动派发都不再看它们，历史仍可用 list({archived:true}) 或 get() 翻出来。
   * 每小时最多跑一次，避免每 5 秒扫全表。
   */
  let lastArchive = 0;
  function archive(opts) {
    const g = guard();
    if (g !== undefined) return { ok: false, reason: g.reason, count: 0 };
    const input = opts !== null && typeof opts === "object" ? opts : {};
    const cfgDays = Number(readSettings().tasks.retainDays);
    const days = Number(input.days) > 0 ? Number(input.days) : (cfgDays > 0 ? cfgDays : 14);
    const cutoff = nowMs() - days * 86_400_000;
    let count = 0;
    for (const row of allRows()) {
      if (row.archived === true) continue;
      if (["done", "failed", "cancelled"].indexOf(row.status) < 0) continue;
      const closedAt = row.doneAt > 0 ? row.doneAt : row.updatedAt;
      if (closedAt > cutoff) continue;
      write(row.id, { archived: 1, updated_at: nowMs() });
      count += 1;
    }
    if (count > 0) store.pushAction({ kind: "task", charge: false, message: "归档 " + count + " 张旧交办单（保留 " + days + " 天）" });
    return { ok: true, count, days };
  }

  /** 自动派发：每个 tick 最多补满 concurrency 个槽位。 */
  async function tick() {
    const g = guard();
    if (g !== undefined) return 0;
    const stamp = nowMs();
    if (stamp - lastArchive > 3_600_000) {
      lastArchive = stamp;
      try { archive({}); } catch (error) { log("debug", "steward: task archive failed: " + String(error)); }
    }
    const cfg = readSettings().tasks;
    if (cfg.autoDispatch !== true || Number(cfg.concurrency) <= 0) return 0;
    const rows = activeRows();
    // 只有真派出去的（running）占槽；echo 预演的 assigned 不算，否则一单预览就把并发槽锁死。
    const running = rows.filter((row) => row.status === "running").length;
    let slots = Number(cfg.concurrency) - running;
    if (slots <= 0) return 0;
    const queued = rows.filter((row) => row.status === "queued").sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.id - b.id;
    });
    let started = 0;
    for (const row of queued) {
      if (slots <= 0) break;
      const res = await dispatch(row.id, { manual: false });
      if (res.ok === true) { started += 1; if (res.echo !== true) slots -= 1; }
      else if (res.reason !== undefined && String(res.reason).indexOf("policy-") === 0) break;
    }
    return started;
  }

  return { list, get, create, update, dispatch, complete, fail, cancel, onTurnEnd, tick, archive, activeRows, summary, promptFor, STATUSES };
}

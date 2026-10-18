/**
 * 审批台账：请示的唯一真相。
 *
 * 关键约束（design 10.4）：
 * - 一个审批只有一个答案；并发的第二次答复必须被"版本 CAS"挡住，返回 stale，
 *   而不是覆盖——联邦下两个端同时点“同意/拒绝”是真实会发生的事。
 * - 审批不会被丢弃：过期只改状态，行永远保留，便于复盘。
 *
 * 存储列沿用 schema.js 的 approvals 表（title/options_json/status/answer_json/
 * deadline/version），业务字段 detail/subject/moduleId/level 放进 options_json，
 * 答复与答复人放进 answer_json。对外统一返回拍平后的视图对象。
 */
export function createApprovalStore(options) {
  const o = options === undefined ? {} : options;
  const db = o.db;
  const clock = typeof o.clock === "function" ? o.clock : () => Date.now();
  const log = typeof o.log === "function" ? o.log : () => {};

  function now() { return Number(clock()); }

  function decode(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "object") return value;
    try { return JSON.parse(String(value)); } catch { return null; }
  }

  function view(row) {
    if (row === undefined || row === null) return null;
    const options = decode(row.options_json) === null ? {} : decode(row.options_json);
    const answer = decode(row.answer_json);
    return {
      id: row.id,
      title: row.title,
      detail: options.detail === undefined ? "" : options.detail,
      subject: options.subject === undefined ? null : options.subject,
      moduleId: options.moduleId === undefined ? null : options.moduleId,
      level: options.level === undefined ? "warning" : options.level,
      status: row.status,
      answer: answer === null ? null : answer.answer,
      answerBy: answer === null ? null : answer.by,
      deadline: Number(row.deadline),
      version: Number(row.version),
      createdAt: Number(row.created_at)
    };
  }

  function get(id) {
    return view(db.get("approvals", id));
  }

  function create(input) {
    const at = now();
    const id = db.insert("approvals", {
      title: String(input.title === undefined ? "请示" : input.title),
      options_json: {
        detail: String(input.detail === undefined ? "" : input.detail),
        subject: input.subject === undefined ? null : String(input.subject),
        moduleId: input.moduleId === undefined ? null : String(input.moduleId),
        level: input.level === undefined ? "warning" : String(input.level)
      },
      default_option: null,
      status: "open",
      answer_json: null,
      deadline: at + Number(input.ttlMs === undefined ? 1_800_000 : input.ttlMs),
      version: 1,
      created_at: at
    });
    return get(id);
  }

  function listOpen() {
    return db.find("approvals", (row) => row.status === "open").map(view);
  }

  /** 回答：版本 CAS。返回 { ok, approval } 或 { ok:false, reason:"stale"|"not-open"|"not-found" }。 */
  function answer(id, answerValue, by, expectedVersion) {
    const current = db.get("approvals", id);
    if (current === undefined) return { ok: false, reason: "not-found" };
    if (current.status !== "open") return { ok: false, reason: "not-open", approval: view(current) };
    if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== Number(current.version)) {
      return { ok: false, reason: "stale", approval: view(current) };
    }
    db.update("approvals", id, {
      status: String(answerValue) === "approve" ? "approved" : "rejected",
      answer_json: { answer: String(answerValue), by: by === undefined ? null : String(by) },
      version: Number(current.version) + 1
    });
    return { ok: true, approval: get(id) };
  }

  function expire(id) {
    const current = db.get("approvals", id);
    if (current === undefined || current.status !== "open") return { ok: false, reason: "not-open" };
    db.update("approvals", id, { status: "expired", version: Number(current.version) + 1 });
    return { ok: true, approval: get(id) };
  }

  /** 到点未答的统一作废，返回作废数量。 */
  function sweep() {
    const at = now();
    let n = 0;
    for (const row of listOpen()) {
      if (Number(row.deadline) > 0 && at >= Number(row.deadline)) {
        try { expire(row.id); n += 1; } catch (error) { log("warn", "approval expire failed: " + String(error)); }
      }
    }
    return n;
  }

  return { create, get, listOpen, answer, expire, sweep };
}

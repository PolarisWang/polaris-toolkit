/**
 * 数据模型：与 docs/steward-design.md 5.1 的 12 张表一一对应。
 *
 * 列类型只有两种：INTEGER（数值）与 TEXT（其余；对象/数组在 SQLite 后端里
 * 以 JSON 文本存放，读回时还原）。复合主键用数组表示（steps 表）。
 */
export const TABLES = {
  hosts: {
    pk: "peer_id",
    ints: ["epoch", "last_seen"],
    cols: ["peer_id", "name", "kind", "epoch", "last_seen", "rules_hash", "version", "model"]
  },
  modules: {
    pk: "id",
    ints: ["epoch", "updated_at"],
    cols: ["id", "name", "host_id", "status", "policy_json", "budget_json", "session_id", "epoch", "updated_at"]
  },
  subjects: {
    pk: "id",
    ints: ["owner_at", "pinned", "confidence"],
    cols: ["id", "kind", "host_id", "module_id", "owner_at", "pinned", "reason", "confidence"]
  },
  signals: {
    pk: "id",
    auto: true,
    ints: ["id", "at", "severity_num"],
    cols: ["id", "host_id", "kind", "subject", "severity", "payload_json", "at", "consumed_by", "severity_num"]
  },
  routing: {
    pk: "id",
    auto: true,
    ints: ["id", "at", "confidence"],
    cols: ["id", "subject", "module_id", "reason", "decided_by", "confidence", "at"]
  },
  runs: {
    pk: "id",
    ints: ["wake_at", "deadline", "lease_until", "shadow", "created_at", "updated_at"],
    cols: ["id", "wf", "wf_version", "trace_id", "host_id", "module_id", "subject", "status", "vars_json", "current_step", "wake_at", "deadline", "lease_until", "shadow", "error", "created_at", "updated_at", "attempts", "lease_owner"]
  },
  steps: {
    pk: ["run_id", "step_id", "attempt"],
    ints: ["attempt", "intent_at", "done_at"],
    cols: ["run_id", "step_id", "kind", "attempt", "status", "intent_at", "done_at", "input_json", "output_json", "idem_key"]
  },
  timers: {
    pk: "id",
    ints: ["fire_at"],
    cols: ["id", "run_id", "step_id", "fire_at", "kind", "payload_json"]
  },
  actions: {
    pk: "id",
    auto: true,
    ints: ["id", "at", "level"],
    cols: ["id", "idem_key", "run_id", "step_id", "host_id", "kind", "target", "payload_json", "level", "result", "error", "at"]
  },
  approvals: {
    pk: "id",
    auto: true,
    ints: ["id", "deadline", "version", "created_at"],
    cols: ["id", "run_id", "step_id", "host_id", "title", "options_json", "default_option", "deadline", "status", "answer_json", "version", "created_at"]
  },
  dlq: {
    pk: "id",
    auto: true,
    ints: ["id", "at", "resolved"],
    cols: ["id", "run_id", "step_id", "reason", "payload_json", "at", "resolved"]
  },
  tasks: {
    pk: "id",
    auto: true,
    ints: ["id", "priority", "attempts", "created_at", "updated_at", "assigned_at", "done_at", "archived"],
    cols: ["id", "title", "brief", "acceptance", "status", "target", "session_id", "module_id", "origin", "priority",
      "result", "attempts", "error", "created_at", "updated_at", "assigned_at", "done_at", "archived"]
  },
  settings_history: {
    pk: "rev",
    auto: true,
    ints: ["rev", "at"],
    cols: ["rev", "at", "body_json", "actor"]
  },
  // 能力平面 §6：可观测性四表。intents 记录每一次意图（含被拒与预演），
  // traces/spans/effects 是它的执行树与对外副作用。
  intents: {
    pk: "id",
    auto: true,
    ints: ["id", "at", "ok", "preview"],
    cols: ["id", "trace_id", "span_id", "steward_id", "cap", "carrier", "payload", "target",
      "protocol", "route", "grant", "decision", "reason", "ok", "preview", "at", "ext_id"],
    indexes: ["trace_id", "steward_id", "at"]
  },
  traces: {
    pk: "id",
    ints: ["started_at", "ms", "span_count", "ok"],
    cols: ["id", "trigger", "steward_id", "subject", "status", "started_at", "ms", "span_count", "ok", "error"],
    indexes: ["started_at", "steward_id"]
  },
  spans: {
    pk: "id",
    ints: ["started_at", "ms", "seq"],
    cols: ["id", "trace_id", "parent_id", "kind", "ref", "status", "started_at", "ms", "seq", "attrs_json"],
    indexes: ["trace_id"]
  },
  effects: {
    pk: "id",
    auto: true,
    ints: ["id", "ms", "ok", "attempt"],
    cols: ["id", "trace_id", "span_id", "cap", "params_json", "ext_id", "ok", "error_code", "ms", "attempt"],
    indexes: ["trace_id", "ext_id"]
  }
};

export const TABLE_NAMES = Object.keys(TABLES);

export function isIntColumn(table, col) {
  const spec = TABLES[table];
  return spec !== undefined && spec.ints.indexOf(col) >= 0;
}

export function pkOf(table) {
  const spec = TABLES[table];
  if (spec === undefined) throw new Error("unknown table: " + table);
  return Array.isArray(spec.pk) ? spec.pk.slice() : [spec.pk];
}
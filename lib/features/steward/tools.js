/**
 * Steward agent 工具（评审 P1-B）：把能力平面 / 交办 / 编制 / 对话 / 追查
 * 变成 agent 在会话里能直接调的 5 个工具。
 *
 * 免令牌：工具走宿主 tool 注册表，不经过 /__polaris 的 HTTP 令牌闸门 ——
 * 能调到这些工具就说明调用方已经在宿主的会话上下文里了。
 * 全部只读或走已有的写路径（tasks / chat / plane.saveSteward），不自己动会话。
 */
function textOut() {
  return {
    schema: { type: "object", additionalProperties: true, properties: { text: { type: "string" } } },
    render: (_args, value) => [{ type: "text", text: value !== null && typeof value === "object" && typeof value.text === "string" ? value.text : String(value) }]
  };
}

function clampInt(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}

function stamp(at) {
  const n = Number(at);
  if (!Number.isFinite(n) || n <= 0) return "-";
  return new Date(n).toISOString().slice(11, 19);
}

export function mountTools(scope, S) {
  const src = S === undefined || S === null ? {} : S;
  const plane = src.plane;
  const tasks = src.tasks;
  const chat = src.chat;
  const store = src.store;
  const readSettings = typeof src.readSettings === "function" ? src.readSettings : function () { return {}; };

  function traceLine(t) {
    return "  " + String(t.id) + "  " + stamp(t.startedAt) + "  " + String(t.trigger) + "  steward " + String(t.stewardId) + "  " + String(t.subject) + "  " + String(t.status) + "  spans " + String(t.spanCount) + "  " + String(t.ms) + "ms";
  }

  scope.tool({
    name: "steward_trace",
    description: "Read the steward capability plane's decision traces (P1): list recent traces, or pass id to get the full waterfall (spans + intents + effects) for one trigger. Use replay:true to re-run a trace against its recorded facts without executing any capability, diff:<other id> to compare two traces of the same subject, and since:<id> for incremental polling.",
    parameters: {
      id: { type: "string", description: "trace id such as t-3; when given, return that trace's waterfall" },
      limit: { type: "number", description: "how many traces (default 10, max 200)" },
      since: { type: "string", description: "only traces with an id after this one (incremental)" },
      steward: { type: "string", description: "filter by steward id" },
      subject: { type: "string", description: "filter by subject (host, session:<id>, ...)" },
      trigger: { type: "string", description: "filter by trigger event (host/tick, agent/error, ...)" },
      status: { type: "string", description: "filter by status: ok | error | skipped" },
      replay: { type: "boolean", description: "replay the trace with its recorded facts, executing nothing" },
      diff: { type: "string", description: "another trace id to diff against (same subject)" }
    },
    output: textOut(),
    execute: async (args) => {
      if (plane === undefined) return { text: "steward_trace  plane-unavailable" };
      const a = args !== null && typeof args === "object" ? args : {};
      const id = a.id === undefined ? "" : String(a.id).trim();
      if (id !== "") {
        if (a.replay === true) {
          const r = plane.replayTrace(id);
          if (r === undefined || r.ok !== true) return { text: "steward_trace replay failed: " + String(r !== undefined && r.reason !== undefined ? r.reason : "no such trace " + id) };
          const w = r.waterfall !== undefined ? r.waterfall : plane.trace.waterfall(id);
          const lines = ["steward_trace replay " + id + "  (没有执行任何能力)"];
          if (w !== undefined) { for (const i of w.intents) lines.push("  intent " + String(i.cap) + "  " + String(i.payload) + "  decision " + String(i.decision) + (i.reason === undefined || i.reason === "" ? "" : "  reason " + String(i.reason))); }
          return { text: lines.join("\n") };
        }
        const against = a.diff === undefined ? "" : String(a.diff).trim();
        if (against !== "") {
          const d = plane.diffTraces(id, against);
          if (d === undefined) return { text: "steward_trace diff failed: " + (plane.trace.get(id) === undefined ? "no such trace " + id : "no such trace " + against) };
          return { text: "steward_trace diff  " + String(d.id) + " vs " + String(d.against) + "  changed " + String(d.changed) + "\n  added " + (d.added.length === 0 ? "none" : d.added.join(", ")) + "\n  removed " + (d.removed.length === 0 ? "none" : d.removed.join(", ")) };
        }
        const w = plane.trace.waterfall(id);
        if (w === undefined) return { text: "steward_trace: no such trace " + id };
        const t = w.trace;
        const lines = [traceLine(t)];
        for (const s of w.spans) lines.push("  span " + String(s.id) + "  " + String(s.kind) + "  " + String(s.ref) + "  " + String(s.status) + "  " + String(s.ms) + "ms" + (s.attrs !== undefined && Object.keys(s.attrs).length > 0 ? "  " + JSON.stringify(s.attrs) : ""));
        for (const i of w.intents) lines.push("  intent " + String(i.cap) + "  " + String(i.payload) + "/" + String(i.carrier) + "  target " + String(i.target) + "  decision " + String(i.decision) + "  " + (i.preview === true ? "preview " : "") + (i.reason === undefined || i.reason === "" ? "" : "reason " + String(i.reason)));
        for (const e of w.effects) lines.push("  effect " + String(e.cap) + "  " + (e.ok === true ? "ok" : "FAILED " + String(e.errorCode)) + "  " + String(e.ms) + "ms" + (e.extId === undefined || e.extId === "" ? "" : "  ext " + String(e.extId)));
        return { text: lines.join("\n") };
      }
      const traces = plane.trace.list({ limit: clampInt(a.limit, 10, 200), since: a.since, stewardId: a.steward, subject: a.subject, trigger: a.trigger, status: a.status });
      const stats = plane.trace.stats();
      const lines = ["steward_trace  traces " + String(stats.traces) + "  effects " + String(stats.effects) + "  showing " + String(traces.length)];
      if (traces.length === 0) lines.push("  (没有 trace —— 编制没订阅任何事件，或者还没到 tick)");
      for (const t of traces) lines.push(traceLine(t));
      return { text: lines.join("\n") };
    }
  });

  scope.tool({
    name: "steward_audit",
    description: "Audit every capability intent the steward attempted: who wanted to do what to whom, whether it executed, previewed or was denied, and why. This is the fastest way to answer 'why did (or didn't) the steward act'. Read-only.",
    parameters: {
      limit: { type: "number", description: "how many rows (default 40, max 500)" },
      decision: { type: "string", description: "filter by decision: act | dry-run | denied | noop" },
      cap: { type: "string", description: "filter by capability id" },
      steward: { type: "string", description: "filter by steward id" },
      since: { type: "string", description: "only intents after this id (incremental)" }
    },
    output: textOut(),
    execute: async (args) => {
      if (plane === undefined) return { text: "steward_audit  plane-unavailable" };
      const a = args !== null && typeof args === "object" ? args : {};
      const out = plane.audit({ limit: clampInt(a.limit, 40, 500), decision: a.decision, cap: a.cap, steward: a.steward, since: a.since });
      const counts = {};
      for (const row of out.rows) { const key = row.decision === undefined || row.decision === "" ? "unknown" : String(row.decision); counts[key] = (counts[key] || 0) + 1; }
      const summary = Object.keys(counts).map((k) => k + " " + String(counts[k])).join("  ");
      const lines = ["steward_audit  rows " + String(out.rows.length) + "  latest " + String(out.latest) + "  " + summary];
      for (const row of out.rows) {
        lines.push("  " + stamp(row.at) + "  " + String(row.stewardId) + "  " + String(row.cap) + " -> " + String(row.target) + "  " + String(row.decision) + (row.preview === true ? " (preview)" : "") + "  trace " + String(row.traceId) + (row.reason === undefined || row.reason === "" ? "" : "  reason " + String(row.reason)) + (row.extId === undefined || row.extId === "" ? "" : "  ext " + String(row.extId)));
      }
      return { text: lines.join("\n") };
    }
  });

  scope.tool({
    name: "steward_tasks",
    description: "Hand work to the fleet and follow it: create a task (title + brief + acceptance criteria, target a session:<id> or leave empty to open a new one), dispatch it now, or list/complete/fail/cancel/archive tasks. Task lifecycle: queued -> assigned -> running -> review -> done/failed. Auto-dispatch happens on the steward tick when tasks.autoDispatch is on.",
    parameters: {
      op: { type: "string", description: "list | create | dispatch | complete | fail | cancel | archive (default list)" },
      id: { type: "number", description: "task id for dispatch/complete/fail/cancel" },
      title: { type: "string", description: "create: short task title" },
      brief: { type: "string", description: "create: what to do" },
      acceptance: { type: "string", description: "create: how the result will be judged" },
      target: { type: "string", description: "create: session:<sessionId>, or empty to open a new session" },
      result: { type: "string", description: "complete: what was delivered" },
      reason: { type: "string", description: "fail: why it failed" },
      status: { type: "string", description: "list: filter by status" },
      archived: { type: "boolean", description: "list: show archived tasks instead" },
      days: { type: "number", description: "archive: retention days (default from settings.tasks.retainDays)" },
      limit: { type: "number", description: "list: how many (default 20, max 200)" }
    },
    output: textOut(),
    execute: async (args) => {
      if (tasks === undefined) return { text: "steward_tasks  tasks-unavailable" };
      const a = args !== null && typeof args === "object" ? args : {};
      const op = a.op === undefined || a.op === null ? "list" : String(a.op);
      if (op === "create") {
        const out = tasks.create({ title: a.title, brief: a.brief, acceptance: a.acceptance, target: a.target, origin: "agent" });
        return { text: out.ok === true ? "steward_tasks created #" + String(out.task.id) + "  " + String(out.task.title) + "  status " + String(out.task.status) : "steward_tasks create failed: " + String(out.reason) };
      }
      if (op === "dispatch") {
        const out = await tasks.dispatch(a.id, { manual: true });
        return { text: out.ok === true ? "steward_tasks dispatched #" + String(a.id) + (out.echo === true ? " (echo 预演)" : " -> " + String(out.sessionId)) : "steward_tasks dispatch failed: " + String(out.reason) };
      }
      if (op === "complete") {
        const out = tasks.complete(a.id, { result: a.result });
        return { text: out.ok === true ? "steward_tasks completed #" + String(a.id) : "steward_tasks complete failed: " + String(out.reason) };
      }
      if (op === "fail") {
        const out = tasks.fail(a.id, { reason: a.reason });
        return { text: out.ok === true ? "steward_tasks failed #" + String(a.id) : "steward_tasks fail failed: " + String(out.reason) };
      }
      if (op === "cancel") {
        const out = tasks.cancel(a.id);
        return { text: out.ok === true ? "steward_tasks cancelled #" + String(a.id) : "steward_tasks cancel failed: " + String(out.reason) };
      }
      if (op === "archive") {
        const out = tasks.archive({ days: a.days });
        return { text: "steward_tasks archived " + String(out.count) + " (retain " + String(out.days) + " days)" };
      }
      const rows = tasks.list({ status: a.status, archived: a.archived === true, limit: clampInt(a.limit, 20, 200) });
      const summary = tasks.summary();
      const lines = ["steward_tasks  total " + String(summary.total) + "  open " + String(summary.open) + "  running " + String(summary.running) + "  queued " + String(summary.queued) + "  review " + String(summary.review)];
      for (const row of rows) lines.push("  #" + String(row.id) + "  " + String(row.status) + "  " + String(row.title) + (row.target === "" ? "" : "  target " + String(row.target)) + "  attempts " + String(row.attempts) + (row.archived === true ? "  (archived)" : "") + (row.result === "" ? "" : "  result " + String(row.result).slice(0, 60)));
      return { text: lines.join("\n") };
    }
  });

  scope.tool({
    name: "steward_stewards",
    description: "Inspect and edit the stewards: a steward is a data record that joins a set of equipped capabilities with its own decision tree. Use op:list to see who exists, what they are equipped with and which events they subscribe to; op:save/enable/delete/reset to change settings.plane.stewards. The capability instances themselves come from the catalogue.",
    parameters: {
      op: { type: "string", description: "list | save | enable | add | delete | reset (default list)" },
      id: { type: "string", description: "steward id, e.g. watch" },
      enabled: { type: "boolean", description: "enable: true/false" },
      steward: { type: "object", additionalProperties: true, description: "save: the steward record (name, equips, events, tree, grants, voice, ...)" },
      events: { type: "array", description: "save: shorthand for the subscribed events, e.g. [\"host/tick\"]" }
    },
    output: textOut(),
    execute: async (args) => {
      if (plane === undefined) return { text: "steward_stewards  plane-unavailable" };
      const a = args !== null && typeof args === "object" ? args : {};
      const op = a.op === undefined || a.op === null ? "list" : String(a.op);
      if (op !== "list") {
        const payload = {};
        for (const key of Object.keys(a)) payload[key] = a[key];
        if (payload.steward === undefined && (payload.name !== undefined || payload.equips !== undefined || payload.events !== undefined || payload.tree !== undefined)) {
          payload.steward = { name: a.name, equips: a.equips, events: a.events, tree: a.tree, voice: a.voice, grants: a.grants, scope: a.scope };
        }
        const out = plane.saveSteward(op, payload);
        if (out.ok !== true) return { text: "steward_stewards " + op + " failed: " + String(out.error !== undefined ? out.error : out.reason) };
        const list = out.stewards === undefined ? plane.describe().stewards : out.stewards;
        return { text: "steward_stewards " + op + " ok  stewards " + String(list.length) + "\n" + list.map((s) => "  " + String(s.id) + "  " + (s.enabled === false ? "off" : "on") + "  " + String(s.name)).join("\n") };
      }
      const list = plane.describe().stewards;
      const lines = ["steward_stewards  count " + String(list.length) + "  capabilities " + String(plane.describe().count) + "  hash " + String(plane.describe().hash)];
      for (const s of list) {
        lines.push("  " + String(s.id) + "  " + (s.enabled === false ? "off" : "on") + "  " + String(s.name) + "  equips " + String((s.equips || []).length) + "  events " + ((s.events || []).length === 0 ? "all" : (s.events || []).join(",")) + "  voice " + String(s.voice !== undefined && s.voice !== null ? s.voice.mode : "-"));
        lines.push("    equips: " + (s.equips || []).join(", "));
      }
      return { text: lines.join("\n") };
    }
  });

  scope.tool({
    name: "steward_chat",
    description: "Talk to the steward's own session (the ops console). status shows whether a session is bound; send pushes a message into it as a followup (and records the transcript); create opens a new steward session with the configured preset; bind attaches an existing session id; unbind detaches. Use this to give the steward an instruction in its own words, not a task record.",
    parameters: {
      op: { type: "string", description: "status | send | create | bind | unbind (default status)" },
      text: { type: "string", description: "send: the message" },
      mode: { type: "string", description: "send: steer (interrupt) | followup (default)" },
      sessionId: { type: "string", description: "bind: existing session id" },
      cwd: { type: "string", description: "create: working directory for the new steward session" },
      title: { type: "string", description: "create: session title" }
    },
    output: textOut(),
    execute: async (args) => {
      if (chat === undefined) return { text: "steward_chat  chat-unavailable" };
      const a = args !== null && typeof args === "object" ? args : {};
      const op = a.op === undefined || a.op === null ? "status" : String(a.op);
      if (op === "send") {
        const out = await chat.send({ text: a.text, mode: a.mode });
        return { text: out.ok === true ? "steward_chat sent -> " + String(out.sessionId) + " (" + String(out.mode) + ")" : "steward_chat send failed: " + String(out.reason) };
      }
      if (op === "create") {
        const out = await chat.create({ cwd: a.cwd, title: a.title });
        return { text: out.ok === true ? "steward_chat created " + String(out.sessionId) + " @ " + String(out.cwd) + "  " + String(out.title) : "steward_chat create failed: " + String(out.reason) };
      }
      if (op === "bind") {
        const out = chat.bind(a.sessionId);
        return { text: out.ok === true ? "steward_chat bound " + String(out.sessionId) : "steward_chat bind failed: " + String(out.reason) };
      }
      if (op === "unbind") {
        const out = chat.unbind();
        return { text: out.ok === true ? "steward_chat unbound" : "steward_chat unbind failed: " + String(out.reason) };
      }
      const st = chat.state();
      const cfg = readSettings();
      const bound = st.sessionId === undefined || st.sessionId === "" ? "未绑定" : String(st.sessionId);
      return { text: "steward_chat  bound " + bound + "  preset " + String(cfg.session !== undefined ? cfg.session.preset : "-") + "  actMode " + String(cfg.actMode) + "  entries " + String((st.entries || []).length) + (store === undefined ? "" : "  chat actions " + String(store.snapshot().actions.filter((x) => x.kind === "chat").length)) };
    }
  });

  scope.tool({
    name: "steward_settings",
    description: "Read and write the toolkit settings that control the steward (P1-A). op=get returns the effective settings of one feature (default steward), op=set applies a nested patch after schema validation, op=raw returns the whole settings.json envelope, op=replace writes a whole document back (text = JSON string, or pass doc). Config lives in ~/.dsh/polaris-toolkit/settings.json and takes effect immediately.",
    parameters: {
      op: { type: "string", description: "get | set | raw | replace (default get)" },
      feature: { type: "string", description: "feature id for get/set (default steward)" },
      patch: { type: "object", additionalProperties: true, description: "set: nested patch, e.g. { actLevel: \"L3\", tasks: { autoDispatch: false } }" },
      text: { type: "string", description: "replace: the whole document as JSON text" },
      doc: { type: "object", additionalProperties: true, description: "replace: the whole document as an object (alternative to text)" }
    },
    output: textOut(),
    execute: async (args) => {
      const core = scope.core === undefined || scope.core === null ? {} : scope.core;
      const a = args !== null && typeof args === "object" ? args : {};
      const op = a.op === undefined || a.op === null ? "get" : String(a.op);
      if (op === "raw") return { text: JSON.stringify(core.settingsRaw === undefined ? {} : core.settingsRaw(), null, 2) };
      if (op === "replace") {
        let doc = a.doc;
        if (typeof a.text === "string" && a.text.trim() !== "") {
          try { doc = JSON.parse(a.text); } catch (error) { return { text: "steward_settings replace  invalid JSON: " + String(error.message || error) }; }
        }
        if (doc === undefined || doc === null) return { text: "steward_settings replace  need text or doc" };
        const out = core.settingsReplace === undefined ? { ok: false, error: "settings-control-unavailable" } : core.settingsReplace(doc);
        if (out.ok !== true) return { text: "steward_settings replace refused  " + (out.feature === undefined ? "" : out.feature + " ") + String(out.error) };
        return { text: "steward_settings replaced whole document  " + String(out.file === undefined ? "" : out.file) };
      }
      const feature = a.feature === undefined || a.feature === null || String(a.feature).trim() === "" ? "steward" : String(a.feature).trim();
      if (op === "set") {
        const patch = a.patch !== null && typeof a.patch === "object" && !Array.isArray(a.patch) ? a.patch : {};
        const out = core.settingsPatch === undefined ? { ok: false, error: "settings-control-unavailable" } : core.settingsPatch(feature, patch);
        if (out.ok !== true) return { text: "steward_settings set refused  " + (out.feature === undefined ? feature : out.feature) + "  " + String(out.error) };
        return { text: "steward_settings set  " + String(out.feature) + "\n" + JSON.stringify(out.value, null, 2) };
      }
      if (feature === scope.id) return { text: "steward_settings  " + feature + "\n" + JSON.stringify(scope.settings.all(), null, 2) };
      const raw = core.settingsRaw === undefined ? { doc: { v: 1, d: {} } } : core.settingsRaw();
      const slice = raw.doc !== undefined && raw.doc.d !== undefined ? raw.doc.d[feature] : undefined;
      return { text: "steward_settings  " + feature + "\n" + JSON.stringify(slice === undefined ? {} : slice, null, 2) };
    }
  });
}

export default { mountTools };

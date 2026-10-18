/**
 * Trace 存储（能力平面 §6）：一次触发 = 一条 trace，链上是 span，
 * 对外副作用是 effect，被拒绝或预演的意图是 intent。
 *
 * 与 OpenTelemetry 对齐的最小字段集：trace.id / span.parentId / span.kind /
 * span.attrs / span.ms；effect.extId 记住外部回执（飞书 message_id、DSH
 * requestId、task id、doc block），追查页靠它反查。
 *
 * 内存保留最近 maxMemory 条完整 trace 供面板实时读，同时全量落 db（注入的
 * 表 API）；没有 db 时退化成纯内存，接口不变。
 */
const DEFAULT_KEEP = 200;

function clockMs(clock) {
  try {
    const t = Number(clock());
    return Number.isFinite(t) ? t : Date.now();
  } catch {
    return Date.now();
  }
}

function idNum(id) {
  const s = String(id === undefined || id === null ? "" : id);
  const cut = s.lastIndexOf("-");
  const n = Number(s.slice(cut + 1));
  return Number.isFinite(n) ? n : 0;
}

function summaryOf(rec) {
  return {
    id: rec.id,
    trigger: rec.trigger,
    stewardId: rec.stewardId,
    subject: rec.subject,
    status: rec.status,
    startedAt: rec.startedAt,
    ms: rec.ms,
    spanCount: rec.spanCount,
    ok: rec.ok,
    error: rec.error
  };
}

export function createTraceStore(options) {
  const opts = options === undefined ? {} : options;
  const db = opts.db === undefined || opts.db === null ? undefined : opts.db;
  const clock = typeof opts.clock === "function" ? opts.clock : Date.now;
  const log = typeof opts.log === "function" ? opts.log : function () {};
  const keep = Number(opts.maxMemory) > 0 ? Math.floor(Number(opts.maxMemory)) : DEFAULT_KEEP;
  const live = new Map();
  const order = [];
  const effects = new Map();
  const counters = { traces: 0, spans: 0, effects: 0, intents: 0, persisted: 0, persistFailed: 0 };
  let seq = 0;
  let spanSeq = 0;
  let effectSeq = 0;
  let intentSeq = 0;

  function safe(fn) {
    if (db === undefined) return undefined;
    try {
      const out = fn();
      counters.persisted += 1;
      return out;
    } catch (error) {
      counters.persistFailed += 1;
      log("warn", "trace persist failed: " + String(error));
      return undefined;
    }
  }

  function saveTrace(rec) {
    safe(function () {
      return db.insert("traces", {
        id: rec.id,
        trigger: rec.trigger,
        steward_id: rec.stewardId,
        subject: rec.subject,
        status: rec.status,
        started_at: rec.startedAt,
        ms: rec.ms,
        span_count: rec.spanCount,
        ok: rec.ok ? 1 : 0,
        error: rec.error === "" ? null : rec.error
      });
    });
  }

  function saveSpan(span) {
    safe(function () {
      return db.insert("spans", {
        id: span.id,
        trace_id: span.traceId,
        parent_id: span.parentId,
        kind: span.kind,
        ref: span.ref,
        status: span.status,
        started_at: span.startedAt,
        ms: span.ms,
        seq: span.seq,
        attrs_json: span.attrs
      });
    });
  }

  function saveEffect(effect) {
    safe(function () {
      return db.insert("effects", {
        trace_id: effect.traceId,
        span_id: effect.spanId,
        cap: effect.cap,
        params_json: effect.params,
        ext_id: effect.extId,
        ok: effect.ok ? 1 : 0,
        error_code: effect.errorCode === "" ? null : effect.errorCode,
        ms: effect.ms,
        attempt: effect.attempt
      });
    });
  }

  function saveIntent(intent) {
    safe(function () {
      return db.insert("intents", {
        trace_id: intent.traceId,
        span_id: intent.spanId,
        steward_id: intent.stewardId,
        cap: intent.cap,
        carrier: intent.carrier,
        payload: intent.payload,
        target: intent.target,
        protocol: intent.protocol,
        route: intent.route,
        grant: intent.grant,
        decision: intent.decision,
        reason: intent.reason,
        ok: intent.ok ? 1 : 0,
        preview: intent.preview ? 1 : 0,
        at: intent.at,
        ext_id: intent.extId
      });
    });
  }

  function bucket(traceId) {
    if (!effects.has(traceId)) effects.set(traceId, []);
    return effects.get(traceId);
  }

  function attach(rec) {
    rec.span = function (input) { return addSpan(rec, input); };
    rec.effect = function (spanId, input) { return addEffect(rec, spanId, input); };
    rec.intent = function (input) { return addIntent(rec, input); };
    rec.finish = function (status, error) { return finish(rec, status, error); };
    return rec;
  }

  function addSpan(rec, input) {
    const src = input === undefined ? {} : input;
    const span = {
      id: "s-" + (++spanSeq),
      traceId: rec.id,
      parentId: src.parent === undefined ? "" : String(src.parent),
      kind: String(src.kind === undefined ? "step" : src.kind),
      ref: String(src.ref === undefined ? "" : src.ref),
      status: "running",
      startedAt: src.at === undefined ? clockMs(clock) : Number(src.at),
      ms: 0,
      seq: rec.spans.length,
      attrs: src.attrs !== null && typeof src.attrs === "object" ? src.attrs : {}
    };
    span.end = function (status, ms, attrs) {
      span.status = status === undefined || status === null ? "ok" : String(status);
      span.ms = Number.isFinite(Number(ms)) ? Number(ms) : Math.max(0, clockMs(clock) - span.startedAt);
      if (attrs !== null && typeof attrs === "object") span.attrs = Object.assign({}, span.attrs, attrs);
      saveSpan(span);
      return span;
    };
    rec.spans.push(span);
    counters.spans += 1;
    saveSpan(span);
    return span;
  }

  function addEffect(rec, spanId, input) {
    const src = input === undefined ? {} : input;
    const effect = {
      id: "e-" + (++effectSeq),
      traceId: rec.id,
      spanId: spanId === undefined || spanId === null ? "" : String(spanId),
      cap: String(src.cap === undefined ? "" : src.cap),
      params: src.params === undefined ? {} : src.params,
      extId: String(src.extId === undefined ? "" : src.extId),
      ok: src.ok !== false,
      errorCode: src.errorCode === undefined ? "" : String(src.errorCode),
      ms: Number(src.ms) > 0 ? Math.floor(Number(src.ms)) : 0,
      attempt: Number(src.attempt) > 0 ? Math.floor(Number(src.attempt)) : 1
    };
    bucket(rec.id).push(effect);
    counters.effects += 1;
    saveEffect(effect);
    return effect;
  }

  function addIntent(rec, input) {
    const src = input === undefined ? {} : input;
    const intent = {
      id: "i-" + (++intentSeq),
      traceId: rec.id,
      spanId: src.spanId === undefined ? "" : String(src.spanId),
      stewardId: src.stewardId === undefined ? rec.stewardId : String(src.stewardId),
      cap: String(src.cap === undefined ? "" : src.cap),
      carrier: String(src.carrier === undefined ? "" : src.carrier),
      payload: String(src.payload === undefined ? "" : src.payload),
      target: String(src.target === undefined ? "" : src.target),
      protocol: String(src.protocol === undefined ? "fire" : src.protocol),
      route: String(src.route === undefined ? "" : src.route),
      grant: String(src.grant === undefined ? "" : src.grant),
      decision: String(src.decision === undefined ? "" : src.decision),
      reason: String(src.reason === undefined ? "" : src.reason),
      ok: src.ok !== false,
      preview: src.preview === true,
      at: src.at === undefined ? clockMs(clock) : Number(src.at),
      extId: String(src.extId === undefined ? "" : src.extId)
    };
    rec.intents.push(intent);
    counters.intents += 1;
    saveIntent(intent);
    return intent;
  }

  function finish(rec, status, error) {
    rec.status = status === undefined || status === null ? "ok" : String(status);
    rec.ok = rec.status === "ok" || rec.status === "preview";
    rec.error = error === undefined || error === null ? "" : String(error);
    rec.ms = Math.max(0, clockMs(clock) - rec.startedAt);
    rec.spanCount = rec.spans.length;
    saveTrace(rec);
    return rec;
  }

  function trimMemory() {
    while (order.length > keep) {
      const id = order.shift();
      live.delete(id);
      effects.delete(id);
    }
  }

  function begin(input) {
    const src = input === undefined ? {} : input;
    const rec = {
      id: "t-" + (++seq),
      trigger: String(src.trigger === undefined ? "manual" : src.trigger),
      stewardId: src.steward === undefined ? "" : String(src.steward),
      subject: src.subject === undefined ? "" : String(src.subject),
      status: "running",
      startedAt: src.at === undefined ? clockMs(clock) : Number(src.at),
      ms: 0,
      spanCount: 0,
      ok: true,
      error: "",
      spans: [],
      intents: []
    };
    counters.traces += 1;
    order.push(rec.id);
    live.set(rec.id, rec);
    bucket(rec.id);
    attach(rec);
    trimMemory();
    saveTrace(rec);
    return rec;
  }

  function hydrate(limit) {
    if (db === undefined) return 0;
    let rows;
    try {
      rows = db.all("traces");
    } catch (error) {
      log("warn", "trace hydrate failed: " + String(error));
      return 0;
    }
    rows.sort(function (a, b) { return Number(b.started_at) - Number(a.started_at); });
    const take = rows.slice(0, Number(limit) > 0 ? Math.floor(Number(limit)) : keep);
    let loaded = 0;
    for (const row of take) {
      if (live.has(row.id)) continue;
      const rec = attach({
        id: row.id,
        trigger: row.trigger === null ? "" : String(row.trigger),
        stewardId: row.steward_id === null ? "" : String(row.steward_id),
        subject: row.subject === null ? "" : String(row.subject),
        status: row.status === null ? "ok" : String(row.status),
        startedAt: Number(row.started_at) || 0,
        ms: Number(row.ms) || 0,
        spanCount: Number(row.span_count) || 0,
        ok: Number(row.ok) === 1,
        error: row.error === null ? "" : String(row.error),
        spans: [],
        intents: []
      });
      let spanRows = [];
      let effectRows = [];
      let intentRows = [];
      try { spanRows = db.find("spans", { trace_id: row.id }); } catch { spanRows = []; }
      try { effectRows = db.find("effects", { trace_id: row.id }); } catch { effectRows = []; }
      try { intentRows = db.find("intents", { trace_id: row.id }); } catch { intentRows = []; }
      spanRows.sort(function (a, b) { return Number(a.seq) - Number(b.seq); });
      for (const s of spanRows) {
        rec.spans.push({
          id: s.id, traceId: s.trace_id === null ? "" : String(s.trace_id),
          parentId: s.parent_id === null ? "" : String(s.parent_id),
          kind: s.kind === null ? "" : String(s.kind), ref: s.ref === null ? "" : String(s.ref),
          status: s.status === null ? "ok" : String(s.status), startedAt: Number(s.started_at) || 0,
          ms: Number(s.ms) || 0, seq: Number(s.seq) || 0,
          attrs: s.attrs_json !== null && typeof s.attrs_json === "object" ? s.attrs_json : {}
        });
      }
      for (const e of effectRows) {
        bucket(rec.id).push({
          id: "e-h" + String(e.id), traceId: row.id, spanId: e.span_id === null ? "" : String(e.span_id),
          cap: e.cap === null ? "" : String(e.cap),
          params: e.params_json !== null && typeof e.params_json === "object" ? e.params_json : {},
          extId: e.ext_id === null ? "" : String(e.ext_id), ok: Number(e.ok) === 1,
          errorCode: e.error_code === null ? "" : String(e.error_code),
          ms: Number(e.ms) || 0, attempt: Number(e.attempt) || 1
        });
      }
      for (const i of intentRows) {
        rec.intents.push({
          id: "i-h" + String(i.id), traceId: row.id, spanId: i.span_id === null ? "" : String(i.span_id),
          stewardId: i.steward_id === null ? "" : String(i.steward_id),
          cap: i.cap === null ? "" : String(i.cap), carrier: i.carrier === null ? "" : String(i.carrier),
          payload: i.payload === null ? "" : String(i.payload), target: i.target === null ? "" : String(i.target),
          protocol: i.protocol === null ? "fire" : String(i.protocol), route: i.route === null ? "" : String(i.route),
          grant: i.grant === null ? "" : String(i.grant), decision: i.decision === null ? "" : String(i.decision),
          reason: i.reason === null ? "" : String(i.reason), ok: Number(i.ok) === 1,
          preview: Number(i.preview) === 1, at: Number(i.at) || 0, extId: i.ext_id === null ? "" : String(i.ext_id)
        });
      }
      order.push(rec.id);
      live.set(rec.id, rec);
      loaded += 1;
    }
    trimMemory();
    for (const row of rows) seq = Math.max(seq, idNum(row.id));
    for (const rec of live.values()) for (const sp of rec.spans) spanSeq = Math.max(spanSeq, idNum(sp.id));
    return loaded;
  }

  function filterRow(rec, q) {
    if (q.since !== undefined && rec.id !== undefined && idNum(rec.id) <= idNum(q.since)) return false;
    if (q.stewardId !== undefined && q.stewardId !== "" && rec.stewardId !== String(q.stewardId)) return false;
    if (q.subject !== undefined && q.subject !== "" && rec.subject !== String(q.subject)) return false;
    if (q.status !== undefined && q.status !== "" && rec.status !== String(q.status)) return false;
    if (q.trigger !== undefined && q.trigger !== "" && rec.trigger !== String(q.trigger)) return false;
    if (q.ok !== undefined && q.ok !== null && (q.ok === true) !== (rec.ok === true)) return false;
    return true;
  }

  function list(query) {
    const q = query === undefined || query === null ? {} : query;
    const limit = Number(q.limit) > 0 ? Math.floor(Number(q.limit)) : 50;
    const rows = [];
    for (const rec of live.values()) if (filterRow(rec, q)) rows.push(rec);
    rows.sort(function (a, b) {
      if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt;
      return idNum(b.id) - idNum(a.id);
    });
    return rows.slice(0, limit).map(summaryOf);
  }

  function history(query) {
    const q = query === undefined || query === null ? {} : query;
    const limit = Number(q.limit) > 0 ? Math.floor(Number(q.limit)) : 100;
    const out = [];
    const seen = new Set();
    if (db !== undefined) {
      let rows = [];
      try { rows = db.all("traces"); } catch { rows = []; }
      rows.sort(function (a, b) { return Number(b.started_at) - Number(a.started_at); });
      for (const row of rows) {
        const rec = {
          id: row.id, trigger: row.trigger === null ? "" : String(row.trigger),
          stewardId: row.steward_id === null ? "" : String(row.steward_id),
          subject: row.subject === null ? "" : String(row.subject),
          status: row.status === null ? "ok" : String(row.status),
          startedAt: Number(row.started_at) || 0, ms: Number(row.ms) || 0,
          spanCount: Number(row.span_count) || 0, ok: Number(row.ok) === 1,
          error: row.error === null ? "" : String(row.error)
        };
        if (!filterRow(rec, q)) continue;
        out.push(summaryOf(rec));
        seen.add(rec.id);
        if (out.length >= limit) break;
      }
    }
    for (const rec of live.values()) {
      if (seen.has(rec.id) || !filterRow(rec, q)) continue;
      out.push(summaryOf(rec));
    }
    out.sort(function (a, b) {
      if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt;
      return idNum(b.id) - idNum(a.id);
    });
    return out.slice(0, limit);
  }

  function get(id) {
    const rec = live.get(String(id));
    return rec === undefined ? undefined : rec;
  }

  function waterfall(id) {
    const rec = get(id);
    if (rec === undefined) return undefined;
    const eff = bucket(rec.id);
    const spans = rec.spans.map(function (span) {
      return Object.assign({}, span, {
        effects: eff.filter(function (e) { return e.spanId === span.id || e.spanId === ""; })
      });
    });
    return {
      trace: summaryOf(rec),
      spans: spans,
      effects: eff.slice(),
      intents: rec.intents.slice()
    };
  }

  function byExtId(extId) {
    const want = String(extId === undefined ? "" : extId);
    if (want === "") return [];
    const hits = [];
    for (const rec of live.values()) {
      const eff = bucket(rec.id);
      for (const e of eff) if (e.extId === want) hits.push({ trace: summaryOf(rec), effect: e });
    }
    return hits;
  }

  function since(afterId, limit) {
    return list({ since: afterId, limit: Number(limit) > 0 ? Number(limit) : 200 });
  }

  function drop(id) {
    try { for (const s of db.find("spans", { trace_id: id })) db.remove("spans", { id: s.id }); } catch { /* ignore */ }
    try { for (const e of db.find("effects", { trace_id: id })) db.remove("effects", { id: e.id }); } catch { /* ignore */ }
    try { for (const i of db.find("intents", { trace_id: id })) db.remove("intents", { id: i.id }); } catch { /* ignore */ }
    try { db.remove("traces", { id: id }); } catch { /* ignore */ }
  }

  function prune(input) {
    const src = input === undefined ? {} : input;
    if (db === undefined) return { removed: 0 };
    const keepDays = Number(src.keepDays) > 0 ? Number(src.keepDays) : 30;
    const maxRows = Number(src.maxRows) > 0 ? Math.floor(Number(src.maxRows)) : 5000;
    const cutoff = Date.now() - keepDays * 86400000;
    let rows = [];
    try { rows = db.all("traces"); } catch { rows = []; }
    rows.sort(function (a, b) { return Number(a.started_at) - Number(b.started_at); });
    const survivors = [];
    let removed = 0;
    for (const row of rows) {
      if (Number(row.started_at) > 0 && Number(row.started_at) < cutoff) {
        drop(row.id);
        removed += 1;
      } else {
        survivors.push(row.id);
      }
    }
    if (survivors.length > maxRows) {
      for (const id of survivors.slice(0, survivors.length - maxRows)) {
        drop(id);
        removed += 1;
      }
    }
    return { removed: removed };
  }

  function aggregates(input) {
    const src = input === undefined || input === null ? {} : input;
    const maxTraces = Number(src.maxTraces) > 0 ? Math.floor(Number(src.maxTraces)) : 500;
    const out = { traces: 0, intents: 0, effects: 0, previews: 0, denies: 0, approvals: 0, skips: 0, byReason: {}, byDecision: {}, byTrigger: {}, byCap: {}, effectFails: [] };
    const seen = new Set();
    function bump(map, key) {
      const k = key === undefined || key === null || key === "" ? "(none)" : String(key);
      map[k] = (map[k] === undefined ? 0 : map[k]) + 1;
    }
    function addIntent(i) {
      out.intents += 1;
      if (i.preview === true) out.previews += 1;
      bump(out.byReason, i.reason);
      bump(out.byDecision, i.decision);
      const id = String(i.cap === undefined || i.cap === null ? "" : i.cap);
      const slot = out.byCap[id] === undefined ? (out.byCap[id] = { total: 0, run: 0, preview: 0, deny: 0, approval: 0, skip: 0, ok: 0, fail: 0, lastAt: 0 }) : out.byCap[id];
      slot.total += 1;
      const d = String(i.decision === undefined ? "" : i.decision);
      if (slot[d] !== undefined) slot[d] += 1;
      if (i.ok === true) slot.ok += 1; else slot.fail += 1;
      slot.lastAt = Math.max(slot.lastAt, Number(i.at) || 0);
    }
    function addEffect(e) {
      out.effects += 1;
      if (e.ok === false) out.effectFails.push({ cap: e.cap === undefined || e.cap === null ? "" : String(e.cap), errorCode: e.errorCode === undefined || e.errorCode === null || e.errorCode === "" ? "failed" : String(e.errorCode) });
    }
    for (const rec of live.values()) {
      seen.add(rec.id);
      out.traces += 1;
      bump(out.byTrigger, rec.trigger);
      for (const i of rec.intents) addIntent(i);
      for (const e of bucket(rec.id)) addEffect(e);
    }
    if (db !== undefined) {
      let rows = [];
      try { rows = db.all("traces"); } catch { rows = []; }
      rows.sort(function (a, b) { return Number(b.started_at) - Number(a.started_at); });
      for (const row of rows.slice(0, maxTraces)) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        out.traces += 1;
        bump(out.byTrigger, row.trigger);
        try { for (const i of db.find("intents", { trace_id: row.id })) addIntent({ cap: i.cap, reason: i.reason, decision: i.decision, ok: Number(i.ok) === 1, at: i.at, preview: Number(i.preview) === 1 }); } catch { /* ignore */ }
        try { for (const e of db.find("effects", { trace_id: row.id })) addEffect({ cap: e.cap, ok: Number(e.ok) === 1, errorCode: e.error_code === null ? "" : String(e.error_code) }); } catch { /* ignore */ }
      }
    }
    const byDecision = out.byDecision;
    out.denies = Number(byDecision.deny) || 0;
    out.approvals = Number(byDecision.approval) || 0;
    out.skips = Number(byDecision.skip) || 0;
    return out;
  }

  function stats() {
    return {
      backend: db === undefined ? "memory" : "db",
      live: live.size,
      keep: keep,
      seq: seq,
      traces: counters.traces,
      spans: counters.spans,
      effects: counters.effects,
      intents: counters.intents,
      persisted: counters.persisted,
      persistFailed: counters.persistFailed
    };
  }

  function flush() {
    if (db !== undefined && typeof db.flush === "function") {
      try { db.flush(); } catch (error) { log("warn", "trace flush failed: " + String(error)); }
    }
  }

  function dispose() {
    flush();
    live.clear();
    order.length = 0;
    effects.clear();
  }

  const api = {
    begin: begin,
    get: get,
    list: list,
    history: history,
    waterfall: waterfall,
    since: since,
    byExtId: byExtId,
    aggregates: aggregates,
    hydrate: hydrate,
    prune: prune,
    stats: stats,
    flush: flush,
    dispose: dispose
  };
  if (db !== undefined && opts.hydrate !== false) hydrate(Number(opts.hydrate) > 0 ? Number(opts.hydrate) : 50);
  return api;
}

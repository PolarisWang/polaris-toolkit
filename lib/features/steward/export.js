/**
 * Steward: 指标出口（P7）。
 *
 * 两个出口，都不引入依赖：
 *   · Prometheus 文本 —— GET /__polaris/steward/metrics，供 node_exporter/prometheus 抓取；
 *   · OTLP/HTTP(JSON) —— 按 export.otlp.endpoint 主动 push（POST <endpoint>/v1/metrics），
 *     默认关闭，配了 endpoint 才发。
 *
 * 只导出"已经被观察层算出来的事实"，不在这里做任何 IO 采样，避免和 health.sample 抢资源。
 */

function series(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return { name, value: n, type: "gauge" };
}

function labelKey(labels) {
  if (labels === undefined || labels === null) return "";
  return Object.keys(labels).sort().map((k) => k + "=" + String(labels[k])).join(",");
}

/** 把工具包指标注册表的快照（core/metrics.js snapshot()）转成导出格式。 */
function coreSeries(snap) {
  const list = Array.isArray(snap.metrics) ? snap.metrics : [];
  const out = [];
  for (const m of list) {
    if (m === null || typeof m !== "object") continue;
    const value = Number(m.value);
    if (typeof m.name !== "string" || !Number.isFinite(value)) continue;
    const item = { name: m.name, value, type: typeof m.type === "string" ? m.type : "gauge" };
    if (typeof m.help === "string" && m.help.length > 0) item.help = m.help;
    if (m.labels !== undefined && m.labels !== null && Object.keys(m.labels).length > 0) item.labels = m.labels;
    out.push(item);
  }
  return out;
}

/**
 * 把一份 state 快照摊平成指标数组（Prometheus 与 OTLP 共用）。
 *
 * 评审 P0-2：snap.metrics（工具包唯一注册表）优先，名字已被注册表占用的旧推导项
 * 直接丢弃——同一个名字只能有一个真相。
 */
export function metricsOf(snap) {
  const out = [];
  const seen = new Set();
  for (const item of coreSeries(snap)) {
    seen.add(item.name + labelKey(item.labels));
    out.push(item);
  }
  const h = snap.health === undefined || snap.health === null ? {} : snap.health;
  const modules = Array.isArray(snap.modules) ? snap.modules : [];
  const agents = Array.isArray(snap.agents) ? snap.agents : [];
  const budget = snap.budget === undefined || snap.budget === null ? {} : snap.budget;
  const runs = Array.isArray(snap.runs) ? snap.runs : [];
  const approvals = Array.isArray(snap.approvals) ? snap.approvals : [];
  const titles = snap.titles === undefined || snap.titles === null ? {} : snap.titles;
  const counters = snap.counters === undefined || snap.counters === null ? {} : snap.counters;
  const crash = h.crash === undefined || h.crash === null ? {} : h.crash;
  const loop = h.loop === undefined || h.loop === null ? {} : h.loop;
  const push = (m) => {
    if (m === undefined) return;
    const key = m.name + labelKey(m.labels);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(m);
  };
  push(series("polaris_heap_used_mb", h.heapUsedMB));
  push(series("polaris_heap_limit_mb", h.heapLimitMB));
  push(series("polaris_heap_pct", h.heapLimitMB > 0 ? Math.round((h.heapUsedMB / h.heapLimitMB) * 1000) / 10 : undefined));
  push(series("polaris_rss_mb", h.rssMB));
  push(series("polaris_event_loop_p99_ms", loop.p99Ms));
  push(series("polaris_event_loop_max_ms", loop.maxMs));
  push(series("polaris_crashes_24h", crash.last24h));
  push(series("polaris_agents_total", agents.length));
  push(series("polaris_agents_running", agents.filter((a) => a.status === "running").length));
  push(series("polaris_agents_stalled", agents.filter((a) => a.stalled === true).length));
  push(series("polaris_agents_attention", agents.filter((a) => a.attention === true).length));
  push(series("polaris_agents_unassigned", agents.filter((a) => a.moduleId === "unassigned").length));
  push(series("polaris_runs_open", runs.filter((r) => r.status !== "done" && r.status !== "failed").length));
  push(series("polaris_runs_failed", runs.filter((r) => r.status === "failed").length));
  push(series("polaris_approvals_open", approvals.length));
  push(series("polaris_budget_used", budget.used));
  push(series("polaris_budget_max", budget.max));
  push(series("polaris_signals_total", Array.isArray(snap.signals) ? snap.signals.length : undefined));
  push(series("polaris_events_total", counters.events));
  push(series("polaris_title_cache", titles.size));
  for (const mod of modules) {
    const modSeries = series("polaris_module_agents", mod.count);
    if (modSeries !== undefined) out.push({ name: modSeries.name, value: modSeries.value, labels: { module: mod.id } });
    const runSeries = series("polaris_module_running", mod.running);
    if (runSeries !== undefined) out.push({ name: runSeries.name, value: runSeries.value, labels: { module: mod.id } });
  }
  return out;
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Prometheus 文本格式（带 TYPE；帮助文本可选）。 */
export function prometheusText(snap) {
  const lines = [];
  const declared = new Set();
  for (const m of metricsOf(snap)) {
    if (!declared.has(m.name)) {
      declared.add(m.name);
      if (m.help !== undefined) lines.push("# HELP " + m.name + " " + String(m.help).replace(/\n/g, " "));
      lines.push("# TYPE " + m.name + " " + (m.type === undefined ? "gauge" : m.type));
    }
    if (m.labels === undefined) { lines.push(m.name + " " + m.value); continue; }
    const labels = Object.entries(m.labels).map(([k, v]) => k + '="' + escapeLabel(v) + '"').join(",");
    lines.push(m.name + "{" + labels + "} " + m.value);
  }
  return lines.join("\n") + "\n";
}

/** OTLP/HTTP JSON：一个 resourceMetrics，一个 scope，全是 gauge。 */
export function otlpBody(snap, { hostId, now }) {
  const time = String(now) + "000000";
  const metrics = metricsOf(snap).map((m) => ({
    name: m.name,
    gauge: {
      dataPoints: [{
        asDouble: m.value,
        timeUnixNano: time,
        ...(m.labels === undefined ? {} : {
          attributes: Object.entries(m.labels).map(([k, v]) => ({ key: k, value: { stringValue: String(v) } }))
        })
      }]
    }
  }));
  return {
    resourceMetrics: [{
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "polaris-toolkit" } },
          { key: "service.namespace", value: { stringValue: "dsh" } },
          { key: "host.name", value: { stringValue: String(hostId) } }
        ]
      },
      scopeMetrics: [{ scope: { name: "polaris.toolkit", version: "0.1.0" }, metrics }]
    }]
  };
}

export function createExporter({ readSettings, log }) {
  let lastPushAt = 0;
  let lastError;
  let pushed = 0;

  function cfg() {
    let raw = {};
    try { raw = readSettings(); } catch { raw = {}; }
    const e = raw.export !== null && typeof raw.export === "object" ? raw.export : {};
    const o = e.otlp !== null && typeof e.otlp === "object" ? e.otlp : {};
    return {
      prometheus: e.prometheus !== false,
      endpoint: typeof o.endpoint === "string" ? o.endpoint.replace(/\/+$/, "") : "",
      headers: o.headers !== null && typeof o.headers === "object" ? o.headers : {},
      intervalSec: Number.isFinite(Number(e.intervalSec)) ? Math.max(15, Math.min(3600, Number(e.intervalSec))) : 60,
      enabled: o.enabled === true
    };
  }

  async function push(snap) {
    const c = cfg();
    if (!c.enabled || c.endpoint.length === 0) return { ok: false, reason: "otlp disabled" };
    const url = c.endpoint + "/v1/metrics";
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: Object.assign({ "content-type": "application/json" }, c.headers),
        body: JSON.stringify(otlpBody(snap, { hostId: String(snap.hostId === undefined ? "host" : snap.hostId), now: Date.now() })),
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      lastPushAt = Date.now();
      pushed += 1;
      lastError = undefined;
      return { ok: true, url };
    } catch (error) {
      lastError = String(error !== null && error !== undefined && error.message !== undefined ? error.message : error);
      log("debug", "steward: otlp push failed: " + lastError);
      return { ok: false, reason: lastError };
    }
  }

  /** 由 tick 调用：配了 otlp 且到间隔才推。 */
  async function maybePush(snap) {
    const c = cfg();
    if (!c.enabled || c.endpoint.length === 0) return undefined;
    if (Date.now() - lastPushAt < c.intervalSec * 1000) return undefined;
    return push(snap);
  }

  function stats() {
    const c = cfg();
    return { prometheus: c.prometheus, otlpEnabled: c.enabled, endpoint: c.endpoint, intervalSec: c.intervalSec, lastPushAt, pushed, lastError };
  }

  return { cfg, push, maybePush, stats };
}

export default { createExporter, metricsOf, prometheusText, otlpBody };

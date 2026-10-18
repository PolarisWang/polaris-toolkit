/**
 * Toolkit 级指标注册表 + 唯一的宿主采样器。
 *
 * 为什么要有这一层（评审 P0-2）：
 *   - 之前 steward/health.js 和 heap-guard/sampler.js 各采一份 process.memoryUsage
 *     与事件循环延迟，于是两个面板、/metrics 导出的数字互相打架；
 *   - 现在 feature 只"发布"指标（gauge / counter），采样只在这里做一次，
 *     /__polaris/metrics 与 steward 的 export.js 共用同一份快照。
 *
 * 约定：
 *   - 指标名一律 polaris_ 前缀，单位写进名字（_mb / _ms / _pct / 无单位计数）；
 *   - gauge 的回调必须幂等、不能抛（抛了这条序列会被跳过，不会影响其它指标）；
 *   - counter 只增不减，进程重启归零。
 */
import { monitorEventLoopDelay } from "node:perf_hooks";

function round1(n) {
  return Math.round(n * 10) / 10;
}

function labelText(labels) {
  const src = labels === undefined || labels === null ? {} : labels;
  const keys = Object.keys(src).sort();
  if (keys.length === 0) return "";
  return "{" + keys.map((k) => k + '="' + String(src[k]).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"').join(",") + "}";
}

function formatValue(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 1000) / 1000);
}

export function createMetrics() {
  const series = new Map();

  function add(type, name, read, opts) {
    const o = opts === undefined || opts === null ? {} : opts;
    const labels = o.labels !== undefined && o.labels !== null && typeof o.labels === "object" ? o.labels : {};
    const key = String(name) + labelText(labels);
    series.set(key, { name: String(name), type, help: typeof o.help === "string" ? o.help : "", labels, read });
    return () => { series.delete(key); };
  }

  function snapshot() {
    const out = [];
    for (const item of series.values()) {
      let value;
      try { value = typeof item.read === "function" ? item.read() : item.read; } catch { continue; }
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      out.push({ name: item.name, type: item.type, help: item.help, labels: item.labels, value });
    }
    out.sort((a, b) => (a.name === b.name ? labelText(a.labels).localeCompare(labelText(b.labels)) : a.name.localeCompare(b.name)));
    return out;
  }

  function text() {
    const lines = [];
    const declared = new Set();
    for (const item of snapshot()) {
      if (!declared.has(item.name)) {
        declared.add(item.name);
        if (item.help !== "") lines.push("# HELP " + item.name + " " + item.help.replace(/\n/g, " "));
        lines.push("# TYPE " + item.name + " " + item.type);
      }
      lines.push(item.name + labelText(item.labels) + " " + formatValue(item.value));
    }
    return lines.join("\n") + "\n";
  }

  return {
    gauge(name, read, opts) {
      if (typeof read !== "function") return () => {};
      return add("gauge", name, read, opts);
    },
    counter(name, opts) {
      let value = 0;
      const off = add("counter", name, () => value, opts);
      return { inc(n) { value += typeof n === "number" && Number.isFinite(n) ? n : 1; }, value: () => value, remove: off };
    },
    /** 直接登记一条只读的函数序列（feature 用 scope.metrics.gauge 就够，这里是给 host 自己用的）。 */
    add,
    snapshot,
    text,
    size() { return series.size; },
    dispose() { series.clear(); }
  };
}

/**
 * 唯一的宿主采样器：heap / rss / event-loop。
 * 用 peek() 读上一次结果，不重复采样；sample() 才真的读一次。
 */
export function createHostSampler() {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  try { histogram.enable(); } catch { /* platform without event loop delay */ }
  let last;

  function heapLimitBytes() {
    try {
      const v8 = process.getBuiltinModule !== undefined ? process.getBuiltinModule("v8") : undefined;
      if (v8 !== undefined && typeof v8.getHeapStatistics === "function") return v8.getHeapStatistics().heap_size_limit;
    } catch { /* ignore */ }
    return 0;
  }

  function sample() {
    const mu = process.memoryUsage();
    const limit = heapLimitBytes();
    last = {
      at: Date.now(),
      heapUsedMB: round1(mu.heapUsed / 1048576),
      heapTotalMB: round1(mu.heapTotal / 1048576),
      heapLimitMB: round1(limit / 1048576),
      heapPct: limit > 0 ? round1((mu.heapUsed / limit) * 100) : 0,
      rssMB: round1(mu.rss / 1048576),
      externalMB: round1(mu.external / 1048576),
      loop: {
        maxMs: round1(histogram.max / 1e6),
        p99Ms: round1(histogram.percentile(99) / 1e6),
        meanMs: round1(histogram.mean / 1e6)
      }
    };
    try { histogram.reset(); } catch { /* ignore */ }
    return last;
  }

  return {
    sample,
    peek: () => last,
    get last() { return last; },
    dispose() { try { histogram.disable(); } catch { /* ignore */ } }
  };
}

export default { createMetrics, createHostSampler };

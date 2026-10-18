/**
 * Steward: 宿主健康视图（复用工具包唯一的宿主采样器 + 崩溃日志扫描）。
 *
 * P0 只读：不触发 GC、不重启、不瘦身——那些是 Heap Guard 和 C 档看门狗的事。
 * 这里的数据用于"总管该不该说话"的判断，以及面板顶部的金字塔尖。
 *
 * 评审 P0-2：堆 / RSS / 事件循环延迟不再自己采一份，统一取 scope.host（core/metrics.js
 * 的 createHostSampler），避免两个面板与 /metrics 的数字互相打架。只有"没拿到 host"
 * 的降级路径才退回本地采样，保证单测里不带宿主也能工作。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

const CRASH_CACHE_MS = 30_000;
const RING_MAX = 240;

function crashLogDir() {
  const appData = process.env.APPDATA !== undefined && process.env.APPDATA.length > 0
    ? process.env.APPDATA
    : path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "@deepseek-ai", "dsh-desktop", "logs");
}

function readCrashLogs() {
  const dir = crashLogDir();
  const out = { dir, total: 0, last24h: 0, newest: undefined, recent: [] };
  let names;
  try { names = fs.readdirSync(dir); } catch { return out; }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith("crash-") || !name.endsWith(".log")) continue;
    let st;
    try { st = fs.statSync(path.join(dir, name)); } catch { continue; }
    out.total += 1;
    if (now - st.mtimeMs < 86_400_000) out.last24h += 1;
    out.recent.push({ name, at: st.mtimeMs, size: st.size });
  }
  out.recent.sort((a, b) => b.at - a.at);
  out.recent = out.recent.slice(0, 5);
  out.newest = out.recent[0];
  return out;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function v8HeapLimit() {
  try {
    const v8 = process.getBuiltinModule !== undefined ? process.getBuiltinModule("v8") : undefined;
    if (v8 !== undefined && typeof v8.getHeapStatistics === "function") return v8.getHeapStatistics().heap_size_limit;
  } catch { /* ignore */ }
  return 0;
}

/**
 * @param {{ host?: { sample?: Function, peek?: Function } }} [opts]
 *   host —— 工具包的 createHostSampler()（scope.host）。给了就复用，不再自己采样。
 */
export function createHealth(opts) {
  const host = opts !== undefined && opts !== null && opts.host !== undefined && opts.host !== null ? opts.host : undefined;
  const useHost = host !== undefined && typeof host.sample === "function";
  let histogram = undefined;
  if (!useHost) {
    histogram = monitorEventLoopDelay({ resolution: 20 });
    try { histogram.enable(); } catch { /* platform without event loop delay */ }
  }
  let lastCrashRead = 0;
  let crash = { dir: crashLogDir(), total: 0, last24h: 0, newest: undefined, recent: [] };
  let last = undefined;
  const ring = [];

  function localSample() {
    const mem = process.memoryUsage();
    const limit = v8HeapLimit();
    return {
      at: Date.now(),
      heapUsedMB: round1(mem.heapUsed / 1048576),
      heapLimitMB: round1(limit / 1048576),
      heapTotalMB: round1(mem.heapTotal / 1048576),
      rssMB: round1(mem.rss / 1048576),
      externalMB: round1(mem.external / 1048576),
      loop: {
        maxMs: round1(histogram.max / 1e6),
        p99Ms: round1(histogram.percentile(99) / 1e6),
        meanMs: round1(histogram.mean / 1e6)
      }
    };
  }

  function sample() {
    const base = useHost ? host.sample() : localSample();
    if (histogram !== undefined && useHost !== true) {
      try { histogram.reset(); } catch { /* ignore */ }
    }
    const now = Date.now();
    if (now - lastCrashRead > CRASH_CACHE_MS) {
      lastCrashRead = now;
      crash = readCrashLogs();
    }
    last = {
      at: now,
      source: useHost ? "host" : "local",
      heapUsedMB: base.heapUsedMB,
      heapLimitMB: base.heapLimitMB,
      heapPct: base.heapPct === undefined ? (base.heapLimitMB > 0 ? round1((base.heapUsedMB / base.heapLimitMB) * 100) : 0) : base.heapPct,
      heapTotalMB: base.heapTotalMB,
      rssMB: base.rssMB,
      externalMB: base.externalMB,
      loop: base.loop,
      loadAvg: os.loadavg()[0],
      crash
    };
    ring.push({ at: now, heapUsedMB: last.heapUsedMB, rssMB: last.rssMB, maxMs: last.loop.maxMs, p99Ms: last.loop.p99Ms });
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    return last;
  }

  function dispose() {
    if (histogram === undefined) return;
    try { histogram.disable(); } catch { /* ignore */ }
  }

  return { sample, dispose, history: ring, get last() { return last; }, crashLogDir };
}

export default { createHealth, crashLogDir };

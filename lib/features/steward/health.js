/**
 * Steward: 宿主健康采样（堆 / 事件循环延迟 / 崩溃日志）。
 *
 * P0 只读：不触发 GC、不重启、不瘦身——那些是 Heap Guard 和 C 档看门狗的事。
 * 这里的数据用于"总管该不该说话"的判断，以及面板顶部的金字塔尖。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

const CRASH_CACHE_MS = 30_000;

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

export function createHealth() {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let lastCrashRead = 0;
  let crash = { dir: crashLogDir(), total: 0, last24h: 0, newest: undefined, recent: [] };
  let last = undefined;
  const ring = [];
  const RING_MAX = 240;

  function sample() {
    const mem = process.memoryUsage();
    const usedMB = Math.round((mem.heapUsed / 1048576) * 10) / 10;
    const maxMs = Math.round((histogram.max / 1e6) * 10) / 10;
    const p99Ms = Math.round((histogram.percentile(99) / 1e6) * 10) / 10;
    const meanMs = Math.round((histogram.mean / 1e6) * 10) / 10;
    histogram.reset();
    const now = Date.now();
    if (now - lastCrashRead > CRASH_CACHE_MS) {
      lastCrashRead = now;
      crash = readCrashLogs();
    }
    last = {
      at: now,
      heapUsedMB: usedMB,
      heapLimitMB: Math.round((require_v8_heap_limit() / 1048576) * 10) / 10,
      heapTotalMB: Math.round((mem.heapTotal / 1048576) * 10) / 10,
      rssMB: Math.round((mem.rss / 1048576) * 10) / 10,
      externalMB: Math.round((mem.external / 1048576) * 10) / 10,
      loop: { maxMs, p99Ms, meanMs },
      loadAvg: os.loadavg()[0],
      crash
    };
    ring.push({ at: now, heapUsedMB: usedMB, rssMB: last.rssMB, maxMs, p99Ms });
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    return last;
  }

  function require_v8_heap_limit() {
    try {
      const v8 = process.getBuiltinModule !== undefined ? process.getBuiltinModule("v8") : undefined;
      if (v8 !== undefined && typeof v8.getHeapStatistics === "function") return v8.getHeapStatistics().heap_size_limit;
    } catch { /* ignore */ }
    return 0;
  }

  function dispose() {
    try { histogram.disable(); } catch { /* ignore */ }
  }

  return { sample, dispose, history: ring, get last() { return last; }, crashLogDir };
}

export default { createHealth, crashLogDir };

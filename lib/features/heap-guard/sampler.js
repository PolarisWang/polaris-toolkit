/**
 * Heap / process / session sampler. Pure observation, no side effects beyond
 * the CSV and the in-memory ring buffer.
 */
const FEATURE_ID = "heap-guard";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import { appendCsv, mb, round1, featureDir } from "../../core/paths.js";
import { listSessionFiles } from "./idle.js";

export function heapSample() {
  const hs = v8.getHeapStatistics();
  const spaces = v8.getHeapSpaceStatistics();
  const mu = process.memoryUsage();
  const out = {
    heapSizeLimitMB: round1(hs.heap_size_limit / 1048576),
    heapTotalMB: round1(hs.total_heap_size / 1048576),
    heapUsedMB: round1(hs.used_heap_size / 1048576),
    heapAvailableMB: round1(hs.total_available_size / 1048576),
    externalMB: round1(hs.external_memory / 1048576),
    rssMB: round1(mu.rss / 1048576),
    arrayBuffersMB: round1(mu.arrayBuffers / 1048576),
    mallocedMB: round1(hs.malloced_memory / 1048576),
    peakMallocedMB: round1(hs.peak_malloced_memory / 1048576),
    spaces: spaces.map((s) => ({
      name: s.space_name,
      sizeMB: round1(s.space_size / 1048576),
      usedMB: round1(s.space_used_size / 1048576),
      availableMB: round1(s.space_available_size / 1048576),
      physicalMB: round1(s.physical_space_size / 1048576)
    }))
  };
  out.usedPct = hs.heap_size_limit > 0 ? round1((hs.used_heap_size / hs.heap_size_limit) * 100) : 0;
  return out;
}

/**
 * Free megabytes on the volume containing dir. Walks up to the nearest existing
 * ancestor first, so a not-yet-created state directory still answers.
 */
export function freeDiskMB(dir) {
  let probe = dir;
  for (let i = 0; i < 24 && probe !== undefined; i += 1) {
    try {
      const s = fs.statfsSync(probe);
      return round1((Number(s.bavail) * Number(s.bsize)) / 1048576);
    } catch {
      const parent = path.dirname(probe);
      probe = parent === probe ? undefined : parent;
    }
  }
  return undefined;
}

export function systemMemoryMB() {
  const total = round1(os.totalmem() / 1048576);
  const free = round1(os.freemem() / 1048576);
  return { totalMB: total, freeMB: free, usedPct: round1(((total - free) / total) * 100) };
}

/** Ring buffer of samples + CSV mirror + threshold crossing detection. */
export class Sampler {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.ring = [];
    this.timer = undefined;
    this.lastTick = 0;
    this.sessions = [];
    this.sessionsAt = 0;
    this.agents = [];
    this.threshold = undefined;
    this.listeners = new Set();
  }

  onSample(fn) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  sessionCache(force) {
    const now = Date.now();
    if (force || now - this.sessionsAt > 5 * 60 * 1000) {
      try { this.sessions = listSessionFiles(); } catch { this.sessions = []; }
      this.sessionsAt = now;
    }
    return this.sessions;
  }

  agentSnapshot() {
    const out = [];
    try {
      const agents = this.ctx.agents.list();
      for (const agent of agents) {
        out.push({
          id: typeof agent.id === "string" ? agent.id : String(agent.id),
          status: agent.status === undefined ? "unknown" : agent.status,
          sessionId: agent.sessionId
        });
      }
    } catch { /* agents service unavailable */ }
    return out;
  }

  tick() {
    const t = Date.now();
    const heap = heapSample();
    const sessions = this.sessionCache(false);
    this.agents = this.agentSnapshot();
    const sample = {
      t,
      iso: new Date(t).toISOString(),
      heap,
      system: systemMemoryMB(),
      freeDiskMB: freeDiskMB(featureDir(FEATURE_ID)),
      agents: this.agents,
      agentCount: this.agents.length,
      runningAgentCount: this.agents.filter((a) => a.status === "running").length,
      sessions: sessions.slice(0, 40).map((s) => ({
        id: s.id, workspace: s.workspace, sizeMB: round1(s.size / 1048576), mtimeMs: s.mtimeMs
      })),
      sessionCount: sessions.length,
      sessionTotalMB: round1(sessions.reduce((n, s) => n + s.size, 0) / 1048576)
    };
    sample.growthMBPerMin = this.growthPerMin(sample);
    sample.level = this.levelOf(sample.heap.usedPct);

    this.ring.push(sample);
    const cap = this.config.ringSize === undefined ? 480 : this.config.ringSize;
    while (this.ring.length > cap) this.ring.shift();

    if (this.config.csv !== false) {
      try {
        appendCsv(
          featureDir(FEATURE_ID) + "/samples.csv",
          ["time", "iso", "usedMB", "limitMB", "usedPct", "totalMB", "availMB", "rssMB", "agents", "runningAgents", "sessionsMB", "growthMBPerMin", "level", "systemUsedPct"],
          [t, sample.iso, sample.heap.heapUsedMB, sample.heap.heapSizeLimitMB, sample.heap.usedPct, sample.heap.heapTotalMB, sample.heap.heapAvailableMB, sample.heap.rssMB, sample.agentCount, sample.runningAgentCount, sample.sessionTotalMB, sample.growthMBPerMin, sample.level, sample.system.usedPct]
        );
      } catch { /* best effort */ }
    }

    this.lastTick = t;
    for (const fn of this.listeners) {
      try { fn(sample, this); } catch { /* a listener must not stop sampling */ }
    }
    return sample;
  }

  growthPerMin(sample) {
    const arr = this.ring;
    if (arr.length < 2) return 0;
    const window = 20;
    const from = arr.length > window ? arr[arr.length - window] : arr[0];
    const dtMin = (sample.t - from.t) / 60000;
    if (dtMin <= 0.2) return 0;
    return round1((sample.heap.heapUsedMB - from.heap.heapUsedMB) / dtMin);
  }

  levelOf(pct) {
    const c = this.config;
    if (pct >= c.emergencyPct) return "emergency";
    if (pct >= c.criticalPct) return "critical";
    if (pct >= c.highPct) return "high";
    if (pct >= c.warnPct) return "warn";
    return "ok";
  }

  start() {
    const sec = this.config.intervalSec === undefined ? 30 : this.config.intervalSec;
    this.tick();
    this.timer = setInterval(() => {
      try { this.tick(); } catch { /* keep the timer alive */ }
    }, sec * 1000);
    if (typeof this.timer.unref === "function") this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  state() {
    const last = this.ring.length === 0 ? undefined : this.ring[this.ring.length - 1];
    return {
      now: Date.now(),
      config: {
        intervalSec: this.config.intervalSec,
        warnPct: this.config.warnPct,
        highPct: this.config.highPct,
        criticalPct: this.config.criticalPct,
        emergencyPct: this.config.emergencyPct
      },
      last,
      history: this.ring.slice(-180),
      stateDir: featureDir(FEATURE_ID)
    };
  }
}
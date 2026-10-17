/**
 * Idle-session auto-slim.
 *
 * The heavy lifting is the already-verified bin/slim.mjs, spawned as a CHILD
 * process (ELECTRON_RUN_AS_NODE=1 with process.execPath). Two reasons:
 *   - the repack decompresses and re-compresses whole session containers, so its
 *     memory cost stays out of the host heap this plugin is watching;
 *   - the same code path was verified byte-for-byte on real session files.
 *
 * Safety rails here: one session per pass, only a file whose newest structural
 * record is turn/end, all agents idle, a cooldown, an hourly cap, an explicit
 * exclude list, and a full backup before the rewrite.
 */
const FEATURE_ID = "heap-guard";

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendCsv, ensureDir, round1, stamp, featureDir } from "../../core/paths.js";
import { isSessionClosed } from "./idle.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SLIM_SCRIPT = path.join(here, "..", "..", "..", "bin", "slim.mjs");

/** Spawn bin/slim.mjs and resolve with its JSON report. */
export function runSlim(options) {
  const o = options === undefined ? {} : options;
  const only = Array.isArray(o.only) ? o.only : [];
  if (only.length === 0) throw new Error("runSlim requires an explicit --only session id");
  const state = ensureDir(featureDir(FEATURE_ID));
  const runStamp = stamp();
  const manifest = path.join(state, "slim-manifest-" + runStamp + ".csv");
  const json = path.join(state, "slim-manifest-" + runStamp + ".json");
  const backup = o.backupDir === undefined ? path.join(state, "slim-backup-" + runStamp) : o.backupDir;
  const args = [
    SLIM_SCRIPT,
    "--level", String(o.level === undefined ? 3 : o.level),
    "--min-mb", String(o.minMB === undefined ? 0 : o.minMB),
    "--older-than-hours", "0",
    "--backup", backup,
    "--manifest", manifest,
    "--json", json
  ];
  if (o.sessionsRoot !== undefined) args.push("--sessions", o.sessionsRoot);
  if (o.apply === true) args.push("--apply");
  for (const id of only) args.push("--only", id);
  for (const id of (o.exclude === undefined ? [] : o.exclude)) args.push("--exclude", id);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const cap = o.captureCapBytes === undefined ? 200000 : o.captureCapBytes;
    child.stdout.on("data", (b) => { if (out.length < cap) out += b.toString("utf8"); });
    child.stderr.on("data", (b) => { if (err.length < cap) err += b.toString("utf8"); });
    const timeoutMs = o.timeoutMs === undefined ? 15 * 60 * 1000 : o.timeoutMs;
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: "spawn-failed", error: error.message, backup, manifest, json });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let report;
      try { report = JSON.parse(fs.readFileSync(json, "utf8")); } catch { report = undefined; }
      resolve({ ok: code === 0 && report !== undefined, code, report, stdout: out, stderr: err, backup, manifest, json });
    });
  });
}

/**
 * Auto-slimmer: decides whether the current moment is a safe point and, if so,
 * slims exactly one eligible session.
 */
export class AutoSlimmer {
  constructor(ctx, config, sampler, settings) {
    this.ctx = ctx;
    this.config = config;
    this.sampler = sampler;
    this.settings = settings;
    this.busy = false;
    this.lastRunAt = 0;
    this.runTimes = [];
    this.attempted = new Map();
    this.lastResult = undefined;
  }

  /**
   * 自动清理是显式开启的：config.enabled 是"这条链路允许存在"的总开关，
   * 真正的自动执行必须由面板上的开关（settings.autoSlim）打开，默认关。
   */
  autoEnabled() {
    if (this.config.enabled !== true) return false;
    if (this.settings === undefined || this.settings === null) return false;
    return this.settings.get("autoSlim") === true;
  }

  configuredLevel() {
    if (this.settings !== undefined && this.settings !== null) {
      const value = this.settings.get("slimLevel");
      if (value !== undefined && value !== null) return Number(value);
    }
    return this.config.level === undefined ? 3 : this.config.level;
  }

  runningAgentCount(agents) {
    return agents.filter((a) => a.status === "running").length;
  }

  candidates(sessions) {
    const cfg = this.config;
    const exclude = Array.isArray(cfg.exclude) ? cfg.exclude : [];
    const minMB = cfg.minMB === undefined ? 8 : cfg.minMB;
    const out = [];
    for (const s of sessions) {
      if (s.size < minMB * 1048576) continue;
      if (exclude.some((e) => s.id.startsWith(e) || (s.workspace + "/" + s.id).includes(e))) continue;
      if ((this.attempted.get(s.id) || 0) > Date.now() - 6 * 3600 * 1000) continue;
      const closed = isSessionClosed(s.path, cfg.quietSec === undefined ? 45 : cfg.quietSec);
      if (!closed.ok) continue;
      out.push({ file: s, closed });
    }
    out.sort((a, b) => b.file.size - a.file.size);
    return out;
  }

  levelRank(level) {
    const order = ["ok", "warn", "high", "critical", "emergency"];
    const i = order.indexOf(level);
    return i < 0 ? 0 : i;
  }

  /** Called from the sampler listener on every tick. */
  async tick(sample) {
    const cfg = this.config;
    if (!this.autoEnabled()) return undefined;
    if (this.busy) return undefined;
    const now = Date.now();
    const cooldownMs = (cfg.cooldownMin === undefined ? 10 : cfg.cooldownMin) * 60000;
    if (now - this.lastRunAt < cooldownMs) return undefined;
    this.runTimes = this.runTimes.filter((t) => now - t < 3600000);
    const maxPerHour = cfg.maxPerHour === undefined ? 4 : cfg.maxPerHour;
    if (this.runTimes.length >= maxPerHour) return undefined;
    const trigger = cfg.triggerLevel === undefined ? "warn" : cfg.triggerLevel;
    if (this.levelRank(sample.level) < this.levelRank(trigger)) return undefined;
    if (this.runningAgentCount(sample.agents) > 0) return undefined;
    const candidates = this.candidates(this.sampler.sessionCache(true));
    if (candidates.length === 0) return undefined;
    const pick = candidates[0];
    this.busy = true;
    this.lastRunAt = now;
    this.runTimes.push(now);
    this.attempted.set(pick.file.id, now);
    try {
      const result = await runSlim({
        only: [pick.file.id],
        level: this.configuredLevel(),
        minMB: 0,
        apply: cfg.dryRun !== true,
        exclude: cfg.exclude
      });
      const rows = result.report === undefined ? [] : result.report.rows;
      const ok = result.report === undefined ? [] : result.report.rows.filter((r) => r.status === "ok");
      const totals = result.report === undefined ? undefined : result.report.totals;
      const savedMB = totals === undefined ? 0 : round1(totals.saved / 1048576);
      this.lastResult = {
        at: now,
        sessionId: pick.file.id,
        level: cfg.level,
        dryRun: cfg.dryRun === true,
        ok: result.ok,
        code: result.code,
        savedMB,
        beforeMB: totals === undefined ? undefined : round1(totals.before / 1048576),
        afterMB: totals === undefined ? undefined : round1(totals.after / 1048576),
        backup: result.backup,
        rows: rows.length
      };
      try {
        appendCsv(
          featureDir(FEATURE_ID) + "/slimming.csv",
          ["time", "iso", "session", "level", "dryRun", "ok", "code", "savedMB", "beforeMB", "afterMB", "backup"],
          [now, new Date(now).toISOString(), pick.file.id, cfg.level, cfg.dryRun === true, result.ok, result.code, savedMB, this.lastResult.beforeMB, this.lastResult.afterMB, result.backup]
        );
      } catch { /* best effort */ }
      if (result.ok && ok.length > 0) this.sampler.sessionCache(false);
      if (result.ok) this.sampler.sessionsAt = 0;
      return this.lastResult;
    } catch (error) {
      this.lastResult = { at: now, sessionId: pick.file.id, ok: false, reason: error instanceof Error ? error.message : String(error) };
      return this.lastResult;
    } finally {
      this.busy = false;
    }
  }
}
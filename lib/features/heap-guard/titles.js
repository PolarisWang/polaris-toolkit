/**
 * Feature: Heap Guard · session titles.
 *
 * The panel wants to show the human name of every session (the "session/title"
 * event), not just 8 hex characters. Two very different sources, picked per
 * session so the host heap never pays for the feature that watches it:
 *
 *   live sessions  in-memory via ctx.get("sessionQuery").readTitleSnapshots()
 *                  (cheap, exact; refreshed at most every LIVE_TTL);
 *   on-disk logs   a child process (bin/titles.mjs) that reads a bounded
 *                  head window of the zstd container. Never read a 100 MB
 *                  session inside the host - that is the whole point.
 *
 * Results are cached in memory and in <stateDir>/polaris-toolkit/heap-guard/
 * titles.json, keyed by session id and validated against the file's mtimeMs /
 * sizeMB, so a growing session is re-read only when it actually changed.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { featureDir } from "../../core/paths.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPT = path.join(HERE, "..", "..", "..", "bin", "titles.mjs");

const LIVE_TTL_MS = 5 * 60 * 1000;   // live titles re-read at most this often
const FAIL_TTL_MS = 10 * 60 * 1000;  // a failed scan is not retried immediately
const MAX_CACHE = 800;
const BATCH = 6;                     // ids per child process
const CHILD_TIMEOUT_MS = 30 * 1000;
const OUT_CAP = 512 * 1024;
const QUEUE_CAP = 240;
const GAP_MS = 400;                  // pause between batches (stay responsive)

function nowMs() { return Date.now(); }

/**
 * @param scope feature scope ({ ctx, log, ... })
 * @param options { root?, dir?, script?, headMB?, tailMB? }
 */
export function createTitleStore(scope, options) {
  const opt = options === undefined || options === null ? {} : options;
  const root = typeof opt.root === "string" && opt.root.length > 0 ? opt.root : undefined;
  const dir = typeof opt.dir === "string" && opt.dir.length > 0 ? opt.dir : featureDir("heap-guard");
  const file = path.join(dir, "titles.json");
  const script = typeof opt.script === "string" && opt.script.length > 0 ? opt.script : DEFAULT_SCRIPT;
  const log = (level, message) => { try { scope.log(level, message); } catch { /* logging must never break the feature */ } };

  const cache = new Map();
  const asked = new Map();
  const queue = [];
  const queued = new Set();
  const inflight = new Set();
  let child = null;
  let lastRunAt = 0;
  let lastError;
  let runs = 0;
  let resolvedCount = 0;
  let missingCount = 0;
  let liveAt = 0;
  let liveError;

  /** Read the on-disk cache; entries are kept only if they still look sane. */
  function load() {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
    const items = raw !== null && typeof raw === "object" && raw.items !== null && typeof raw.items === "object" ? raw.items : {};
    for (const key of Object.keys(items)) {
      const v = items[key];
      if (v === null || typeof v !== "object") continue;
      if (v.failed === true || (typeof v.title === "string" && v.title.length > 0)) cache.set(key, v);
    }
    lastError = typeof raw.lastError === "string" ? raw.lastError : undefined;
  }

  /** Atomic write, capped, newest first. Never throws into the caller. */
  function save() {
    try {
      const all = Array.from(cache.entries()).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
      const items = {};
      for (const [key, value] of all.slice(0, MAX_CACHE)) items[key] = value;
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), items }));
      fs.renameSync(tmp, file);
    } catch (error) {
      log("warn", "heap-guard: cannot persist title cache (" + String(error) + ")");
    }
  }

  /** undefined = not cached; { failed:true } = known bad; else a usable entry. */
  function usable(row, at) {
    const e = cache.get(row.id);
    if (e === undefined) return undefined;
    if (e.failed === true) return at - (e.at || 0) < FAIL_TTL_MS ? e : undefined;
    if (typeof e.title !== "string" || e.title.length === 0) return undefined;
    if (e.from === "live") return at - (e.at || 0) < LIVE_TTL_MS ? e : undefined;
    if (typeof row.mtimeMs === "number" && row.mtimeMs === e.mtimeMs && row.sizeMB === e.sizeMB) return e;
    return undefined;
  }

  /** Decorate rows (adds title / titleFrom) and queue whatever is missing. */
  function attach(rows) {
    const at = nowMs();
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row === null || typeof row !== "object" || typeof row.id !== "string") continue;
        const e = usable(row, at);
        if (e !== undefined && typeof e.title === "string") {
          row.title = e.title;
          row.titleFrom = e.from;
          continue;
        }
        row.titleFrom = e !== undefined && e.failed === true ? "failed" : "pending";
        if (e !== undefined) continue;
        if (queued.has(row.id) || inflight.has(row.id)) continue;
        asked.set(row.id, { mtimeMs: row.mtimeMs, sizeMB: row.sizeMB, at });
        queued.add(row.id);
        queue.push(row.id);
        if (queue.length > QUEUE_CAP) {
          for (const dropped of queue.splice(0, queue.length - QUEUE_CAP)) queued.delete(dropped);
        }
      }
    }
    return summary();
  }

  async function runChild(ids) {
    const args = [script, "--head-mb", String(opt.headMB === undefined ? 3 : opt.headMB), "--tail-mb", String(opt.tailMB === undefined ? 1 : opt.tailMB), "--max-frames", "4000"];
    if (root !== undefined) args.push("--sessions", root);
    for (const id of ids) args.push("--only", id);
    return await new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(process.execPath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        lastError = String(error);
        return resolve(undefined);
      }
      child = proc;
      let out = "";
      let err = "";
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (child === proc) child = null;
        resolve(value);
      };
      const timer = setTimeout(() => {
        lastError = "title scan timed out after " + CHILD_TIMEOUT_MS + " ms";
        try { proc.kill(); } catch { /* already gone */ }
        finish(undefined);
      }, CHILD_TIMEOUT_MS);
      proc.stdout.on("data", (chunk) => {
        out += chunk.toString("utf8");
        if (out.length > OUT_CAP) {
          out = out.slice(0, OUT_CAP);
          try { proc.kill(); } catch { /* already gone */ }
        }
      });
      proc.stderr.on("data", (chunk) => { err = (err + chunk.toString("utf8")).slice(-4000); });
      proc.on("error", (error) => { lastError = String(error); finish(undefined); });
      proc.on("close", (code) => {
        if (code !== 0) lastError = "title scan exit " + code + (err.length > 0 ? ": " + err.slice(-400) : "");
        const at = out.indexOf("{");
        if (at < 0) {
          if (code === 0) lastError = "title scan produced no JSON";
          return finish(undefined);
        }
        try { finish(JSON.parse(out.slice(at))); } catch (error) { lastError = String(error); finish(undefined); }
      });
    });
  }

  async function runQueue() {
    if (child !== null || queue.length === 0) return;
    const ids = queue.splice(0, BATCH);
    for (const id of ids) { queued.delete(id); inflight.add(id); }
    lastRunAt = nowMs();
    const payload = await runChild(ids);
    for (const id of ids) inflight.delete(id);
    runs += 1;
    const at = nowMs();
    for (const id of ids) {
      const hit = payload === undefined || payload.titles === undefined ? undefined : payload.titles[id];
      const meta = asked.get(id) === undefined ? {} : asked.get(id);
      if (hit !== undefined && typeof hit.title === "string" && hit.title.length > 0) {
        cache.set(id, { title: hit.title, from: hit.from, source: hit.source, mtimeMs: meta.mtimeMs, sizeMB: meta.sizeMB, matched: hit.matched, at });
        resolvedCount += 1;
        continue;
      }
      const why = payload !== undefined && payload.errors !== undefined && payload.errors[id] !== undefined ? payload.errors[id] : undefined;
      if (why !== undefined) lastError = "title scan " + id + ": " + why;
      else missingCount += 1;
      cache.set(id, { failed: true, at, reason: why === undefined ? "no title event in the scanned window" : why });
    }
    save();
    if (queue.length > 0) setTimeout(() => { void runQueue(); }, GAP_MS);
  }

  /** Live sessions carry their title in memory; on-disk ones must be scanned. */
  async function refreshLive() {
    if (child !== null) return;
    const ctx = scope.ctx;
    const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
    const query = typeof ctx.get === "function" ? ctx.get("sessionQuery") : undefined;
    if (sessions === undefined || query === undefined) return;
    if (typeof sessions.list !== "function" || typeof query.readTitleSnapshots !== "function") return;
    liveAt = nowMs();
    let list = [];
    try { list = sessions.list() || []; } catch (error) { liveError = String(error); return; }
    const ids = [];
    for (const s of list) {
      const id = s === null || s === undefined ? undefined : s.id;
      if (typeof id === "string" && id.length > 0 && ids.indexOf(id) < 0) ids.push(id);
      if (ids.length >= 40) break;
    }
    if (ids.length === 0) return;
    try {
      const settled = await query.readTitleSnapshots(ids);
      const arr = Array.isArray(settled) ? settled : [];
      const at = nowMs();
      for (let i = 0; i < ids.length; i += 1) {
        const item = arr[i];
        const value = item !== undefined && item !== null && item.status === "fulfilled" ? item.value : undefined;
        let title = value === undefined ? undefined : value.title;
        if (title !== null && typeof title === "object") title = title.title;
        if (typeof title === "string" && title.trim().length > 0) cache.set(ids[i], { title: title.trim(), from: "live", at });
      }
      save();
    } catch (error) {
      liveError = String(error);
    }
  }

  /** Called from the sampling tick and from the sessions route; never rejects. */
  async function tick() {
    if (queue.length > 0 && child === null && nowMs() - lastRunAt > 1000) await runQueue();
    if (nowMs() - liveAt > LIVE_TTL_MS && child === null) await refreshLive();
  }

  /** Drop cached titles (all, or just the given ids) and re-queue them. */
  function force(ids) {
    const list = Array.isArray(ids) && ids.length > 0 ? ids.map(String) : Array.from(cache.keys());
    let dropped = 0;
    for (const id of list) {
      if (cache.delete(id)) dropped += 1;
      queued.delete(id);
    }
    liveAt = 0;
    const gone = list.filter((id) => !queued.has(id) && !inflight.has(id));
    for (const id of gone.slice(0, QUEUE_CAP)) { queued.add(id); queue.push(id); }
    const summaryOut = summary();
    summaryOut.dropped = dropped;
    return summaryOut;
  }

  function entries() {
    const out = [];
    for (const [id, e] of cache) {
      if (typeof e.title !== "string" || e.title.length === 0) continue;
      out.push({ id, title: e.title, from: e.from, source: e.source, at: e.at || 0 });
    }
    out.sort((a, b) => b.at - a.at);
    return out;
  }

  function summary() {
    let known = 0;
    let failed = 0;
    for (const e of cache.values()) {
      if (typeof e.title === "string" && e.title.length > 0) known += 1;
      else if (e.failed === true) failed += 1;
    }
    return {
      known,
      failed,
      cached: cache.size,
      queued: queue.length,
      inflight: inflight.size,
      scanning: child !== null,
      runs,
      resolved: resolvedCount,
      missing: missingCount,
      live: liveAt > 0,
      lastRunAt: lastRunAt === 0 ? undefined : lastRunAt,
      lastError: lastError === undefined ? liveError : lastError,
      cacheFile: file,
      script
    };
  }

  function dispose() {
    const proc = child;
    child = null;
    if (proc !== null) { try { proc.kill(); } catch { /* already gone */ } }
    save();
  }

  load();
  return { attach, tick, force, entries, summary, dispose, file };
}

export default { createTitleStore };

/**
 * Manual V8 heap snapshots (no automatic capture: a snapshot costs both time and
 * a copy of the heap on disk).
 */
const FEATURE_ID = "heap-guard";

import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import { ensureDir, mb, round1, stamp, featureDir } from "../../core/paths.js";
import { freeDiskMB } from "./sampler.js";

export function snapshotDir() {
  return ensureDir(path.join(featureDir(FEATURE_ID), "snapshots"));
}

export function listSnapshots() {
  const dir = snapshotDir();
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of entries) {
    if (!name.endsWith(".heapsnapshot")) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      out.push({ name, path: file, sizeMB: round1(st.size / 1048576), mtimeMs: st.mtimeMs });
    } catch { /* vanished */ }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Write one heap snapshot and rotate old ones.
 * options: { minFreeGB (default 5), keep (default 2), label }
 */
export function writeHeapSnapshot(options) {
  const o = options === undefined ? {} : options;
  const minFreeGB = o.minFreeGB === undefined ? 5 : o.minFreeGB;
  const keep = o.keep === undefined ? 2 : o.keep;
  const dir = snapshotDir();
  const freeMB = freeDiskMB(dir);
  if (freeMB !== undefined && freeMB < minFreeGB * 1024) {
    return { ok: false, reason: "low-disk", freeMB, minFreeGB };
  }
  const name = "heap-" + stamp() + "-pid" + process.pid + (o.label === undefined ? "" : "-" + o.label) + ".heapsnapshot";
  const file = path.join(dir, name);
  const startedAt = Date.now();
  const before = listSnapshots();
  let written;
  try {
    written = v8.writeHeapSnapshot(file);
  } catch (error) {
    return { ok: false, reason: "write-failed", error: error instanceof Error ? error.message : String(error) };
  }
  const st = fs.statSync(written === undefined ? file : written);
  const rotated = [];
  const after = listSnapshots();
  for (let i = keep; i < after.length; i += 1) {
    try { fs.unlinkSync(after[i].path); rotated.push(after[i].name); } catch { /* keep */ }
  }
  return {
    ok: true,
    path: written === undefined ? file : written,
    sizeMB: round1(st.size / 1048576),
    tookSec: round1((Date.now() - startedAt) / 1000),
    freeBeforeMB: freeMB,
    rotated,
    previous: before.slice(0, 3).map((s) => s.name)
  };
}
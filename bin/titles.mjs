#!/usr/bin/env node
/**
 * polaris-toolkit · Heap Guard · session title scan (child process)
 *
 * A DSH session log is a concatenated-zstd JSONL file. The human-readable name
 * lives in a `session/title` event (data.title). Reading a 100 MB log inside
 * the host would balloon the heap it is supposed to watch, so the scan runs in
 * a separate process and prints exactly one JSON blob on stdout:
 *
 *   { ok, root, scanned, ms, titles: { <requested id>: { title, from, frames, seq, source, matched } }, missing: [], errors: {} }
 *
 * A session writes TWO title events as it opens: a mechanical "fallback" title
 * (the first human message, cut to ~40 bytes) and, a moment later, the real one
 * from the title provider (source "provider" / "user"). The panel wants the real
 * one, so the head window is walked up to --head-frames frames and the LAST seen
 * event wins (highest seq); if only a fallback was found, the walk continues up
 * to --max-frames looking for a non-fallback event. Only when the head window
 * yields nothing does the LAST --tail-mb MB get scanned (late rename).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFrameEnd, decodeFrame } from "../lib/core/zstd.js";

const SESSION_FILE = "session.v4.jsonl.zstd";
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function home(root) {
  if (typeof root === "string" && root.length > 0) return path.resolve(root);
  const env = process.env.DSH_HOME || process.env.DSH_DATA_HOME;
  return env === undefined || env.length === 0 ? path.join(os.homedir(), ".dsh", "sessions") : path.join(env, "sessions");
}

function parseArgs(argv) {
  const o = { sessionsRoot: home(), only: [], headMB: 3, tailMB: 1, headFrames: 96, maxFrames: 4000, max: 40, out: undefined, all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(a + " needs a value");
      i += 1;
      return v;
    };
    if (a === "--sessions") o.sessionsRoot = path.resolve(val());
    else if (a === "--only") o.only.push(val());
    else if (a === "--head-mb") o.headMB = Math.max(0, Number(val()));
    else if (a === "--tail-mb") o.tailMB = Math.max(0, Number(val()));
    else if (a === "--head-frames") o.headFrames = Math.max(4, Number(val()));
    else if (a === "--max-frames") o.maxFrames = Math.max(8, Number(val()));
    else if (a === "--max") o.max = Math.max(1, Number(val()));
    else if (a === "--out") o.out = path.resolve(val());
    else if (a === "--all") o.all = true;
    else throw new Error("unknown argument " + a);
  }
  return o;
}

function readRange(file, start, length) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, length));
    const read = fs.readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/** A `session/title` JSONL line -> { title, seq, source }, or undefined. */
function titleRecOfLine(line) {
  if (line.indexOf("session/title") < 0) return undefined;
  const at = line.indexOf("{");
  if (at < 0) return undefined;
  let rec;
  try { rec = JSON.parse(line.slice(at)); } catch { return undefined; }
  if (rec === null || typeof rec !== "object" || rec.type !== "session/title") return undefined;
  const d = rec.data === undefined ? undefined : rec.data;
  let t = d === undefined ? undefined : (d.title === undefined ? d.name : d.title);
  if (t !== null && typeof t === "object") t = t.title;
  if (typeof t !== "string" || t.trim().length === 0) return undefined;
  const kind = d !== undefined && d.source !== undefined && typeof d.source.kind === "string" ? d.source.kind : undefined;
  return { title: t.trim(), seq: typeof rec.seq === "number" ? rec.seq : undefined, source: kind };
}

function rank(rec) {
  return rec !== undefined && typeof rec.seq === "number" ? rec.seq : -1;
}

/** Walk frames from off; keeps the highest-seq title event. stopOn may end early. */
function scanWindow(buf, off, opts, stopOn) {
  let at = off < 0 ? 0 : off;
  let best;
  let frames = 0;
  let done = false;
  while (!done && at < buf.length && frames < opts.maxFrames) {
    let end;
    try { end = parseFrameEnd(buf, at); } catch { break; }
    let text;
    try { text = decodeFrame(buf, [at, end]).toString("utf8"); } catch { text = undefined; }
    frames += 1;
    if (text !== undefined) {
      for (const line of text.split("\n")) {
        const rec = titleRecOfLine(line);
        if (rec === undefined) continue;
        if (best === undefined || rank(rec) >= rank(best)) best = rec;
        if (stopOn !== undefined && best !== undefined && stopOn(best)) { done = true; break; }
      }
    }
    at = end;
  }
  return best === undefined ? undefined : { title: best.title, seq: best.seq, source: best.source, frames };
}

/** Real title beats the truncated fallback; a late event beats an early one. */
function scanFile(file, opts) {
  const size = fs.statSync(file).size;
  const head = Math.min(size, Math.max(0, opts.headMB) * 1048576);
  if (head > 0) {
    const buf = readRange(file, 0, head);
    const off = buf.indexOf(MAGIC);
    if (off >= 0) {
      const quick = scanWindow(buf, off, { maxFrames: Math.min(opts.maxFrames, opts.headFrames) });
      if (quick !== undefined && quick.source !== "fallback") return { ...quick, from: "head" };
      const deep = scanWindow(buf, off, { maxFrames: opts.maxFrames }, (rec) => rec.source !== "fallback");
      const pick = deep !== undefined && deep.source !== "fallback" ? deep : quick !== undefined ? quick : deep;
      if (pick !== undefined) return { ...pick, from: "head" };
    }
  }
  const tail = Math.max(0, opts.tailMB) * 1048576;
  if (tail > 0 && size > 0) {
    const start = Math.max(0, size - tail);
    const buf = readRange(file, start, size - start);
    const off = buf.lastIndexOf(MAGIC);
    if (off >= 0) {
      const hit = scanWindow(buf, off, { maxFrames: opts.maxFrames });
      if (hit !== undefined) return { ...hit, from: "tail" };
    }
  }
  return undefined;
}

function walkFiles(root) {
  const out = [];
  let workspaces = [];
  try { workspaces = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(root, ws.name);
    let dirs = [];
    try { dirs = fs.readdirSync(wsDir, { withFileTypes: true }); } catch { continue; }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const file = path.join(wsDir, dir.name, SESSION_FILE);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      out.push({ id: dir.name.startsWith("session-") ? dir.name.slice(8) : dir.name, workspace: ws.name, path: file, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function main() {
  const started = Date.now();
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }));
    return 0;
  }
  const files = walkFiles(opts.sessionsRoot);
  const titles = {};
  const missing = [];
  const errors = {};
  let scanned = 0;
  const wanted = opts.only.length > 0 ? opts.only : files.slice(0, opts.max).map((f) => f.id);
  for (const want of wanted) {
    const exact = files.filter((f) => f.id === want)[0];
    const prefix = exact === undefined ? files.filter((f) => f.id.startsWith(want)) : [];
    const file = exact !== undefined ? exact : prefix.length === 1 ? prefix[0] : undefined;
    if (file === undefined) {
      missing.push(want);
      if (prefix.length > 1) errors[want] = "ambiguous id (" + prefix.length + " matches)";
      continue;
    }
    scanned += 1;
    try {
      const hit = scanFile(file.path, opts);
      if (hit === undefined) missing.push(want);
      else titles[want] = { title: hit.title, from: hit.from, frames: hit.frames, seq: hit.seq, source: hit.source, matched: file.id };
    } catch (error) {
      errors[want] = String(error && error.message ? error.message : error);
    }
    if (scanned >= opts.max * 4) break;
  }
  const payload = { ok: true, root: opts.sessionsRoot, scanned, ms: Date.now() - started, titles, missing, errors };
  const text = JSON.stringify(payload);
  if (opts.out !== undefined) {
    try { fs.mkdirSync(path.dirname(opts.out), { recursive: true }); fs.writeFileSync(opts.out, text); } catch { /* stdout is the contract */ }
  }
  process.stdout.write(text);
  return 0;
}

process.exitCode = main();

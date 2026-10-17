#!/usr/bin/env node
/**
 * slim-dsh-sessions.mjs - repack (and optionally trim) DSH session containers.
 *
 * Target: <sessionsRoot>\<workspace>\<session-id>\session.v4.jsonl.zstd
 * That file is a *concatenated-frame* zstd container: DSH appends ~16 KB of plaintext
 * as an independently compressed zstd frame, so cross-frame redundancy is never used.
 * Re-packing the same records into ~1 MB frames shrinks a file to ~65-75% with zero
 * information loss.
 *
 * Levels
 *   1  repack only. LOSSLESS: the JSONL plaintext is byte-identical to the original.
 *   2  + drop stream *delta* entries (reasoning-chunks / tool-call-chunks / text-chunks)
 *        from assistant/message|assistant/attempt data.stream, KEEPING every
 *        type:"chunk" entry (block-end / block-start / finish / usage) so DSH's
 *        assistantStreamChunks(stream,"block-end") and streamUsage(stream) still work.
 *        data.stream stays an Array and the record count is unchanged.
 *   3  + cap tool output text (tool/ptc-dispatch data.content[].text,
 *        tool/result data.message.content[].text); default 1 KB / 2 KB.
 *        A "... [trimmed N chars by session-slim]" marker is appended.
 *
 * Safety
 *   - dry-run unless --apply; records are never reordered, merged or deleted
 *   - files newer than --older-than-hours (default 24) are skipped (a live session!)
 *   - every rewritten file is copied into --backup first; --restore <dir> puts them back
 *   - after writing, the new container is re-read: frame structure is walked and the
 *     record count must match, otherwise the original is left untouched
 *
 * Usage
 *   node slim-dsh-sessions.mjs                        # dry-run, level 3, report only
 *   node slim-dsh-sessions.mjs --level 1              # dry-run, lossless repack only
 *   node slim-dsh-sessions.mjs --min-mb 10            # only sessions >= 10 MB
 *   node slim-dsh-sessions.mjs --apply --level 2      # DO IT (close DSH first!)
 *   node slim-dsh-sessions.mjs --restore "<backupDir>"  # undo
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const ZSTD_MAGIC = 0xfd2fb528;
const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = "session.v4.jsonl.zstd";

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const o = {
    apply: false, level: 3, sessionsRoot: path.join(os.homedir(), ".dsh", "sessions"),
    backup: null, restore: null, minMB: 1, olderHours: 24, only: [], exclude: [],
    ptcCap: 1024, resultCap: 2048, groupBytes: 1 << 20, manifest: null, json: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => { const v = argv[i + 1]; if (v === undefined || v.startsWith("--")) throw new Error(a + " needs a value"); i += 1; return v; };
    if (a === "--apply") o.apply = true;
    else if (a === "--level") o.level = Math.max(1, Math.min(3, Number(val())));
    else if (a === "--sessions") o.sessionsRoot = path.resolve(val());
    else if (a === "--backup") o.backup = path.resolve(val());
    else if (a === "--restore") o.restore = path.resolve(val());
    else if (a === "--min-mb") o.minMB = Number(val());
    else if (a === "--older-than-hours") o.olderHours = Number(val());
    else if (a === "--only") o.only.push(val());
    else if (a === "--exclude") o.exclude.push(val());
    else if (a === "--ptc-cap") o.ptcCap = Number(val());
    else if (a === "--result-cap") o.resultCap = Number(val());
    else if (a === "--group-kb") o.groupBytes = Number(val()) * 1024;
    else if (a === "--manifest") o.manifest = path.resolve(val());
    else if (a === "--json") o.json = path.resolve(val());
    else if (a === "--help" || a === "-h") { console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]); process.exit(0); }
    else throw new Error("unknown option " + a);
  }
  if (!o.backup) o.backup = path.join(os.homedir(), ".dsh", "backups", "slim-" + stamp());
  if (!o.manifest) o.manifest = path.join(HERE, "slim-manifest-" + stamp() + ".csv");
  return o;
}
function stamp() { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
const mb = (n) => (n / 1048576).toFixed(1);

// ------------------------------------------------------- zstd frame walk
/** Byte offset just past the frame starting at off, without decompressing it. */
function parseFrameEnd(b, off) {
  if (off + 5 > b.length || b.readUInt32LE(off) !== ZSTD_MAGIC) throw new Error("bad zstd magic at " + off);
  const fhd = b[off + 4];
  const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
  let p = off + 5;
  if (!single) p += 1;
  p += dictFlag === 0 ? 0 : dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : 4;
  p += fcsFlag === 0 ? (single ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
  for (;;) {
    if (p + 3 > b.length) throw new Error("truncated block header at " + p);
    const h = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16); p += 3;
    const last = h & 1, type = (h >> 1) & 3, size = h >>> 3;
    if (type === 3) throw new Error("reserved block type at " + (p - 3));
    if (type === 0 || type === 2) p += size; else p += 1; // 1 = RLE
    if (p > b.length) throw new Error("truncated block payload");
    if (last) break;
  }
  if (checksum) p += 4;
  if (p > b.length) throw new Error("truncated frame checksum");
  return p;
}
function frameSlices(b) { const out = []; let off = 0; while (off < b.length) { const end = parseFrameEnd(b, off); out.push([off, end]); off = end; } return out; }

// --------------------------------------------------------------- trimming
function arrayOf(x) { return Array.isArray(x) ? x : []; }
function capText(container, cap, marker, bump) {
  let changed = false;
  if (typeof container === "string") { if (container.length > cap) { bump(); changed = true; return container.slice(0, cap) + marker; } return container; }
  for (const b of arrayOf(container)) {
    if (b && typeof b.text === "string" && b.text.length > cap) { bump(); b.text = b.text.slice(0, cap) + marker; changed = true; }
  }
  return container;
}
function trimLine(line, opts, stats) {
  if (opts.level < 2) return line;
  let o; try { o = JSON.parse(line); } catch { stats.jsonErrors += 1; return line; }
  let changed = false;
  const t = o.type;
  if ((t === "assistant/message" || t === "assistant/attempt") && Array.isArray(o.data && o.data.stream)) {
    const stream = o.data.stream, kept = [];
    for (const e of stream) { if (e && e.type === "chunk") kept.push(e); else stats.streamEntriesDropped += 1; }
    if (kept.length !== stream.length) { o.data.stream = kept; changed = true; }
  }
  if (opts.level >= 3) {
    if (t === "tool/ptc-dispatch" && o.data) {
      const before = JSON.stringify(o.data.content).length;
      o.data.content = capText(o.data.content, opts.ptcCap, "\n[trimmed " + before + "-byte tool output by session-slim]", () => { stats.cappedPtc += 1; });
      if (JSON.stringify(o.data.content).length !== before) changed = true;
    }
    if (t === "tool/result" && o.data && o.data.message) {
      const before = JSON.stringify(o.data.message.content).length;
      o.data.message.content = capText(o.data.message.content, opts.resultCap, "\n[trimmed tool result by session-slim]", () => { stats.cappedResult += 1; });
      if (JSON.stringify(o.data.message.content).length !== before) changed = true;
    }
  }
  return changed ? JSON.stringify(o) : line;
}

// ------------------------------------------------------------------- sink
function makeSink(outPath) {
  if (!outPath) { const s = { bytes: 0 }; s.write = async (b) => { s.bytes += b.length; }; s.end = async () => s.bytes; return s; }
  const ws = fs.createWriteStream(outPath);
  const s = { bytes: 0 };
  s.write = async (b) => { s.bytes += b.length; if (!ws.write(b)) await once(ws, "drain"); };
  s.end = async () => { ws.end(); await once(ws, "finish"); return s.bytes; };
  return s;
}

// -------------------------------------------------------------- per file
async function processFile(file, opts) {
  const buf = fs.readFileSync(file);
  let slices; try { slices = frameSlices(buf); } catch (e) { return { status: "structure-error: " + e.message, before: buf.length, after: buf.length, frames: 0, records: 0 }; }
  const stats = { records: 0, streamEntriesDropped: 0, cappedPtc: 0, cappedResult: 0, jsonErrors: 0, groups: 0 };
  const tmp = file + ".slimtmp";
  const sink = makeSink(opts.apply ? tmp : null);
  const flush = async (group, len) => { if (!len) return; stats.groups += 1; await sink.write(zlib.zstdCompressSync(Buffer.concat(group), CHECKSUM_OPTIONS)); group.length = 0; };
  const group = []; let groupLen = 0; let first = true;
  const onLine = async (line) => {
    if (!line.length) return;
    stats.records += 1;
    const b = Buffer.from(trimLine(line, opts, stats) + "\n", "utf8");
    group.push(b); groupLen += b.length;
    if (first) { first = false; await flush(group, groupLen); groupLen = 0; return; }
    if (groupLen >= opts.groupBytes) { await flush(group, groupLen); groupLen = 0; }
  };
  let rem = Buffer.alloc(0);
  try {
    for (const [a, b] of slices) {
      const plain = zlib.zstdDecompressSync(buf.subarray(a, b));
      rem = rem.length ? Buffer.concat([rem, plain]) : plain;
      let nl;
      while ((nl = rem.indexOf(10)) >= 0) { const line = rem.subarray(0, nl).toString("utf8"); rem = rem.subarray(nl + 1); await onLine(line); }
    }
  } catch (e) { sink.end(); safeUnlink(tmp); return { status: "decompress-error: " + e.message, before: buf.length, after: buf.length, frames: slices.length, records: stats.records }; }
  if (rem.length) await onLine(rem.toString("utf8"));
  await flush(group, groupLen);
  const bytesOut = await sink.end();

  let verified = stats.records;
  if (opts.apply) {
    try { verified = countRecords(tmp); } catch (e) { safeUnlink(tmp); return { status: "verify-error: " + e.message, before: buf.length, after: bytesOut, frames: slices.length, records: stats.records }; }
    if (verified !== stats.records) { safeUnlink(tmp); return { status: "verify-mismatch " + verified + "!=" + stats.records, before: buf.length, after: bytesOut, frames: slices.length, records: stats.records }; }
    const rel = path.relative(opts.sessionsRoot, file);
    const backupPath = path.join(opts.backup, rel);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(file, backupPath);
    fs.renameSync(tmp, file);
  }
  return { status: "ok", before: buf.length, after: bytesOut, frames: slices.length, records: stats.records, verified, backup: opts.apply ? path.relative(opts.sessionsRoot, file) : "", ...stats };
}
function countRecords(file) {
  const buf = fs.readFileSync(file);
  let n = 0, rem = Buffer.alloc(0);
  for (const [a, b] of frameSlices(buf)) {
    const plain = zlib.zstdDecompressSync(buf.subarray(a, b));
    rem = rem.length ? Buffer.concat([rem, plain]) : plain;
    let nl; while ((nl = rem.indexOf(10)) >= 0) { rem = rem.subarray(nl + 1); n += 1; }
  }
  if (rem.length) n += 1;
  return n;
}
function safeUnlink(p) { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ } }

// ------------------------------------------------------------- enumerate
function findSessions(root) {
  const out = [];
  (function walk(d, depth) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 4 && !/archived/i.test(e.name)) walk(p, depth + 1); }
      else if (e.name === SESSION_FILE) out.push(p);
    }
  })(root, 0);
  return out;
}
function restoreFrom(backupDir, sessionsRoot) {
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === SESSION_FILE) files.push(p); } })(backupDir);
  let n = 0;
  for (const f of files) { const target = path.join(sessionsRoot, path.relative(backupDir, f)); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(f, target); n += 1; }
  console.log("restored " + n + " file(s) from " + backupDir);
}

// ------------------------------------------------------------------- main
const opts = parseArgs(process.argv.slice(2));
if (opts.restore) { restoreFrom(opts.restore, opts.sessionsRoot); process.exit(0); }

const now = Date.now();
const rows = [];
for (const file of findSessions(opts.sessionsRoot)) {
  const rel = path.relative(opts.sessionsRoot, file);
  const st = fs.statSync(file);
  const ageH = (now - st.mtimeMs) / 3600000;
  const skip = (why) => rows.push({ session: path.basename(path.dirname(file)), workspace: rel.split(path.sep)[0], file, before: st.size, after: st.size, records: 0, status: "skipped: " + why, saved: 0 });
  if (st.size < opts.minMB * 1048576) { skip("smaller than " + opts.minMB + " MB"); continue; }
  if (ageH < opts.olderHours) { skip("modified " + ageH.toFixed(1) + "h ago (< " + opts.olderHours + "h)"); continue; }
  if (opts.only.length && !opts.only.some((s) => rel.includes(s))) { skip("not in --only"); continue; }
  if (opts.exclude.some((s) => rel.includes(s))) { skip("--exclude"); continue; }
  process.stderr.write((opts.apply ? "apply " : "scan  ") + mb(st.size) + " MB  " + rel + "\r\n");
  const r = await processFile(file, opts);
  rows.push({ session: path.basename(path.dirname(file)), workspace: rel.split(path.sep)[0], file, ...r, saved: r.before - r.after });
}

const done = rows.filter((r) => r.status === "ok");
const totalBefore = done.reduce((a, r) => a + r.before, 0), totalAfter = done.reduce((a, r) => a + r.after, 0);
done.sort((a, b) => b.saved - a.saved);
console.log("\n" + (opts.apply ? "APPLIED" : "DRY-RUN") + "  level " + opts.level + "  (backups: " + opts.backup + ")\n");
console.log("saved    before   after   records  dropped  capped   session / workspace");
for (const r of done) console.log(String(mb(r.saved)).padStart(6) + "  " + mb(r.before).padStart(7) + " " + mb(r.after).padStart(7) + " " + String(r.records).padStart(8) + " " + String(r.streamEntriesDropped || 0).padStart(8) + " " + String((r.cappedPtc || 0) + (r.cappedResult || 0)).padStart(7) + "   " + r.session + "  " + r.workspace);
const bad = rows.filter((r) => r.status !== "ok" && !r.status.startsWith("skipped"));
for (const r of bad) console.log("!! " + r.status + "  " + r.file);
console.log("\nfiles rewritten: " + done.length + "   " + mb(totalBefore) + " MB -> " + mb(totalAfter) + " MB   saved " + mb(totalBefore - totalAfter) + " MB (" + (totalBefore ? (100 * (totalBefore - totalAfter) / totalBefore).toFixed(1) : "0") + "%)");

const csv = ["RunAt,Mode,Level,Session,Workspace,BeforeBytes,AfterBytes,SavedBytes,Records,StreamEntriesDropped,CappedPtc,CappedResult,Status,Backup"];
for (const r of rows) csv.push([new Date().toISOString(), opts.apply ? "apply" : "dry-run", opts.level, r.session, r.workspace, r.before, r.after, r.saved || 0, r.records || 0, r.streamEntriesDropped || 0, r.cappedPtc || 0, r.cappedResult || 0, JSON.stringify(r.status), JSON.stringify(r.backup || "")].join(","));
fs.writeFileSync(opts.manifest, csv.join("\n") + "\n");
fs.writeFileSync(opts.json || opts.manifest.replace(/\.csv$/, ".json"), JSON.stringify({ runAt: new Date().toISOString(), apply: opts.apply, level: opts.level, sessionsRoot: opts.sessionsRoot, backup: opts.backup, totals: { before: totalBefore, after: totalAfter, saved: totalBefore - totalAfter, files: done.length }, rows }, null, 1));
console.log("manifest: " + opts.manifest);

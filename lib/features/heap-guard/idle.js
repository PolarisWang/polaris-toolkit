/**
 * Session file discovery and "is this session at a safe point" detection.
 *
 * Safe point = the newest STRUCTURAL record of a session is a turn/end. The
 * check decodes only a tail of each file (the last few zstd frames), so it is
 * cheap enough to run every sampling tick.
 */
import fs from "node:fs";
import path from "node:path";
import { readTailFrames } from "../../core/zstd.js";
import { sessionsRoot } from "../../core/paths.js";

/** Record types that say nothing about whether an agent is mid-turn. */
export const HARMLESS_TYPES = new Set([
  "session",
  "session/title",
  "session/title-llm-request",
  "session/end-seed",
  "request/header",
  "request/context",
  "system/message",
  "todo/write",
  "deliverables/presented",
  "goal/change",
  "permission/preset",
  "sandbox/mode",
  "approval/policy"
]);

/** Every session.v4.jsonl.zstd under the sessions root, with id/ws/size/mtime. */
export function listSessionFiles(root) {
  const base = root === undefined ? sessionsRoot() : root;
  const out = [];
  let workspaces = [];
  try { workspaces = fs.readdirSync(base, { withFileTypes: true }); } catch { return out; }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(base, ws.name);
    let dirs = [];
    try { dirs = fs.readdirSync(wsDir, { withFileTypes: true }); } catch { continue; }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const file = path.join(wsDir, dir.name, "session.v4.jsonl.zstd");
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      const m = /^session-(.+)\.jsonl\.zstd$/.exec(dir.name + ".jsonl.zstd");
      let id = dir.name.startsWith("session-") ? dir.name.slice(8) : dir.name;
      if (m !== null && m.length > 1) id = m[1];
      out.push({ id, workspace: ws.name, path: file, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  out.sort((a, b) => b.size - a.size);
  return out;
}

export function findSessionFile(sessionId, root) {
  const all = listSessionFiles(root);
  for (const f of all) if (f.id === sessionId) return f;
  for (const f of all) if (f.id.startsWith(sessionId)) return f;
  return undefined;
}

function tsOf(rec) {
  const t = rec.timestamp === undefined ? rec.ts : rec.timestamp;
  return typeof t === "number" ? t : undefined;
}

export function typeOf(rec) {
  return typeof rec.type === "string" ? rec.type : "";
}

/**
 * Newest structural record of a session file.
 * Returns { type, ts, ageMs, closed } or undefined when unreadable.
 */
export function newestStructural(file, frames) {
  const count = frames === undefined ? 6 : frames;
  let bufs;
  try { bufs = readTailFrames(file, count); } catch { return undefined; }
  if (bufs.length === 0) return undefined;
  const recs = [];
  for (const buf of bufs) {
    const text = buf.toString("utf8");
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (s.length === 0 || s[0] !== "{") continue;
      try { recs.push(JSON.parse(s)); } catch { /* torn tail line */ }
    }
  }
  for (let i = recs.length - 1; i >= 0; i--) {
    const rec = recs[i];
    const type = typeOf(rec);
    if (type.length === 0) continue;
    if (HARMLESS_TYPES.has(type)) continue;
    const ts = tsOf(rec);
    return {
      type,
      ts,
      ageMs: ts === undefined ? undefined : Date.now() - ts,
      closed: type === "turn/end"
    };
  }
  return undefined;
}

/**
 * Safe to touch this session file?
 * Closed at turn/end AND (when quietSec is set) that turn ended long enough ago.
 */
export function isSessionClosed(file, quietSec) {
  const ns = newestStructural(file);
  if (ns === undefined) return { ok: false, reason: "unreadable" };
  if (!ns.closed) return { ok: false, reason: "open:" + ns.type, last: ns };
  if (quietSec !== undefined && ns.ageMs !== undefined && ns.ageMs < quietSec * 1000) {
    return { ok: false, reason: "recent-turn-end", last: ns };
  }
  return { ok: true, reason: "turn/end", last: ns };
}
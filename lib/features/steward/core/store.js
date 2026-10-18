/**
 * Steward: 内存态观察账本 + 追加式 journal。
 *
 * 设计约束（见 docs/steward-design.md 第 5 章）：
 *   - 事件先写 journal（可重建），内存索引只是投影，坏了可以丢；
 *   - journal 按天滚动，写盘攒批（每 2 秒或 256 KB 一次），不阻塞事件回调；
 *   - 一切写入都必须吞异常：总管自身绝不能把宿主拖挂。
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../../../core/paths.js";

const MAX_SIGNALS = 400;
const MAX_ACTIONS = 400;
const FLUSH_BYTES = 256 * 1024;
const SIGNAL_COOLDOWN_MS = 60_000;
const RECENT_MAX = 300;

function ymd(now) {
  const d = new Date(now);
  return String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}

export function createStore({ dir, log }) {
  ensureDir(dir);
  const agents = new Map();
  const signals = [];
  const actions = [];
  const counters = { events: 0, statusChanges: 0, errors: 0, created: 0, disposed: 0, subagents: 0, userTurns: 0 };
  const pending = [];
  let pendingBytes = 0;
  let journalFile = "";
  let journalBytes = 0;
  let seq = 0;
  let lastFlush = 0;
  const signalIndex = new Map();
  // 近期条目环：面板增量拉取（GET /api/journal?since=）只读这里，不碰磁盘。
  const recent = [];

  function roll(now) {
    const next = path.join(dir, "journal-" + ymd(now) + ".jsonl");
    if (next === journalFile) return;
    flush(now);
    journalFile = next;
    try { journalBytes = fs.statSync(next).size; } catch { journalBytes = 0; }
  }

  function append(type, data, now) {
    const t = now === undefined ? Date.now() : now;
    roll(t);
    const entry = { t, seq: ++seq, type, data };
    const line = JSON.stringify(entry) + "\n";
    pending.push(line);
    pendingBytes += line.length;
    counters.events += 1;
    recent.push(entry);
    if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
    if (pendingBytes >= FLUSH_BYTES) flush(t);
    return entry;
  }

  function flush(now) {
    const t = now === undefined ? Date.now() : now;
    if (pending.length === 0) { lastFlush = t; return; }
    const text = pending.join("");
    pending.length = 0;
    pendingBytes = 0;
    lastFlush = t;
    try {
      fs.appendFileSync(journalFile, text);
      journalBytes += Buffer.byteLength(text);
    } catch (error) {
      if (log !== undefined) log("warn", "steward: journal write failed: " + String(error));
    }
  }

  function ensure(id, now) {
    let rec = agents.get(id);
    if (rec !== undefined) return rec;
    rec = {
      id,
      sessionId: undefined,
      status: "unknown",
      statusSince: now,
      firstSeenAt: now,
      lastSeenAt: now,
      lastEventAt: now,
      lastEventType: "",
      events: 0,
      turns: 0,
      errors: 0,
      attention: false,
      attentionReason: undefined,
      question: undefined,
      moduleId: "unassigned",
      routeReason: undefined,
      routeConfidence: 0,
      title: undefined
    };
    agents.set(id, rec);
    return rec;
  }

  /** 事件入口：所有总线事件都落这里，保证 agents 表总是有记录。 */
  function touch(id, type, patch, now) {
    const t = now === undefined ? Date.now() : now;
    const rec = ensure(String(id), t);
    rec.lastEventAt = t;
    rec.lastSeenAt = t;
    rec.lastEventType = type;
    rec.events += 1;
    if (patch !== undefined) Object.assign(rec, patch);
    return rec;
  }

  function seen(id) {
    const rec = agents.get(String(id));
    if (rec === undefined) return undefined;
    rec.lastSeenAt = Date.now();
    return rec;
  }

  function setStatus(id, status, now) {
    const t = now === undefined ? Date.now() : now;
    const rec = ensure(String(id), t);
    if (rec.status === status) { rec.lastEventAt = t; return rec; }
    counters.statusChanges += 1;
    append("agent/status", { agentId: rec.id, from: rec.status, to: status }, t);
    rec.status = status;
    rec.statusSince = t;
    rec.lastEventAt = t;
    if (status === "running") { rec.attention = false; rec.attentionReason = undefined; }
    return rec;
  }

  function pushSignal(signal) {
    const now = signal.at === undefined ? Date.now() : signal.at;
    const key = String(signal.kind) + "|" + String(signal.agentId === undefined ? "-" : signal.agentId);
    const prev = signalIndex.get(key);
    if (prev !== undefined && now - prev.at < SIGNAL_COOLDOWN_MS) {
      prev.count += 1;
      prev.at = now;
      return prev;
    }
    const sig = {
      id: "s" + (signals.length + 1) + "-" + now.toString(36),
      at: now,
      severity: signal.severity || "info",
      kind: String(signal.kind || "unknown"),
      agentId: signal.agentId,
      sessionId: signal.sessionId,
      moduleId: signal.moduleId,
      message: String(signal.message === undefined ? "" : signal.message).slice(0, 500),
      count: 1
    };
    signals.push(sig);
    signalIndex.set(key, sig);
    if (signals.length > MAX_SIGNALS) signals.splice(0, signals.length - MAX_SIGNALS);
    append("signal", sig, now);
    return sig;
  }

  function pushAction(action) {
    const now = action.at === undefined ? Date.now() : action.at;
    const rec = Object.assign({ id: "a" + (actions.length + 1) + "-" + now.toString(36), at: now, ok: true }, action);
    actions.push(rec);
    if (actions.length > MAX_ACTIONS) actions.splice(0, actions.length - MAX_ACTIONS);
    append("action", rec, now);
    return rec;
  }

  /**
   * 预算计数口径（评审 P1-C）：只有真正动了手、或真的尝试过动手的条目才算消耗预算。
   * 信号、预演（echo）、被拒（denied）、路由/设置/审批/采集/汇报这类记账条目一律不占预算 ——
   * 否则 5 秒一次的心跳 + 预演就能把 budgetPerHour 烧满，随后 brain 会把所有工作流一起抑制。
   * 单个条目可以用 action.charge 显式覆盖（true 计入 / false 不计入）。
   */
  const FREE_KINDS = new Set([
    "echo", "denied", "signal", "modules", "settings", "approval", "route",
    "collect", "digest", "tool.begin", "tool.report", "session", "chat",
    "journal", "note", "tick", "status"
  ]);
  const CHARGED_KINDS = new Set(["escalate", "act", "slim", "notify", "send", "dispatch", "task.dispatch"]);

  function chargeOf(action) {
    if (action === undefined || action === null) return false;
    if (action.charge === true) return true;
    if (action.charge === false) return false;
    if (action.preview === true) return false;
    const kind = String(action.kind === undefined ? "" : action.kind);
    if (FREE_KINDS.has(kind)) return false;
    if (kind === "task" || kind === "task.dispatch") {
      const msg = String(action.message === undefined ? "" : action.message);
      // 建单/完成/取消/待验收/被授权层拦下都不算；派发与失败重试才算真动手。
      return /已派给|派发失败|发送失败|重试|dispatch/.test(msg) || action.charge === true;
    }
    return CHARGED_KINDS.has(kind);
  }

  /** 最近一条的 seq（0 表示还没写过）。 */
  function recentSeq() {
    return recent.length === 0 ? seq : recent[recent.length - 1].seq;
  }

  /**
   * 增量读取：返回 seq > afterSeq 的条目（按 seq 升序），最多 limit 条。
   * 环里存不下更早的（或 afterSeq 落后太多）时 truncated=true，调用方应做一次全量刷新。
   */
  function since(afterSeq, limit) {
    const after = Number.isFinite(Number(afterSeq)) ? Number(afterSeq) : 0;
    const max = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Math.floor(Number(limit)))) : 100;
    const oldest = recent.length === 0 ? seq + 1 : recent[0].seq;
    const truncated = after > 0 && after + 1 < oldest;
    const out = [];
    for (const entry of recent) {
      if (entry.seq <= after) continue;
      out.push(entry);
      if (out.length >= max) break;
    }
    return { entries: out, latest: recentSeq(), truncated };
  }

  function drop(id) {
    const rec = agents.get(String(id));
    if (rec === undefined) return;
    append("agent/dropped", { agentId: rec.id, sessionId: rec.sessionId, status: rec.status });
    agents.delete(String(id));
  }

  function rows() {
    return Array.from(agents.values());
  }

  function snapshot() {
    return {
      agents: rows().slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt),
      signals: signals.slice(-120).reverse(),
      actions: actions.slice(-60).reverse(),
      counters: Object.assign({}, counters),
      journal: {
        file: journalFile,
        bytes: journalBytes,
        queued: pendingBytes,
        lastFlush,
        seq
      }
    };
  }

  return { dir, agents, signals, actions, counters, append, flush, ensure, touch, seen, setStatus, pushSignal, pushAction, chargeOf, drop, rows, snapshot, signalIndex, recent, since, recentSeq };
}

export default { createStore };

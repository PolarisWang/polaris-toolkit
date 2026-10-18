/**
 * 对等节点状态机：出站队列 + 入站白名单。
 *
 * 设计取舍（M1 安全边界）：
 * - 命令白名单是硬编码的常量，不从配置读——配置被改不该等于获得执行权。
 * - 同一 nonce 只执行一次（重放防护的第二道，第一道在 verify 的时间窗）。
 * - 原始日志永远不出本机；这里只传摘要与命令。
 */
import { seal, verify } from "./envelope.js";

export const COMMAND_WHITELIST = ["ask", "approve", "collect", "set-policy", "pause", "resume"];

export function createPeer(options) {
  const o = options === undefined ? {} : options;
  const hostId = String(o.hostId === undefined ? "unknown" : o.hostId);
  const secret = o.secret === undefined ? null : String(o.secret);
  const clock = typeof o.clock === "function" ? o.clock : () => Date.now();
  const maxSkewMs = Number(o.maxSkewMs === undefined ? 300_000 : o.maxSkewMs);
  const log = typeof o.log === "function" ? o.log : () => {};
  const outbox = [];
  const inbox = [];
  const seen = new Set();
  const peers = new Map();

  function peerOf(id) {
    const key = String(id);
    if (!peers.has(key)) peers.set(key, { id: key, lastSeenAt: 0, lastEpoch: 0, rulesHash: null, modules: [], health: null });
    return peers.get(key);
  }

  return {
    hostId,
    /** 入站队列（等下一次长轮询取走）。 */
    send(type, body) {
      if (secret === null) return { ok: false, reason: "no-secret" };
      const envelope = seal({ secret, hostId, type, body, now: clock() });
      outbox.push(envelope);
      return { ok: true, envelope };
    },
    drain() {
      const items = outbox.splice(0, outbox.length);
      return items;
    },
    pending() { return outbox.length; },

    /** 收到对端信封：验签 → 白名单 → 去重 → 入队。 */
    receive(envelope) {
      if (secret === null) return { ok: false, reason: "no-secret" };
      const checked = verify({ envelope, secret, now: clock(), maxSkewMs, seen });
      if (!checked.ok) {
        log("warn", "peer envelope rejected: " + checked.reason);
        return checked;
      }
      seen.add(checked.nonce);
      if (seen.size > 4096) {
        const first = seen.values().next();
        if (!first.done) seen.delete(first.value);
      }
      const record = peerOf(checked.hostId);
      record.lastSeenAt = Number(checked.sentAt);
      if (checked.type === "heartbeat") {
        const body = checked.body === null || typeof checked.body !== "object" ? {} : checked.body;
        if (Number(body.epoch) >= record.lastEpoch) record.lastEpoch = Number(body.epoch);
        record.rulesHash = typeof body.rulesHash === "string" ? body.rulesHash : null;
        record.modules = Array.isArray(body.modules) ? body.modules : [];
        record.health = body.health === undefined ? null : body.health;
        return { ok: true, kind: "heartbeat", peer: record };
      }
      if (checked.type === "command") {
        const body = checked.body === null || typeof checked.body !== "object" ? {} : checked.body;
        const cmd = String(body.cmd);
        if (COMMAND_WHITELIST.indexOf(cmd) < 0) {
          log("warn", "peer command rejected: " + cmd);
          return { ok: false, reason: "command-not-allowed", cmd };
        }
        const command = { id: checked.nonce, cmd, args: body.args === undefined ? null : body.args, at: Number(checked.sentAt), from: checked.hostId };
        inbox.push(command);
        return { ok: true, kind: "command", command };
      }
      return { ok: true, kind: "other", type: checked.type, body: checked.body };
    },
    commands() { return inbox.slice(); },
    takeCommands() { return inbox.splice(0, inbox.length); },
    peers() { return Array.from(peers.values()); },
    seenCount() { return seen.size; }
  };
}

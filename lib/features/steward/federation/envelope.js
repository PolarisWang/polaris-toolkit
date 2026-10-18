/**
 * 联邦信封：HMAC-SHA256 签名 + 时间窗 + nonce 防重放。
 *
 * 只做"这一条消息是不是你发的、是不是新的"，不做加密（加密交给 Tailscale）。
 * 签名覆盖 v|hostId|type|sentAt|nonce|canonical(body)，任何字段被改都会失效。
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const ENVELOPE_VERSION = 1;

export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

export function sign(secret, envelope) {
  const material = [envelope.v, envelope.hostId, envelope.type, envelope.sentAt, envelope.nonce, canonical(envelope.body === undefined ? null : envelope.body)].join("|");
  return createHmac("sha256", String(secret)).update(material).digest("hex");
}

export function seal(input) {
  const i = input === undefined ? {} : input;
  const envelope = {
    v: ENVELOPE_VERSION,
    hostId: String(i.hostId),
    type: String(i.type),
    sentAt: Number(i.now === undefined ? Date.now() : i.now),
    nonce: String(i.nonce === undefined ? Math.random().toString(36).slice(2) + Date.now().toString(36) : i.nonce),
    body: i.body === undefined ? null : i.body
  };
  envelope.sig = sign(i.secret, envelope);
  return envelope;
}

export function verify(input) {
  const i = input === undefined ? {} : input;
  const envelope = i.envelope;
  if (envelope === null || typeof envelope !== "object") return { ok: false, reason: "malformed" };
  for (const key of ["v", "hostId", "type", "sentAt", "nonce", "sig"]) {
    if (envelope[key] === undefined || envelope[key] === null) return { ok: false, reason: "malformed" };
  }
  if (Number(envelope.v) !== ENVELOPE_VERSION) return { ok: false, reason: "version" };
  const expected = sign(i.secret, envelope);
  const a = Buffer.from(String(envelope.sig), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad-signature" };
  const now = Number(i.now === undefined ? Date.now() : i.now);
  const maxSkew = Number(i.maxSkewMs === undefined ? 300_000 : i.maxSkewMs);
  if (Math.abs(now - Number(envelope.sentAt)) > maxSkew) return { ok: false, reason: "skew" };
  const seen = i.seen;
  if (seen !== undefined && seen !== null && typeof seen.has === "function" && seen.has(String(envelope.nonce))) {
    return { ok: false, reason: "replay" };
  }
  return { ok: true, body: envelope.body, hostId: String(envelope.hostId), type: String(envelope.type), sentAt: Number(envelope.sentAt), nonce: String(envelope.nonce) };
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, seal, verify, sign, ENVELOPE_VERSION } from "../lib/features/steward/federation/envelope.js";
import { createPeer, COMMAND_WHITELIST } from "../lib/features/steward/federation/peer.js";

const NOW = 1_700_000_000_000;

test("canonical json is key-order independent", () => {
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
  assert.equal(canonical({ a: [1, { d: 4, c: 3 }] }), '{"a":[1,{"c":3,"d":4}]}');
});

test("seal + verify round trip", () => {
  const envelope = seal({ secret: "s3cret", hostId: "win-main", type: "heartbeat", body: { epoch: 3 }, now: NOW, nonce: "n1" });
  assert.equal(envelope.v, ENVELOPE_VERSION);
  const result = verify({ envelope, secret: "s3cret", now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.body.epoch, 3);
  assert.equal(result.hostId, "win-main");
});

test("verify rejects tampered body and wrong secret", () => {
  const envelope = seal({ secret: "s3cret", hostId: "h", type: "heartbeat", body: { epoch: 3 }, now: NOW, nonce: "n2" });
  const tampered = Object.assign({}, envelope, { body: { epoch: 9 } });
  assert.equal(verify({ envelope: tampered, secret: "s3cret", now: NOW }).reason, "bad-signature");
  assert.equal(verify({ envelope, secret: "other", now: NOW }).reason, "bad-signature");
});

test("verify rejects stale timestamps and replays", () => {
  const envelope = seal({ secret: "s", hostId: "h", type: "heartbeat", body: {}, now: NOW, nonce: "n3" });
  assert.equal(verify({ envelope, secret: "s", now: NOW + 600_000 }).reason, "skew");
  const seen = new Set(["n3"]);
  assert.equal(verify({ envelope, secret: "s", now: NOW, seen }).reason, "replay");
});

test("peer send needs a secret", () => {
  const peer = createPeer({ hostId: "h", clock: () => NOW });
  assert.equal(peer.send("heartbeat", {}).ok, false);
  assert.equal(peer.pending(), 0);
});

test("two peers exchange a whitelisted command once", () => {
  const a = createPeer({ hostId: "a", secret: "s", clock: () => NOW });
  const b = createPeer({ hostId: "b", secret: "s", clock: () => NOW });
  const sent = a.send("command", { cmd: "approve", args: { id: "ap1" } });
  assert.equal(sent.ok, true);
  const received = b.receive(sent.envelope);
  assert.equal(received.ok, true);
  assert.equal(received.command.cmd, "approve");
  assert.equal(b.commands().length, 1);
  const again = b.receive(sent.envelope);
  assert.equal(again.ok, false);
  assert.equal(again.reason, "replay");
});

test("peer rejects commands outside the whitelist", () => {
  const a = createPeer({ hostId: "a", secret: "s", clock: () => NOW });
  const b = createPeer({ hostId: "b", secret: "s", clock: () => NOW });
  for (const cmd of ["cancel", "exec", "spawn", "eval"]) {
    const result = b.receive(a.send("command", { cmd }).envelope);
    assert.equal(result.ok, false, cmd);
    assert.equal(result.reason, "command-not-allowed");
  }
  assert.deepEqual(COMMAND_WHITELIST, ["ask", "approve", "collect", "set-policy", "pause", "resume"]);
});

test("heartbeat updates peer summary and never downgrades epoch", () => {
  const a = createPeer({ hostId: "a", secret: "s", clock: () => NOW });
  const b = createPeer({ hostId: "b", secret: "s", clock: () => NOW });
  b.receive(a.send("heartbeat", { epoch: 5, rulesHash: "h1", modules: ["ev"], health: { heapPct: 10 } }).envelope);
  b.receive(a.send("heartbeat", { epoch: 3, rulesHash: "h0", modules: [] }).envelope);
  const peers = b.peers();
  assert.equal(peers.length, 1);
  assert.equal(peers[0].lastEpoch, 5);
  assert.equal(peers[0].rulesHash, "h0");
  assert.deepEqual(peers[0].modules, []);
});

test("drain empties the outbox", () => {
  const a = createPeer({ hostId: "a", secret: "s", clock: () => NOW });
  a.send("heartbeat", { epoch: 1 });
  a.send("heartbeat", { epoch: 2 });
  assert.equal(a.drain().length, 2);
  assert.equal(a.pending(), 0);
});

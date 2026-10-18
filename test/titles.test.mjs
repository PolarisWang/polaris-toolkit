import assert from "node:assert/strict";
import test from "node:test";
import { createTitleSource } from "../lib/features/steward/sources/titles.js";

const UUID = "0c4639e5-380b-4743-81e7-6c02f3206cff";

function fakeCtx(snapshots) {
  return {
    get(name) {
      if (name !== "sessionQuery") return undefined;
      return {
        async readTitleSnapshots(ids) {
          return ids.map((id) => snapshots[id] === undefined
            ? { status: "rejected", reason: "not-found", session: id }
            : { status: "fulfilled", value: { session: id, title: snapshots[id] } });
        }
      };
    }
  };
}

test("session- prefixed input resolves against bare-uuid sessions", async () => {
  const titles = createTitleSource({ ctx: fakeCtx({ [UUID]: "排查崩溃" }), log: () => {} });
  const cache = await titles.refresh(["session-" + UUID]);
  assert.equal(cache.get(UUID), "排查崩溃");
  assert.equal(titles.get("session-" + UUID), "排查崩溃");
  assert.equal(titles.get(UUID), "排查崩溃");
  assert.equal(titles.size(), 1);
});

test("heap-guard cache is used when sessionQuery has nothing", async () => {
  const titles = createTitleSource({
    ctx: { get: () => undefined },
    log: () => {},
    fallback: () => [{ id: UUID, title: "net" }]
  });
  await titles.refresh([UUID]);
  assert.equal(titles.get("session-" + UUID), "net");
});

test("missing ids and hostile hosts degrade to undefined without throwing", async () => {
  const titles = createTitleSource({
    ctx: { get() { throw new Error("no services"); } },
    log: () => {},
    fallback: () => { throw new Error("no heap-guard"); }
  });
  await titles.refresh(["session-" + UUID]);
  assert.equal(titles.get("session-" + UUID), undefined);
  assert.equal(titles.size(), 0);
  assert.match(String(titles.error()), /no heap-guard/);
});

test("empty and null ids are ignored", async () => {
  const titles = createTitleSource({ ctx: fakeCtx({}), log: () => {} });
  await titles.refresh([null, "", "session-"]);
  assert.equal(titles.size(), 0);
});

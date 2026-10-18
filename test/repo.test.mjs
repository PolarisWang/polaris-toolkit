import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 仓库约定守卫（评审 P2-C）：文档、CI、测试入口这三样最容易"写完就漂"，
 * 这里让它们进回归网——改名/删文件会直接红。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8").split("\r\n").join("\n");

test("repo: test entry, CI and docs stay wired together", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts.test, "node _test/all.mjs");
  assert.equal(pkg.scripts["test:coverage"], "node _test/all.mjs --coverage");
  assert.ok(fs.existsSync(path.join(root, "_test/all.mjs")), "_test/all.mjs exists");

  assert.equal(pkg.scripts.lint, "node _test/lint.mjs");
  assert.ok(fs.existsSync(path.join(root, "_test/lint.mjs")), "_test/lint.mjs exists");
  assert.ok(fs.existsSync(path.join(root, "pnpm-lock.yaml")), "pnpm-lock.yaml is committed (CI uses --frozen-lockfile)");
  assert.ok(pkg.peerDependencies["@deepseek-ai/schemastery"] !== undefined, "schemastery is a declared peer");
  assert.ok(pkg.peerDependencies["@deepseek-ai/dsh-tools"] !== undefined, "dsh-tools is a declared peer");
  assert.ok(pkg.devDependencies["@deepseek-ai/schemastery"] !== undefined, "schemastery is pinned for tests");
  for (const rel of ["LICENSE", "CHANGELOG.md", "SECURITY.md", ".editorconfig"]) {
    assert.ok(fs.existsSync(path.join(root, rel)), rel + " exists");
  }

  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /pnpm test/);
  assert.match(ci, /pnpm install --frozen-lockfile/);
  assert.match(ci, /test:coverage/);
  assert.match(ci, /matrix:/);
  assert.match(ci, /ubuntu-latest/);
  assert.match(ci, /windows-latest/);

  for (const rel of ["AGENTS.md", "docs/known-limits.md", "skills/polaris-toolkit/SKILL.md", "docs/design-capability-plane.md"]) {
    assert.ok(fs.statSync(path.join(root, rel)).size > 500, rel + " has content");
  }
  // README 是 CRLF，按行读，别用 \n 拼的锚点。
  const readme = read("README.md");
  assert.ok(readme.includes("docs/known-limits.md"), "README links known-limits");
  assert.ok(readme.includes("AGENTS.md"), "README links AGENTS.md");
  assert.ok(readme.includes("SECURITY.md"), "README links SECURITY.md");
  assert.ok(fs.existsSync(path.join(root, "test/helpers/harness.mjs")));
  // pnpm 11 要求 Node >= 22.13，所以矩阵从 22 起。
  assert.match(ci, /"22"/);
  assert.match(ci, /"24"/);
  assert.match(String(pkg.engines.node), /22\.13/);
});

test("repo: agents guidance keeps the load-bearing rules", () => {
  const agents = read("AGENTS.md");
  for (const needle of ["additionalProperties", "UTF-8 with BOM", "GLOBAL_FNS", "CRLF", "chargeOf", "_test/all.mjs"]) {
    assert.ok(agents.includes(needle), "AGENTS.md mentions " + needle);
  }
  const skill = read("skills/polaris-toolkit/SKILL.md");
  assert.match(skill, /^---\nname: polaris-toolkit\n/);
  for (const needle of ["steward_trace", "steward_settings", "x-polaris-token", "no-model-route"]) {
    assert.ok(skill.includes(needle), "SKILL.md mentions " + needle);
  }
  const limits = read("docs/known-limits.md");
  for (const needle of ["匿名", "重启", "chargeOf", "node:sqlite"]) {
    assert.ok(limits.includes(needle), "known-limits mentions " + needle);
  }
});

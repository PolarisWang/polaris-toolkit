#!/usr/bin/env node
/**
 * 跨平台测试入口（评审 P2-C）：CI 与本地跑同一条命令。
 *
 * node --test 不吃 Windows shell 的 glob（"test/*.test.mjs" 在 pwsh 里不会展开），
 * 所以这里自己枚举测试文件；跑完再跑一次 _test/run.mjs 冒烟（假宿主挂整套插件）。
 * 传 --coverage 时加覆盖率门槛：Node 22.8+ 才有 --test-coverage-* 标志。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const testDir = path.join(root, "test");
const files = fs.readdirSync(testDir).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => path.join(testDir, f));
if (files.length === 0) { console.error("no test files found in " + testDir); process.exit(1); }

const [major, minor] = String(process.versions.node).split(".").map(Number);
const coverage = process.argv.includes("--coverage");
const args = [];
if (coverage) {
  args.push("--experimental-test-coverage");
  if (major > 22 || (major === 22 && minor >= 8)) {
    // 门槛取当前实际值再留一点余量：低于它就说明新代码没进回归网。
    args.push("--test-coverage-lines=60", "--test-coverage-functions=50", "--test-coverage-branches=50");
  }
}
args.push("--test", ...files);

function run(command, argv) {
  const out = spawnSync(command, argv, { cwd: root, stdio: "inherit" });
  if (out.status !== 0) process.exit(out.status === null ? 1 : out.status);
}

run(process.execPath, [path.join(here, "lint.mjs")]);
run(process.execPath, args);
run(process.execPath, [path.join(here, "run.mjs")]);

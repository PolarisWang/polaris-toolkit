import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * 安装器的"空环境"回归（真实事故：在 DSH 的 PTC 运行器里跑 install 时
 * process.env 几乎是空的，PowerShell 的 Join-Path $env:LOCALAPPDATA 直接抛
 * "Cannot bind argument to parameter 'Path' because it is null"，清单被回滚）。
 *
 * 这里锁三件事：
 *  1. bin/polaris.mjs 在几乎空的 env 下仍然能跑 doctor（它会自己补 Windows 变量）；
 *  2. 空 env 下不需要任何交互，也不会在**当前目录**里造出字面量 "%SystemDrive%" 目录
 *     （缺 SystemDrive 时 PowerShell 启动会造一个，里面是 Windows 兼容性缓存，曾误入提交）；
 *  3. 两个 .ps1 脚本内部不再直接把可能为空的 $env:XXX 交给 Join-Path，且仍是 UTF-8 with BOM
 *     （不带 BOM 会被 Windows PowerShell 5.1 按 GBK 解码，中文注释乱码且行号错位）。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CLI = path.join(REPO, "bin", "polaris.mjs");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "polaris-env-"));
}

test("doctor survives an almost empty environment", { skip: process.platform !== "win32" ? "install 只针对 Windows" : false }, () => {
  const cwd = tmpDir();
  try {
    const res = spawnSync(process.execPath, [CLI, "doctor", "--json"], {
      cwd,
      encoding: "utf8",
      timeout: 120000,
      env: {}
    });
    assert.equal(res.error, undefined);
    // CI 上没有 ~/.dsh/profiles/desktop，doctor 会因为 "profile 不存在" 判 fail（退出码 1）——
    // 这里只要求它不崩、能打出 JSON、且没有 PowerShell 的 null 路径异常。
    assert.ok(!(res.stderr || "").includes("Cannot bind argument to parameter"), "no PowerShell null-path crash");
    assert.notEqual(String(res.stdout).trim(), "", "doctor --json prints JSON even without a profile");
    const out = JSON.parse(res.stdout);
    assert.ok(Array.isArray(out.checks) || Array.isArray(out), "doctor --json should print checks");
    assert.equal(fs.existsSync(path.join(cwd, "%SystemDrive%")), false, "must not create a literal %SystemDrive% dir");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

for (const name of ["install.ps1", "uninstall.ps1"]) {
  test(name + " resolves paths defensively and keeps its BOM", () => {
    const file = path.join(REPO, "install", name);
    const buf = fs.readFileSync(file);
    assert.equal(buf[0], 0xef, name + " must start with a UTF-8 BOM");
    assert.equal(buf[1], 0xbb);
    assert.equal(buf[2], 0xbf);
    const text = buf.toString("utf8").replace(/^\uFEFF/, "");
    assert.equal(text.includes("Join-Path $env:LOCALAPPDATA"), false, name + " must not Join-Path a possibly-empty env var");
    assert.ok(text.includes("$localAppData = $env:LOCALAPPDATA"), name + " must derive $localAppData with a fallback");
    assert.ok(text.includes("$tmpBase"), name + " must derive a temp base with a fallback");
  });
}

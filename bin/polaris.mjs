#!/usr/bin/env node
/**
 * polaris —— polaris-toolkit 的安装/体检入口（评审 P2-9）。
 *
 *   node bin/polaris.mjs install [--profile <dir>] [--no-bundles] [--no-pnpm] [--keep-old]
 *   node bin/polaris.mjs doctor  [--profile <dir>] [--json] [--quiet]
 *   node bin/polaris.mjs version | help
 *
 * 为什么要有它：以前"装好了没 / 装的是哪一版 / 仓库改了但 node_modules 里还是旧的"
 * 全靠人肉看文件。install 仍然是那条经过验证的 PowerShell 路径（它要改 profile 清单、
 * 调 pnpm），但**验证**搬到这里：doctor 只读、可脚本化（--json + 退出码），
 * install.ps1 末尾也调它一次，于是"安装成功"变成一个有据可查的结论。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PKG = "polaris-toolkit";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);

function home() {
  const fromEnv = process.env.USERPROFILE !== undefined && process.env.USERPROFILE.length > 0
    ? process.env.USERPROFILE
    : process.env.HOME;
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : os.homedir();
}

function stateDir() {
  return path.join(home(), ".dsh", PKG);
}

function defaultProfile() {
  return path.join(home(), ".dsh", "profiles", "desktop");
}

function norm(p) {
  return path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
}

function readJson(file) {
  try {
    return JSON.parse(String(fs.readFileSync(file, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

function hasBom(file) {
  try {
    const buf = fs.readFileSync(file);
    return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  } catch {
    return false;
  }
}

function readPkg(dir) {
  return readJson(path.join(dir, "package.json"));
}

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (e.isFile()) n += 1;
    }
  };
  walk(dir);
  return n;
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

// ---------- doctor ----------

function check(list, id, level, title, detail, fix) {
  list.push({ id, level, title, detail, fix });
}

function doctor(opts) {
  const list = [];
  const profileDir = opts.profile === undefined ? defaultProfile() : path.resolve(opts.profile);
  const repoPkg = readPkg(REPO);

  // 1) 运行环境
  check(list, "node", "ok", "node " + process.version, process.platform + " / " + process.arch);

  // 2) 仓库自身
  if (repoPkg === undefined) {
    check(list, "repo", "fail", "仓库不可用", "package.json 读不出来: " + path.join(REPO, "package.json"), "确认在仓库目录里运行");
    return list;
  }
  const version = String(repoPkg.version === undefined ? "0.0.0" : repoPkg.version);
  check(list, "repo", "ok", "仓库 " + PKG + "@" + version, REPO);
  for (const rel of ["lib/index.js", "lib/client.js", "cordis.patch.yml"]) {
    const full = path.join(REPO, rel);
    check(list, "file:" + rel, fs.existsSync(full) ? "ok" : "fail", rel, fs.existsSync(full) ? "存在" : "缺失", "仓库不完整，重新 clone");
  }

  // 3) 装机记录（install.json）
  const installFile = path.join(stateDir(), "install.json");
  const installed = readJson(installFile);
  if (installed === undefined) {
    check(list, "install-record", "warn", "没有装机记录", installFile + " 不存在", "跑一次 polaris install（或 install/install.ps1）");
  } else {
    const stale = norm(String(installed.repo === undefined ? "" : installed.repo)) !== norm(REPO);
    check(list, "install-record", stale ? "warn" : "ok", "上次安装 " + String(installed.at === undefined ? "?" : installed.at),
      "版本 " + String(installed.version) + " · " + String(installed.files) + " 个文件 · 仓库 " + String(installed.repo),
      stale ? "装机来源不是当前仓库，重新安装" : undefined);
  }

  // 4) profile 清单
  const manifestFile = path.join(profileDir, "package.json");
  if (!fs.existsSync(manifestFile)) {
    check(list, "profile", "fail", "profile 不存在", profileDir, "用 --profile 指定 DSH profile 目录");
    return list;
  }
  if (hasBom(manifestFile)) {
    check(list, "profile-bom", "fail", "package.json 带 UTF-8 BOM", "DSH 启动时会 JSON.parse 失败", "去掉 BOM（install.ps1 会写成无 BOM）");
  }
  const manifest = readJson(manifestFile);
  if (manifest === undefined) {
    check(list, "profile-json", "fail", "package.json 解析失败", manifestFile, "修好 JSON（install.ps1 有备份可以回滚）");
    return list;
  }
  check(list, "profile-json", "ok", "profile 清单可解析", manifestFile);

  const dep = manifest.dependencies === undefined ? undefined : manifest.dependencies[PKG];
  const depText = String(dep === undefined ? "" : dep);
  if (depText === "") {
    check(list, "dep", "fail", "清单里没有 " + PKG, "dependencies." + PKG + " 缺失", "跑 polaris install");
  } else if (!depText.startsWith("file:")) {
    check(list, "dep", "warn", "依赖不是 file: 形式", depText, "本地开发应写成 file:<仓库路径>");
  } else {
    const target = depText.slice(5).replace(/^\/+/, "");
    const resolved = /^[A-Za-z]:/.test(target) ? target : path.resolve(profileDir, target);
    const same = norm(resolved) === norm(REPO);
    check(list, "dep", same ? "ok" : "warn", "dependencies." + PKG, depText, same ? undefined : ("指向 " + resolved + "，当前仓库是 " + REPO));
  }

  const meta = manifest.dependenciesMeta === undefined ? undefined : manifest.dependenciesMeta[PKG];
  if (meta !== undefined && meta !== null && meta.injected === true) {
    check(list, "injected", "ok", "注入式安装", "dependenciesMeta." + PKG + ".injected = true");
  } else {
    check(list, "injected", "warn", "没标记 injected", "pnpm 可能把目录挪进 node_modules/.ignored", "跑 polaris install 重新写清单");
  }

  const bundles = manifest.dsh !== undefined && manifest.dsh.profile !== undefined && Array.isArray(manifest.dsh.profile.bundles)
    ? manifest.dsh.profile.bundles.map(String)
    : [];
  const dup = bundles.filter((b) => b === PKG).length;
  if (dup === 0) {
    check(list, "bundle", "fail", "不在 dsh.profile.bundles 里", "插件不会被加载", "跑 polaris install");
  } else if (dup > 1) {
    check(list, "bundle", "fail", "dsh.profile.bundles 里重复 " + dup + " 次", "重复挂载会让插件树起不来", "删掉多余的行");
  } else {
    check(list, "bundle", "ok", "已登记为 bundle", PKG + "（共 " + bundles.length + " 个）");
  }

  // 5) 已安装副本
  const dest = path.join(profileDir, "node_modules", PKG);
  const destPkg = readPkg(dest);
  if (destPkg === undefined) {
    check(list, "installed", "fail", "node_modules 里没有插件", dest, "跑 polaris install");
  } else {
    const destVersion = String(destPkg.version === undefined ? "0.0.0" : destPkg.version);
    check(list, "installed-version", destVersion === version ? "ok" : "warn", "已安装 " + PKG + "@" + destVersion,
      destVersion === version ? "与仓库版本一致" : ("仓库是 " + version + "，重新安装"),
      destVersion === version ? undefined : "跑 polaris install");
    for (const rel of ["lib/index.js", "cordis.patch.yml"]) {
      const full = path.join(dest, rel);
      check(list, "installed:" + rel, fs.existsSync(full) ? "ok" : "fail", "已安装 " + rel, fs.existsSync(full) ? "存在" : "缺失", "跑 polaris install");
      if (fs.existsSync(full)) {
        const drift = mtime(path.join(REPO, rel)) - mtime(full);
        if (drift > 2000) {
          check(list, "drift:" + rel, "warn", "已安装的 " + rel + " 比仓库旧", Math.round(drift / 1000) + " 秒", "跑 polaris install 同步");
        }
      }
    }
    check(list, "installed-files", "ok", "已安装文件数", String(countFiles(dest)), undefined);
  }

  // 6) 状态目录
  const state = stateDir();
  if (!fs.existsSync(state)) {
    check(list, "state", "warn", "状态目录还没建", state, "宿主首次加载时创建");
  } else {
    check(list, "state", "ok", "状态目录", state);
    const settings = path.join(state, "settings.json");
    if (fs.existsSync(settings)) {
      const doc = readJson(settings);
      const ok = doc !== undefined && doc !== null && typeof doc === "object";
      const v = ok && doc.v !== undefined ? Number(doc.v) : 0;
      check(list, "settings", ok ? "ok" : "fail", "settings.json v" + String(v), ok ? "可解析" : "解析失败", ok ? undefined : "删掉或修好它（缺省值会重新生成）");
    }
    const secret = path.join(state, "secret");
    if (fs.existsSync(secret)) {
      let mode = 0;
      try { mode = fs.statSync(secret).mode & 0o777; } catch { mode = 0; }
      const tight = process.platform === "win32" || (mode & 0o077) === 0;
      check(list, "secret", tight ? "ok" : "warn", "写操作令牌", secret + "（" + mode.toString(8) + "）", tight ? undefined : "chmod 600 ~/.dsh/polaris-toolkit/secret");
    } else {
      check(list, "secret", "warn", "还没有写操作令牌", secret + " 不存在", "宿主启动时生成");
    }
  }

  return list;
}

function render(list, opts) {
  const bad = list.filter((c) => c.level === "fail").length;
  const warn = list.filter((c) => c.level === "warn").length;
  if (opts.json === true) {
    process.stdout.write(JSON.stringify({ ok: bad === 0, fails: bad, warns: warn, checks: list }, null, 2) + "\n");
    return bad;
  }
  if (opts.quiet !== true) {
    const mark = { ok: "  ok  ", warn: " warn ", fail: " FAIL " };
    for (const c of list) {
      process.stdout.write("[" + mark[c.level] + "] " + c.title + (c.detail === undefined ? "" : "  " + c.detail) + "\n");
      if (c.level !== "ok" && c.fix !== undefined) process.stdout.write("          -> " + c.fix + "\n");
    }
    process.stdout.write("\n" + (bad === 0 ? "doctor: ok" : "doctor: " + bad + " 项失败") + (warn === 0 ? "" : "，" + warn + " 项提醒") + "\n");
  } else if (bad > 0) {
    process.stdout.write("doctor: " + bad + " 项失败\n");
  }
  return bad;
}

// ---------- install ----------

function install(opts) {
  if (process.platform !== "win32") {
    process.stderr.write("install 目前只针对 Windows（install 走 PowerShell）。其他平台请手工把仓库登记成 profile 的 file: 依赖。\n");
    return 2;
  }
  const script = path.join(REPO, "install", "install.ps1");
  if (!fs.existsSync(script)) {
    process.stderr.write("找不到 " + script + "\n");
    return 2;
  }
  const args = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script];
  if (opts.profile !== undefined) args.push("-Profile", path.resolve(opts.profile));
  if (opts.noBundles === true) args.push("-NoBundles");
  if (opts.noPnpm === true) args.push("-NoPnpm");
  if (opts.keepOld === true) args.push("-KeepOld");
  const shell = process.env.ComSpec !== undefined ? "powershell.exe" : "powershell";
  process.stdout.write("running: " + shell + " " + args.join(" ") + "\n\n");
  const childEnv = Object.assign({}, process.env, {
    USERPROFILE: process.env.USERPROFILE === undefined || process.env.USERPROFILE.length === 0 ? home() : process.env.USERPROFILE,
    TEMP: process.env.TEMP === undefined || process.env.TEMP.length === 0 ? os.tmpdir() : process.env.TEMP,
    TMP: process.env.TMP === undefined || process.env.TMP.length === 0 ? os.tmpdir() : process.env.TMP
  });
  const res = spawnSync(shell, args, { stdio: "inherit", env: childEnv });
  if (res.error !== undefined) {
    process.stderr.write("启动 PowerShell 失败: " + String(res.error.message) + "\n");
    return 2;
  }
  if (res.status !== 0) return res.status === null ? 1 : res.status;
  process.stdout.write("\n");
  const list = doctor({ profile: opts.profile });
  const bad = render(list, { quiet: false });
  return bad === 0 ? 0 : 1;
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { command: argv[0] === undefined ? "help" : String(argv[0]), profile: undefined, json: false, quiet: false, noBundles: false, noPnpm: false, keepOld: false };
  for (let i = 1; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (a === "--profile" || a === "-p") { out.profile = argv[i + 1]; i += 1; continue; }
    if (a.startsWith("--profile=")) { out.profile = a.slice(10); continue; }
    if (a === "--json") { out.json = true; continue; }
    if (a === "--quiet" || a === "-q") { out.quiet = true; continue; }
    if (a === "--no-bundles") { out.noBundles = true; continue; }
    if (a === "--no-pnpm") { out.noPnpm = true; continue; }
    if (a === "--keep-old") { out.keepOld = true; continue; }
  }
  return out;
}

function help() {
  const pkg = readPkg(REPO);
  const version = String(pkg === undefined || pkg.version === undefined ? "?" : pkg.version);
  process.stdout.write([
    "polaris-toolkit " + version + "  (" + REPO + ")",
    "",
    "  polaris install [--profile <dir>] [--no-bundles] [--no-pnpm] [--keep-old]",
    "      把仓库登记成 DSH profile 的注入式 file: 依赖并跑 pnpm install，然后体检一遍。",
    "  polaris doctor [--profile <dir>] [--json] [--quiet]",
    "      只读体检：清单、注入标记、bundle 登记、已安装副本、漂移、状态目录、令牌。",
    "      有问题时退出码为 1，方便脚本判断。",
    "  polaris version | help",
    ""
  ].join("\n"));
}

const opts = parseArgs(process.argv.slice(2));
if (opts.command === "install") process.exit(install(opts));
if (opts.command === "doctor") process.exit(render(doctor(opts), opts) === 0 ? 0 : 1);
if (opts.command === "version" || opts.command === "--version" || opts.command === "-v") {
  const pkg = readPkg(REPO);
  process.stdout.write(String(pkg === undefined || pkg.version === undefined ? "?" : pkg.version) + "\n");
  process.exit(0);
}
help();
process.exit(opts.command === "help" || opts.command === "--help" || opts.command === "-h" ? 0 : 2);

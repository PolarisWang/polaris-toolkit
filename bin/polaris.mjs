#!/usr/bin/env node
/**
 * polaris —— polaris-toolkit 的安装/体检入口（评审 P2-9）。
 *
 *   node bin/polaris.mjs install [--profile <dir>] [--no-bundles] [--no-pnpm] [--keep-old]
 *   node bin/polaris.mjs doctor  [--profile <dir>] [--json] [--quiet]
 *   node bin/polaris.mjs token   [--path]
 *   node bin/polaris.mjs pack    [--out <dir>] [--dry-run]
 *   node bin/polaris.mjs rollback [--profile <dir>]
 *   node bin/polaris.mjs release [--dry-run] [--allow-dirty] [--skip-tests] [--force-tag]
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
import { createHash } from "node:crypto";
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

/** 仓库里最新的源码文件（lib/ 与 bin/ 下的 .js/.mjs/.json）。 */
function newestSource(repoRoot) {
  let ms = 0;
  let rel = "";
  for (const sub of ["lib", "bin"]) {
    const walk = (d) => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== "node_modules") walk(full); continue; }
        if (!/\.(js|mjs|json)$/.test(e.name)) continue;
        const m = mtime(full);
        if (m > ms) { ms = m; rel = path.relative(repoRoot, full); }
      }
    };
    walk(path.join(repoRoot, sub));
  }
  return { ms, rel };
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
    // 仓库代码比 install.json 新 = 改了没装（offline 只能查到这一层；"装完没重启"由 /api/install 的 stale 判断）
    const at = Date.parse(String(installed.at === undefined ? "" : installed.at));
    const newest = newestSource(REPO);
    if (Number.isFinite(at) && newest.ms > at + 2000) {
      check(list, "install-drift", "warn", "仓库代码比上次安装新", newest.rel + "（" + new Date(newest.ms).toISOString() + "）",
        "跑 polaris install 同步，然后重启宿主（Node 不会热重载已装载模块）");
    } else if (Number.isFinite(at)) {
      check(list, "install-drift", "ok", "仓库与装机记录一致", new Date(at).toISOString());
    }
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

// ---------- token ----------

/** 写操作令牌：面板靠 cookie 自动带，命令行/脚本要自己加头。 */
function token(opts) {
  const file = path.join(stateDir(), "secret");
  const value = fs.existsSync(file) ? String(fs.readFileSync(file, "utf8")).trim() : "";
  if (opts.pathOnly === true) {
    process.stdout.write(file + "\n");
    return 0;
  }
  if (value === "") {
    process.stderr.write("还没有令牌：" + file + " 不存在。宿主首次加载时会生成，先启动一次 DSH。\n");
    return 1;
  }
  process.stdout.write([
    "file    " + file,
    "header  x-polaris-token: " + value,
    "",
    "例（把 <port> 换成 dsh web 打印的端口）：",
    "  curl -H \"x-polaris-token: " + value + "\" \\",
    "       -H \"content-type: application/json\" \\",
    "       -d '{\"feature\":\"steward\",\"patch\":{}}' \\",
    "       http://127.0.0.1:<port>/__polaris/api/settings",
    ""
  ].join("\n"));
  return 0;
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
  // PATH 也可能不存在（PTC 运行器），此时裸名 "powershell" 会 ENOENT —— 先按绝对路径找。
  const sysRoot = process.env.SystemRoot !== undefined && process.env.SystemRoot.length > 0 ? process.env.SystemRoot : "C:\\Windows";
  const psExe = path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const shell = fs.existsSync(psExe) ? psExe : "powershell.exe";
  process.stdout.write("running: " + shell + " " + args.join(" ") + "\n\n");
  // 宿主（PTC 运行器）启动的子进程环境可能几乎是空的：PowerShell 里任何一个
  // Join-Path $env:XXX 拿到 null 都会直接抛 "Cannot bind argument to parameter 'Path'"。
  // 所以这里把 Windows 上真正会用到的那几个变量补齐，而不是只补 USERPROFILE。
  const pick = (name) => (process.env[name] === undefined || process.env[name].length === 0 ? undefined : process.env[name]);
  // os.tmpdir() 在 TEMP/TMP 都为空时返回相对的 "undefined\\temp"（Node 的历史行为），
  // 落到子进程里就是一个相对于当前目录的怪路径 —— 只在这种情况下改用用户临时目录。
  const sysTmp = (() => {
    const t = os.tmpdir();
    return path.isAbsolute(t) ? t : path.join(home(), "AppData", "Local", "Temp");
  })();
  const fallbacks = {
    USERPROFILE: pick("USERPROFILE") === undefined ? home() : pick("USERPROFILE"),
    LOCALAPPDATA: pick("LOCALAPPDATA") === undefined ? path.join(home(), "AppData", "Local") : pick("LOCALAPPDATA"),
    APPDATA: pick("APPDATA") === undefined ? path.join(home(), "AppData", "Roaming") : pick("APPDATA"),
    TEMP: pick("TEMP") === undefined ? sysTmp : pick("TEMP"),
    TMP: pick("TMP") === undefined ? sysTmp : pick("TMP"),
    SystemRoot: pick("SystemRoot") === undefined ? "C:\\Windows" : pick("SystemRoot"),
    // 缺 SystemDrive 时 PowerShell 启动会在**当前目录**里造一个字面量 "%SystemDrive%" 目录
    // （里面是 ProgramData\Microsoft\Windows\Caches\*.db）—— 已实测复现，务必补上。
    SystemDrive: pick("SystemDrive") === undefined ? "C:" : pick("SystemDrive"),
    ProgramData: pick("ProgramData") === undefined ? "C:\\ProgramData" : pick("ProgramData"),
    ALLUSERSPROFILE: pick("ALLUSERSPROFILE") === undefined ? "C:\\ProgramData" : pick("ALLUSERSPROFILE"),
    windir: pick("windir") === undefined ? "C:\\Windows" : pick("windir"),
    ComSpec: pick("ComSpec") === undefined ? "C:\\Windows\\System32\\cmd.exe" : pick("ComSpec"),
    PATHEXT: pick("PATHEXT") === undefined ? ".COM;.EXE;.BAT;.CMD" : pick("PATHEXT"),
    PATH: pick("PATH") === undefined ? "C:\\Windows\\System32;C:\\Windows" : pick("PATH")
  };
  const childEnv = Object.assign({}, process.env, fallbacks);
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

// ---------- pack / rollback / release ----------

function pnpmPath() {
  const fromEnv = process.env.POLARIS_PNPM;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const guess = path.join(home(), "AppData", "Local", "Programs", "DeepSeek Harness", "resources", "runtime", "primary-runtime", "dependencies", "pnpm", "bin", "pnpm.cjs");
  return fs.existsSync(guess) ? guess : undefined;
}

/** git 可能不在 PATH 里（尤其从精简环境启动时），先找常见安装位置。 */
function gitPath() {
  const fromEnv = process.env.POLARIS_GIT;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const candidates = [
    "C:/Program Files/Git/cmd/git.exe",
    "C:/Program Files/Git/bin/git.exe",
    path.join(home(), "AppData", "Local", "Programs", "Git", "cmd", "git.exe")
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return "git";
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function manifestFiles() {
  const pkg = readPkg(REPO);
  const entries = pkg === undefined || !Array.isArray(pkg.files) ? [] : pkg.files;
  const files = [];
  for (const entry of entries) {
    const abs = path.join(REPO, String(entry));
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) files.push(...walk(abs));
    else files.push(abs);
  }
  return files;
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** 打包成可发布的 tarball（评审 P1-8）：走 pnpm pack，按 package.json 的 files[] 收文件。 */
function pack(opts) {
  const pkg = readPkg(REPO);
  const version = String(pkg === undefined || pkg.version === undefined ? "0.0.0" : pkg.version);
  const outDir = opts.outDir === undefined ? path.join(REPO, "dist") : path.resolve(String(opts.outDir));
  const files = manifestFiles();
  const bytes = files.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  const target = path.join(outDir, PKG + "-" + version + ".tgz");
  if (opts.dryRun === true) {
    const lines = [
      "pack --dry-run  " + PKG + "@" + version,
      "  files   " + files.length + " (" + Math.round(bytes / 1024) + " KiB)",
      "  target  " + target
    ];
    for (const f of files) lines.push("  " + path.relative(REPO, f));
    lines.push("");
    process.stdout.write(lines.join("\n"));
    return 0;
  }
  const pnpm = pnpmPath();
  if (pnpm === undefined) {
    process.stderr.write("找不到 pnpm（设 POLARIS_PNPM 指向 pnpm.cjs）。\n");
    return 1;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const r = spawnSync(process.execPath, [pnpm, "pack", "--pack-destination", outDir, "--config.strictDepBuilds=false"], { cwd: REPO, stdio: "inherit" });
  if (r.status !== 0) return r.status === null ? 1 : r.status;
  if (!fs.existsSync(target)) {
    process.stderr.write("pnpm pack 结束但没有生成 " + target + "\n");
    return 1;
  }
  process.stdout.write("packed  " + target + "\n  bytes  " + fs.statSync(target).size + "\n  sha256 " + sha256(target) + "\n");
  return 0;
}

/** 回滚 profile 清单（评审 P1-8）：用 install.ps1 留下的备份覆盖回去。 */
function rollback(opts) {
  const profile = opts.profile === undefined ? defaultProfile() : path.resolve(String(opts.profile));
  const manifest = path.join(profile, "package.json");
  if (!fs.existsSync(profile)) {
    process.stderr.write("profile 不存在：" + profile + "\n");
    return 1;
  }
  const prefix = "package.json.before-polaris-toolkit-";
  const backups = fs.readdirSync(profile)
    .filter((n) => n.startsWith(prefix) && n.endsWith(".bak"))
    .map((n) => path.join(profile, n))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (backups.length === 0) {
    process.stderr.write("没有找到备份：" + path.join(profile, prefix + "*.bak") + "\n");
    return 1;
  }
  fs.copyFileSync(backups[0], manifest);
  process.stdout.write([
    "restored " + manifest,
    "  from   " + backups[0],
    "  next   restart the DSH host (tray -> quit, then start again); the plugin stops loading.",
    ""
  ].join("\n"));
  return 0;
}

/** 发布闸门（评审 P2-12）：版本、CHANGELOG、git 状态都对上才打 tag。 */
function release(opts) {
  const pkg = readPkg(REPO);
  const version = String(pkg === undefined || pkg.version === undefined ? "" : pkg.version);
  const tag = "v" + version;
  const problems = [];
  if (version === "") problems.push("package.json has no version");
  const changelogFile = path.join(REPO, "CHANGELOG.md");
  const changelog = fs.existsSync(changelogFile) ? String(fs.readFileSync(changelogFile, "utf8")) : "";
  if (version !== "" && !changelog.includes(version)) problems.push("CHANGELOG.md has no entry for " + version);
  if (!fs.existsSync(path.join(REPO, "LICENSE"))) problems.push("LICENSE is missing");
  const git = gitPath();
  const status = spawnSync(git, ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" });
  if (status.status !== 0) problems.push("git is unavailable (" + git + ") or this is not a git work tree");
  else if (String(status.stdout).trim() !== "" && opts.allowDirty !== true) problems.push("git work tree is dirty (commit first, or pass --allow-dirty)");
  const existing = spawnSync(git, ["tag", "-l", tag], { cwd: REPO, encoding: "utf8" });
  if (existing.status === 0 && String(existing.stdout).trim() !== "" && opts.forceTag !== true) problems.push("tag " + tag + " already exists (pass --force-tag to move it)");
  if (problems.length > 0) {
    process.stderr.write("release blocked:\n  - " + problems.join("\n  - ") + "\n");
    return 1;
  }
  if (opts.skipTests !== true) {
    const tests = spawnSync(process.execPath, [path.join(REPO, "_test", "all.mjs")], { cwd: REPO, stdio: "inherit" });
    if (tests.status !== 0) { process.stderr.write("release blocked: tests failed\n"); return tests.status === null ? 1 : tests.status; }
  }
  if (opts.dryRun === true) {
    process.stdout.write("release check ok  " + PKG + "@" + version + " -> " + tag + " (dry run, no tag created)\n");
    return 0;
  }
  const args = opts.forceTag === true ? ["tag", "-f", "-a", tag, "-m", PKG + " " + version] : ["tag", "-a", tag, "-m", PKG + " " + version];
  const tagRun = spawnSync(git, args, { cwd: REPO, stdio: "inherit" });
  if (tagRun.status !== 0) return tagRun.status === null ? 1 : tagRun.status;
  process.stdout.write([
    "tagged " + tag,
    "",
    "publish with:",
    "  git push origin main",
    "  git push origin " + tag,
    "  (or: gh release create " + tag + " --notes-file CHANGELOG.md)",
    ""
  ].join("\n"));
  return 0;
}

// ---------- CLI ----------


function parseArgs(argv) {
  const out = { command: argv[0] === undefined ? "help" : String(argv[0]), profile: undefined, outDir: undefined, json: false, quiet: false, noBundles: false, noPnpm: false, keepOld: false, pathOnly: false, dryRun: false, allowDirty: false, skipTests: false, forceTag: false };
  for (let i = 1; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (a === "--profile" || a === "-p") { out.profile = argv[i + 1]; i += 1; continue; }
    if (a.startsWith("--profile=")) { out.profile = a.slice(10); continue; }
    if (a === "--json") { out.json = true; continue; }
    if (a === "--quiet" || a === "-q") { out.quiet = true; continue; }
    if (a === "--no-bundles") { out.noBundles = true; continue; }
    if (a === "--no-pnpm") { out.noPnpm = true; continue; }
    if (a === "--keep-old") { out.keepOld = true; continue; }
    if (a === "--path" || a === "--path-only") { out.pathOnly = true; continue; }
    if (a === "--out") { out.outDir = argv[i + 1]; i += 1; continue; }
    if (a.startsWith("--out=")) { out.outDir = a.slice(6); continue; }
    if (a === "--dry-run") { out.dryRun = true; continue; }
    if (a === "--allow-dirty") { out.allowDirty = true; continue; }
    if (a === "--skip-tests") { out.skipTests = true; continue; }
    if (a === "--force-tag") { out.forceTag = true; continue; }
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
    "  polaris token [--path]",
    "      打印写操作令牌（x-polaris-token）；--path 只打印文件路径。",
    "  polaris pack [--out <dir>] [--dry-run]",
    "      按 package.json 的 files[] 打出 tarball（默认 dist/）。--dry-run 只列清单。",
    "  polaris rollback [--profile <dir>]",
    "      用最近一次 install 留下的 package.json 备份恢复 profile 清单（然后重启宿主）。",
    "  polaris release [--dry-run] [--allow-dirty] [--skip-tests] [--force-tag]",
    "      发布闸门：校对版本/CHANGELOG/git 状态并跑测试，然后打带注释的 v<version> tag。",
    "  polaris version | help",
    ""
  ].join("\n"));
}

const opts = parseArgs(process.argv.slice(2));
if (opts.command === "install") process.exit(install(opts));
if (opts.command === "doctor") process.exit(render(doctor(opts), opts) === 0 ? 0 : 1);
if (opts.command === "token") process.exit(token(opts));
if (opts.command === "pack") process.exit(pack(opts));
if (opts.command === "rollback") process.exit(rollback(opts));
if (opts.command === "release") process.exit(release(opts));
if (opts.command === "version" || opts.command === "--version" || opts.command === "-v") {
  const pkg = readPkg(REPO);
  process.stdout.write(String(pkg === undefined || pkg.version === undefined ? "?" : pkg.version) + "\n");
  process.exit(0);
}
help();
process.exit(opts.command === "help" || opts.command === "--help" || opts.command === "-h" ? 0 : 2);

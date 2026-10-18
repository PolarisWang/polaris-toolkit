/**
 * 状态文件的版本 / 迁移 / 保留策略（评审 P2-10）。
 *
 * 之前的状况：journal 按天滚动但从不删旧文件，samples.csv 无限追加，
 * 各 feature 的 JSON 各自带 v 字段却"格式变了就当空文件"。长期高强度使用下，
 * 这些会变成新的磁盘与解析负担。这里提供三个小工具，由 host 在启动时统一调用：
 *
 *   loadVersioned(file, {version, migrations, fallback})  读 → 迁移 → 写回
 *   pruneFiles(dir, {match, keepDays})                    按 mtime 清理
 *   pruneCsv(file, {keepDays, maxRows})                   保留表头 + 近期行
 */
import fs from "node:fs";
import path from "node:path";

export function loadVersioned(file, options) {
  const opt = options === undefined || options === null ? {} : options;
  const version = typeof opt.version === "number" ? opt.version : 1;
  const fallback = typeof opt.fallback === "function" ? opt.fallback : () => ({});
  let raw;
  try { raw = JSON.parse(String(fs.readFileSync(file, "utf8")).replace(/^\uFEFF/, "")); } catch { return { value: fallback(), migrated: false, fresh: true }; }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { value: fallback(), migrated: false, fresh: true };
  let current = raw.v === undefined ? 0 : Number(raw.v);
  let value = raw.d !== undefined && raw.d !== null && typeof raw.d === "object" ? raw.d : raw;
  let migrated = false;
  const migrations = opt.migrations !== undefined && opt.migrations !== null && typeof opt.migrations === "object" ? opt.migrations : {};
  while (current < version) {
    const step = migrations[current];
    if (typeof step !== "function") { current = version; value = raw.d !== undefined ? raw.d : {}; break; }
    try {
      const next = step(value);
      value = next === undefined ? value : next;
    } catch { value = fallback(); }
    current += 1;
    migrated = true;
  }
  const out = { v: version, d: value };
  if (migrated || raw.v !== version) {
    try {
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, file);
    } catch { /* best effort */ }
  }
  return { value, migrated, fresh: false };
}

export function pruneFiles(dir, options) {
  const opt = options === undefined || options === null ? {} : options;
  const keepDays = Number.isFinite(Number(opt.keepDays)) ? Math.max(1, Number(opt.keepDays)) : 14;
  const match = opt.match instanceof RegExp ? opt.match : /^.*$/;
  const cutoff = Date.now() - keepDays * 86400000;
  const removed = [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return removed; }
  for (const name of names) {
    if (!match.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile() || st.mtimeMs >= cutoff) continue;
      fs.unlinkSync(full);
      removed.push(name);
    } catch { /* skip locked/unreadable */ }
  }
  return removed;
}

export function pruneCsv(file, options) {
  const opt = options === undefined || options === null ? {} : options;
  const keepDays = Number.isFinite(Number(opt.keepDays)) ? Math.max(1, Number(opt.keepDays)) : 14;
  const maxRows = Number.isFinite(Number(opt.maxRows)) ? Math.max(100, Number(opt.maxRows)) : 20000;
  const cutoff = Date.now() - keepDays * 86400000;
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return { trimmed: 0 }; }
  const lines = text.split(/\r?\n/).filter((line) => line !== "");
  if (lines.length <= 1) return { trimmed: 0 };
  const header = lines[0];
  const kept = [];
  for (let i = lines.length - 1; i >= 1; i -= 1) {
    const line = lines[i];
    const ts = Number(line.slice(0, line.indexOf(",")));
    if (Number.isFinite(ts) && ts < cutoff) break;
    kept.push(line);
    if (kept.length >= maxRows) break;
  }
  kept.reverse();
  const trimmed = lines.length - 1 - kept.length;
  if (trimmed <= 0) return { trimmed: 0 };
  try {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, [header, ...kept].join("\n") + "\n", "utf8");
    fs.renameSync(tmp, file);
  } catch { return { trimmed: 0 }; }
  return { trimmed };
}

export default { loadVersioned, pruneFiles, pruneCsv };

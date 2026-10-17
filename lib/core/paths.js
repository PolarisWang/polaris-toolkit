/**
 * Shared path + small-format helpers for polaris-toolkit.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** // The DSH home directory (DSH_HOME override, else ~/.dsh). */
export function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === "string" && env.length > 0) return path.resolve(env);
  return path.join(os.homedir(), ".dsh");
}

/** Toolkit state root: settings.json, per-feature subdirectories. */
export function stateDir(...parts) {
  return path.join(dshHome(), "polaris-toolkit", ...parts);
}

/** Per-feature state directory. */
export function featureDir(id, ...parts) {
  return stateDir("features", id, ...parts);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function sessionsRoot() {
  return path.join(dshHome(), "sessions");
}

/** Local compact timestamp, e.g. 20261017-154012. */
export function stamp(d) {
  const t = d === undefined ? new Date() : d;
  const p = (n) => String(n).padStart(2, "0");
  return String(t.getFullYear()) + p(t.getMonth() + 1) + p(t.getDate())
    + "-" + p(t.getHours()) + p(t.getMinutes()) + p(t.getSeconds());
}

export function iso(t) {
  return new Date(t).toISOString();
}

export function mb(n) {
  return (n / 1048576).toFixed(1);
}

export function round1(n) {
  return Math.round(n * 10) / 10;
}

/** RFC-4180-ish CSV cell quoting. */
export function csvCell(value) {
  const s = value === undefined || value === null ? "" : String(value);
  return /[",\r\n]/.test(s) ? '"' + s.split('"').join('""') + '"' : s;
}

export function csvRow(cells) {
  return cells.map(csvCell).join(",") + "\n";
}

/** Append one row to a CSV, creating it with the header on first use. */
export function appendCsv(file, header, cells) {
  ensureDir(path.dirname(file));
  let exists = false;
  try { exists = fs.statSync(file).size > 0; } catch { exists = false; }
  const text = (exists ? "" : csvRow(header)) + csvRow(cells);
  fs.appendFileSync(file, text, "utf8");
}

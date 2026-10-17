/**
 * billionaire-context (bili) proxy observability + on-disk budget editing.
 *
 * Fact baseline (measured in billion-context/dist/index.js):
 *   - config file: <XDG_CONFIG_HOME|~/.config>/billion-context/billion-context.json
 *     (BILI_CONFIG_FILE overrides). The proxy re-reads it on every loadConfigFile()
 *     call and invalidates its cache when the raw text changes, so edits are picked
 *     up live by per-call getters such as the gc worker.
 *   - sessions.max (default 256), sessions.warmMax (8), sessions.warmMaxBytes (64 MiB),
 *     sessions.residentMaxBytes (512 MiB) are captured ONCE when the proxy module
 *     loads, so THESE need a bili proxy restart (which follows a DSH restart).
 *   - sessions.gc = { enabled, maxAgeDays 7, maxTokens 1e6, intervalMs 36e5 }:
 *     deleting the proxy's cached sessions; off unless explicitly enabled.
 *   - the proxy listens on 127.0.0.1:18788 and exposes read-only GET /__bili/overview,
 *     /__bili/sessions, /__bili/cache-report, /__bili/config.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function biliConfigFile() {
  const env = process.env.BILI_CONFIG_FILE;
  if (typeof env === "string" && env.length > 0) return path.resolve(env);
  const xdg = typeof process.env.XDG_CONFIG_HOME === "string" && process.env.XDG_CONFIG_HOME.length > 0
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), ".config");
  return path.join(xdg, "billion-context", "billion-context.json");
}

export function readBiliConfig() {
  try {
    const text = fs.readFileSync(biliConfigFile(), "utf8").replace(/^\uFEFF/, "");
    const value = JSON.parse(text);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
    return {};
  } catch {
    return {};
  }
}

const MIB = 1048576;

/** Normalized view of the session budget, defaults filled in. */
export function biliBudget(config) {
  const cfg = config === undefined ? readBiliConfig() : config;
  const s = cfg.sessions === undefined || cfg.sessions === null ? {} : cfg.sessions;
  const gc = s.gc === undefined || s.gc === null ? {} : s.gc;
  return {
    file: biliConfigFile(),
    max: typeof s.max === "number" ? s.max : 256,
    residentMaxMB: Math.round((typeof s.residentMaxBytes === "number" ? s.residentMaxBytes : 512 * MIB) / MIB),
    warmMax: typeof s.warmMax === "number" ? s.warmMax : 8,
    warmMaxBytesMB: Math.round((typeof s.warmMaxBytes === "number" ? s.warmMaxBytes : 64 * MIB) / MIB),
    gcEnabled: gc.enabled === true,
    gcMaxAgeDays: typeof gc.maxAgeDays === "number" ? gc.maxAgeDays : 7,
    gcMaxTokens: typeof gc.maxTokens === "number" ? gc.maxTokens : 1e6,
    gcIntervalMs: typeof gc.intervalMs === "number" ? gc.intervalMs : 36e5,
    raw: cfg
  };
}

/**
 * Merge a budget patch into the bili config file.
 * patch: { max?, residentMaxMB?, warmMax?, warmMaxBytesMB?, gcEnabled?, gcMaxAgeDays?, gcMaxTokens? }
 */
export function applyBiliBudget(patch) {
  const file = biliConfigFile();
  const cfg = readBiliConfig();
  const before = biliBudget(cfg);
  const sessions = cfg.sessions === undefined || cfg.sessions === null || typeof cfg.sessions !== "object"
    ? {} : { ...cfg.sessions };
  if (typeof patch.max === "number") sessions.max = Math.max(1, Math.floor(patch.max));
  if (typeof patch.residentMaxMB === "number") sessions.residentMaxBytes = Math.max(16, Math.floor(patch.residentMaxMB)) * MIB;
  if (typeof patch.warmMax === "number") sessions.warmMax = Math.max(1, Math.floor(patch.warmMax));
  if (typeof patch.warmMaxBytesMB === "number") sessions.warmMaxBytes = Math.max(1, Math.floor(patch.warmMaxBytesMB)) * MIB;
  if (patch.gcEnabled !== undefined || patch.gcMaxAgeDays !== undefined || patch.gcMaxTokens !== undefined) {
    const gc = sessions.gc === undefined || sessions.gc === null || typeof sessions.gc !== "object" ? {} : { ...sessions.gc };
    if (patch.gcEnabled !== undefined) gc.enabled = patch.gcEnabled === true;
    if (typeof patch.gcMaxAgeDays === "number") gc.maxAgeDays = patch.gcMaxAgeDays;
    if (typeof patch.gcMaxTokens === "number") gc.maxTokens = patch.gcMaxTokens;
    sessions.gc = gc;
  }
  const next = { ...cfg, sessions };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".heap-guard.tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
  return { file, before, after: biliBudget(next) };
}

/** GET /__bili/<path> on the proxy; undefined when it is not answering. */
export async function fetchBili(baseUrl, route, timeoutMs) {
  const url = baseUrl + route;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs === undefined ? 3000 : timeoutMs) });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { status: res.status, text: text.slice(0, 4000) }; }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
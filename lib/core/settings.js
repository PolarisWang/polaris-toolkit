/**
 * Live settings store for the whole toolkit: one JSON file, namespaced by
 * feature id, re-read on every access so an edit takes effect immediately
 * (no restart) and every surface sees the same value.
 *
 *   <stateDir>/settings.json
 *   { "heap-guard": { "autoSlim": true, "slimLevel": 3 } }
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./paths.js";

function parseObject(text) {
  try {
    const value = JSON.parse(String(text).replace(/^\uFEFF/, ""));
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    /* fall through: a corrupt file behaves like an empty one */
  }
  return {};
}

export function createSettingsStore(dir) {
  const root = ensureDir(dir);
  const file = path.join(root, "settings.json");

  function readFile() {
    try { return parseObject(fs.readFileSync(file, "utf8")); } catch { return {}; }
  }

  function writeFile(value) {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
  }

  /** One feature's namespace. defaults supplies both the shape and the values. */
  function feature(id, defaults) {
    const base = defaults !== null && typeof defaults === "object" ? defaults : {};

    function all() {
      const stored = readFile()[id];
      const src = stored !== null && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
      const out = {};
      for (const key of Object.keys(base)) out[key] = src[key] === undefined ? base[key] : src[key];
      for (const key of Object.keys(src)) if (!(key in out)) out[key] = src[key];
      return out;
    }

    function get(key) {
      const value = all()[key];
      return value === undefined ? base[key] : value;
    }

    function set(patch) {
      const value = readFile();
      const current = value[id] !== null && typeof value[id] === "object" && !Array.isArray(value[id]) ? value[id] : {};
      const next = { ...current };
      for (const key of Object.keys(patch === null || patch === undefined ? {} : patch)) {
        const v = patch[key];
        if (v === null || v === undefined || v === "") delete next[key];
        else next[key] = v;
      }
      value[id] = next;
      writeFile(value);
      return all();
    }

    return { id, file, defaults: base, all, get, set };
  }

  return { dir: root, file, read: readFile, write: writeFile, feature };
}

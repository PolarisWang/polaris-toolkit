/**
 * Live settings store for the whole toolkit: one JSON file, namespaced by
 * feature id, re-read on every access so an edit takes effect immediately
 * (no restart) and every surface sees the same value.
 *
 *   <stateDir>/settings.json
 *   { "heap-guard": { "autoSlim": true, "slimLevel": 3 } }
 *
 * 文件是带版本的信封（P2-10）：
 *   { "v": 1, "d": { "heap-guard": { ... } } }
 * 老版本（直接就是 { "heap-guard": ... } 的裸映射）由 loadVersioned 当成 v0 自动升级，
 * 以后改结构只要写一条 migration，不用再"读失败就当空文件"。
 *
 * 两条评审结论落在这里（P1-6）：
 *   - 深合并：嵌套对象逐层合并（以前只合并第一层，改 steward.classifier.model
 *     会把同级字段整块覆盖掉）；数组整体替换；null / undefined / "" 仍然删除键。
 *   - 可选校验：feature 可以导出 settingsSchema（schemastery），写入前对
 *     "合并后的完整对象"校验，非法 patch 抛 SettingsError → 路由回 400，
 *     并且绝对不落盘。
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./paths.js";
import { loadVersioned } from "./statefile.js";

/** 当前 settings 文件的结构版本；改结构就 +1 并在 SETTINGS_MIGRATIONS 里补一条。 */
export const SETTINGS_VERSION = 1;

/**
 * from → from+1 的迁移。v0 是"裸映射"，v1 起是 { v, d } 信封，内容不变，
 * 所以这条迁移只是把裸映射原样带过来。
 */
const SETTINGS_MIGRATIONS = {
  0: (value) => (isPlainObject(value) ? value : {})
};

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value)) out[key] = cloneValue(value[key]);
  return out;
}

/** 深合并：嵌套对象递归，数组/标量覆盖，null | undefined | "" 删除。 */
export function deepMerge(base, patch) {
  const out = isPlainObject(base) ? cloneValue(base) : {};
  if (!isPlainObject(patch)) return out;
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === null || value === undefined || value === "") { delete out[key]; continue; }
    if (isPlainObject(value) && isPlainObject(out[key])) { out[key] = deepMerge(out[key], value); continue; }
    out[key] = cloneValue(value);
  }
  return out;
}

export class SettingsError extends Error {
  constructor(message, feature) {
    super(message);
    this.name = "SettingsError";
    this.code = "invalid-settings";
    this.feature = feature === undefined ? "" : feature;
  }
}

export function createSettingsStore(dir) {
  const root = ensureDir(dir);
  const file = path.join(root, "settings.json");

  /** 读整份文档（已迁移到当前版本；裸映射会被 loadVersioned 就地升级成信封）。 */
  function readFile() {
    const loaded = loadVersioned(file, { version: SETTINGS_VERSION, migrations: SETTINGS_MIGRATIONS, fallback: () => ({}) });
    return isPlainObject(loaded.value) ? loaded.value : {};
  }

  function writeFile(value) {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ v: SETTINGS_VERSION, d: isPlainObject(value) ? value : {} }, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
  }

  /** One feature's namespace. defaults supplies both the shape and the values. */
  function feature(id, defaults, options) {
    const opt = options === undefined || options === null ? {} : options;
    const schema = typeof opt.schema === "function" ? opt.schema : undefined;
    const base = isPlainObject(defaults) ? defaults : {};

    function all() {
      const stored = readFile()[id];
      const src = isPlainObject(stored) ? stored : {};
      return deepMerge(deepMerge({}, base), src);
    }

    function get(key) {
      const value = all()[key];
      return value === undefined ? base[key] : value;
    }

    /** 校验合并后的完整对象；没有 schema 时原样返回。 */
    function check(value) {
      if (schema === undefined) return value;
      try {
        schema(value);
        return value;
      } catch (error) {
        const text = String(error === undefined || error === null ? "invalid settings" : error.message || error);
        throw new SettingsError(text.replace(/^ValidationError:\s*/, ""), id);
      }
    }

    function validate(patch) {
      const current = readFile()[id];
      const merged = deepMerge(isPlainObject(current) ? current : {}, isPlainObject(patch) ? patch : {});
      try { return { ok: true, value: check(merged) }; } catch (error) { return { ok: false, error: String(error.message || error), feature: id }; }
    }

    /** 只校验、不读不写：给"整份替换 settings.json"用（P1-A 的原始 JSON 编辑）。 */
    function checkSlice(value) {
      try { return { ok: true, value: check(isPlainObject(value) ? value : {}) }; } catch (error) { return { ok: false, error: String(error.message || error), feature: id }; }
    }

    function set(patch) {
      const doc = readFile();
      const current = isPlainObject(doc[id]) ? doc[id] : {};
      const merged = deepMerge(current, isPlainObject(patch) ? patch : {});
      doc[id] = check(merged);
      writeFile(doc);
      return all();
    }

    return { id, file, defaults: base, schema, all, get, set, validate, checkSlice };
  }

  /** 磁盘上的原始文档（含版本信封）：面板"直接编辑全文"读它。 */
  function raw() {
    return { v: SETTINGS_VERSION, d: readFile() };
  }

  /**
   * 用一整份文档替换（P1-A "灵活"）：接受 {v,d} 信封或裸的 {featureId:{...}} 映射。
   * 校验由调用方按 feature 逐个做（feature.checkSlice），这里只负责落盘。
   */
  function replace(doc) {
    const body = isPlainObject(doc) && isPlainObject(doc.d) ? doc.d : doc;
    if (!isPlainObject(body)) throw new SettingsError("settings must be a JSON object with feature keys", "");
    writeFile(body);
    return raw();
  }

  return { dir: root, file, read: readFile, write: writeFile, raw, replace, feature };
}

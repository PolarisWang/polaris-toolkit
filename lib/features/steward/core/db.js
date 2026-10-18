/**
 * 持久层：一张表 API，两个后端。
 *
 *   createDb({ dir, log, backend }) -> db
 *     backend: "sqlite" | "json" | "auto"（默认 auto：能拿到 node:sqlite 就用它）
 *
 * 为什么不是裸 SQL：工作流/规则/审批都要跑两套后端（宿主里可能是被裁剪过的
 * Electron 内建，离线自测是完整 node），表 API 让两条路径共用同一份业务代码，
 * 也让测试可以矩阵化。SQLite 后端仍是 WAL，JSONL 后端是快照 + 操作日志重放。
 */
import fs from "node:fs";
import path from "node:path";
import { TABLES, TABLE_NAMES, isIntColumn, pkOf } from "./schema.js";

const OPS_COMPACT = 512;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** TEXT 列里的对象/数组以 JSON 文本存放；读回时按首字符判断，解析失败就原样返回。 */
function encodeText(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function decodeText(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (s.length > 1 && (s.charCodeAt(0) === 123 || s.charCodeAt(0) === 91)) {
    try { return JSON.parse(s); } catch { return s; }
  }
  return s;
}

function normalizeRow(table, row) {
  const spec = TABLES[table];
  const out = {};
  for (const col of spec.cols) {
    if (row[col] === undefined) continue;
    const v = row[col];
    if (v === null) { out[col] = null; continue; }
    out[col] = isIntColumn(table, col) ? (typeof v === "boolean" ? (v ? 1 : 0) : Number(v)) : v;
  }
  return out;
}

function keyOf(table, row) {
  return pkOf(table).map((c) => String(row[c])).join("\u0001");
}

function keyFrom(table, pk) {
  const cols = pkOf(table);
  if (cols.length === 1) return String(pk !== null && typeof pk === "object" ? pk[cols[0]] : pk);
  return cols.map((c) => String(pk[c])).join("\u0001");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/* ------------------------------------------------------------------ sqlite */

function openSqlite(dir, log) {
  let sqlite;
  try {
    sqlite = typeof process.getBuiltinModule === "function" ? process.getBuiltinModule("node:sqlite") : undefined;
  } catch (error) {
    log("warn", "node:sqlite probe failed: " + String(error));
    sqlite = undefined;
  }
  if (sqlite === undefined || sqlite === null || typeof sqlite.DatabaseSync !== "function") return undefined;
  let handle;
  try {
    handle = new sqlite.DatabaseSync(path.join(dir, "steward.db"));
    handle.exec("PRAGMA journal_mode = WAL");
    handle.exec("PRAGMA synchronous = NORMAL");
    for (const name of TABLE_NAMES) {
      const spec = TABLES[name];
      const cols = spec.cols.map((c) => '"' + c + '" ' + (isIntColumn(name, c) ? "INTEGER" : "TEXT"));
      const pk = pkOf(name);
      const tail = pk.length === 1 ? ", PRIMARY KEY (\"" + pk[0] + "\")" : ", PRIMARY KEY (" + pk.map((c) => '"' + c + '"').join(", ") + ")";
      handle.exec('CREATE TABLE IF NOT EXISTS "' + name + '" (' + cols.join(", ") + tail + ")");
      // 轻量迁移：CREATE TABLE IF NOT EXISTS 不会给老库补列，缺的列在这里补上
      // （schema.js 是唯一的事实来源，补列让老 steward.db 也能跟上新字段）。
      try {
        const have = new Set(handle.prepare('PRAGMA table_info("' + name + '")').all().map((r) => String(r.name)));
        for (const col of spec.cols) {
          if (have.has(col)) continue;
          handle.exec('ALTER TABLE "' + name + '" ADD COLUMN "' + col + '" ' + (isIntColumn(name, col) ? "INTEGER" : "TEXT"));
        }
      } catch (error) {
        log("warn", "sqlite migrate " + name + " failed: " + String(error));
      }
      const indexes = Array.isArray(spec.indexes) ? spec.indexes : [];
      for (const col of indexes) {
        if (spec.cols.indexOf(col) < 0) continue;
        handle.exec('CREATE INDEX IF NOT EXISTS "idx_' + name + "_" + col + '" ON "' + name + '" ("' + col + '")');
      }
    }
  } catch (error) {
    log("warn", "sqlite open failed, falling back to json: " + String(error));
    try { if (handle !== undefined) handle.close(); } catch { /* ignore */ }
    return undefined;
  }

  const api = {
    backend: "sqlite",
    insert(table, row) {
      const spec = TABLES[table];
      const shaped = normalizeRow(table, row);
      if (spec.auto === true && shaped[spec.pk] === undefined) {
        const max = handle.prepare('SELECT COALESCE(MAX("' + spec.pk + '"), 0) AS m FROM "' + table + '"').get();
        shaped[spec.pk] = Number(max === undefined || max === null ? 0 : max.m) + 1;
      }
      const cols = Object.keys(shaped);
      const sql = 'INSERT OR REPLACE INTO "' + table + '" (' + cols.map((c) => '"' + c + '"').join(", ") + ") VALUES (" + cols.map(() => "?").join(", ") + ")";
      handle.prepare(sql).run(...cols.map((c) => (isIntColumn(table, c) ? shaped[c] : encodeText(shaped[c]))));
      return shaped;
    },
    update(table, pk, fields) {
      const shaped = normalizeRow(table, fields);
      const cols = Object.keys(shaped);
      if (cols.length === 0) return this.get(table, pk);
      const where = pkOf(table);
      const sql = 'UPDATE "' + table + '" SET ' + cols.map((c) => '"' + c + '" = ?').join(", ") + " WHERE " + where.map((c) => '"' + c + '" = ?').join(" AND ");
      handle.prepare(sql).run(...cols.map((c) => (isIntColumn(table, c) ? shaped[c] : encodeText(shaped[c]))), ...where.map((c) => String(pk[c])));
      return this.get(table, pk);
    },
    get(table, pk) {
      const where = pkOf(table);
      const sql = 'SELECT * FROM "' + table + '" WHERE ' + where.map((c) => '"' + c + '" = ?').join(" AND ");
      const row = handle.prepare(sql).get(...where.map((c) => String(pk[c])));
      return row === undefined ? undefined : decodeRow(table, row);
    },
    all(table) {
      return handle.prepare('SELECT * FROM "' + table + '"').all().map((r) => decodeRow(table, r));
    },
    remove(table, pk) {
      const where = pkOf(table);
      handle.prepare('DELETE FROM "' + table + '" WHERE ' + where.map((c) => '"' + c + '" = ?').join(" AND ")).run(...where.map((c) => String(pk[c])));
    },
    find(table, where) {
      const cols = Object.keys(where === undefined ? {} : where);
      const sql = 'SELECT * FROM "' + table + '"' + (cols.length === 0 ? "" : " WHERE " + cols.map((c) => '"' + c + '" = ?').join(" AND "));
      const rows = handle.prepare(sql).all(...cols.map((c) => (isIntColumn(table, c) ? Number(where[c]) : encodeText(where[c]))));
      return rows.map((r) => decodeRow(table, r));
    },
    flush() { /* sqlite 自己落盘 */ },
    close() { try { handle.close(); } catch { /* ignore */ } }
  };
  return api;
}

function decodeRow(table, row) {
  const spec = TABLES[table];
  const out = {};
  for (const col of spec.cols) {
    if (row[col] === undefined) continue;
    out[col] = isIntColumn(table, col) ? Number(row[col]) : decodeText(row[col]);
  }
  return out;
}

/* -------------------------------------------------------------------- json */

function openJson(dir, log) {
  const file = path.join(dir, "steward.db.json");
  const opsFile = path.join(dir, "steward.ops.jsonl");
  const state = { seq: 0, tables: {}, seqs: {} };
  for (const name of TABLE_NAMES) state.tables[name] = {};

  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (isPlainObject(parsed)) {
        state.seq = Number(parsed.seq === undefined ? 0 : parsed.seq) || 0;
        state.seqs = isPlainObject(parsed.seqs) ? parsed.seqs : {};
        for (const name of TABLE_NAMES) {
          const rows = parsed.tables === undefined ? undefined : parsed.tables[name];
          if (isPlainObject(rows)) state.tables[name] = rows;
        }
      }
    } catch (error) {
      log("warn", "json store snapshot unreadable, starting empty: " + String(error));
    }
  }

  let ops = [];
  if (fs.existsSync(opsFile)) {
    const text = fs.readFileSync(opsFile, "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let op;
      try { op = JSON.parse(line); } catch { continue; }
      if (!isPlainObject(op) || typeof op.seq !== "number" || op.seq <= state.seq) continue;
      applyOp(state, op);
      state.seq = Math.max(state.seq, op.seq);
    }
  }

  let dirty = false;
  let closed = false;

  function persist() {
    if (!dirty || closed) return;
    try {
      const snapshot = { v: 1, seq: state.seq, seqs: state.seqs, tables: state.tables };
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(snapshot), "utf8");
      fs.renameSync(tmp, file);
      if (ops.length > OPS_COMPACT) {
        fs.writeFileSync(opsFile, ops.join("\n") + "\n", "utf8");
        ops = [];
      }
      dirty = false;
    } catch (error) {
      log("warn", "json store persist failed: " + String(error));
    }
  }

  function record(op) {
    state.seq += 1;
    op.seq = state.seq;
    ops.push(JSON.stringify(op));
    applyOp(state, op);
    dirty = true;
  }

  function tableOf(name) {
    if (state.tables[name] === undefined) state.tables[name] = {};
    return state.tables[name];
  }

  const api = {
    backend: "json",
    insert(table, row) {
      const spec = TABLES[table];
      const shaped = normalizeRow(table, row);
      if (spec.auto === true && shaped[spec.pk] === undefined) {
        state.seqs[table] = Number(state.seqs[table] === undefined ? 0 : state.seqs[table]) + 1;
        shaped[spec.pk] = state.seqs[table];
      }
      if (spec.auto === true) state.seqs[table] = Math.max(Number(state.seqs[table] === undefined ? 0 : state.seqs[table]), Number(shaped[spec.pk]));
      record({ t: "set", table, key: keyOf(table, shaped), row: shaped });
      return shaped;
    },
    update(table, pk, fields) {
      const current = this.get(table, pk);
      if (current === undefined) return undefined;
      const next = Object.assign({}, current, normalizeRow(table, fields));
      record({ t: "set", table, key: keyOf(table, next), row: next });
      return next;
    },
    get(table, pk) {
      const row = tableOf(table)[keyFrom(table, pk)];
      return row === undefined ? undefined : Object.assign({}, row);
    },
    all(table) {
      return Object.keys(tableOf(table)).map((k) => Object.assign({}, tableOf(table)[k]));
    },
    remove(table, pk) {
      record({ t: "del", table, key: keyFrom(table, pk) });
    },
    find(table, where) {
      const cols = Object.keys(where === undefined ? {} : where);
      return this.all(table).filter((row) => cols.every((c) => String(row[c]) === String(where[c]) || Number(row[c]) === Number(where[c])));
    },
    flush() { persist(); },
    close() { persist(); closed = true; }
  };
  return api;
}

function applyOp(state, op) {
  const table = state.tables[op.table];
  if (table === undefined) return;
  if (op.t === "set") table[op.key] = op.row;
  else if (op.t === "del") delete table[op.key];
}

/* ------------------------------------------------------------------- entry */

export function createDb(options) {
  const opt = options === undefined || options === null ? {} : options;
  const dir = typeof opt.dir === "string" ? opt.dir : ".";
  const log = typeof opt.log === "function" ? opt.log : () => {};
  const wanted = typeof opt.backend === "string" ? opt.backend : "auto";
  ensureDir(dir);
  if (wanted === "sqlite" || wanted === "auto") {
    const sqlite = openSqlite(dir, log);
    if (sqlite !== undefined) return decorate(sqlite);
    if (wanted === "sqlite") log("warn", "sqlite requested but unavailable; using json");
  }
  return decorate(openJson(dir, log));
}

/** 在通用表 API 上加几个跨表便利方法；两个后端共用。 */
function decorate(db) {
  db.count = function count(table, where) {
    return where === undefined ? db.all(table).length : db.find(table, where).length;
  };
  db.bySubject = function bySubject(table, subject) {
    return db.all(table).filter((r) => r.subject === subject);
  };
  db.closeSafely = function closeSafely() { try { db.close(); } catch { /* ignore */ } };
  return db;
}
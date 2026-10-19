// A small Cloudflare-D1-compatible wrapper around Node's built-in SQLite.
// Lets the exact same app code run locally, in tests, or on any Node host.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

class Bound {
  constructor(db, sql, params) { this.db = db; this.sql = sql; this.params = params; }
  _stmt() { return this.db.prepare(this.sql); }
  async first(col) {
    const row = this._stmt().get(...this.params);
    if (!row) return null;
    const r = { ...row };
    return col ? r[col] : r;
  }
  async all() { return { success: true, results: this._stmt().all(...this.params).map((r) => ({ ...r })), meta: {} }; }
  async run() { return this._runSync(); }
  _runSync() {
    const s = this._stmt();
    if (/\breturning\b/i.test(this.sql)) {
      const results = s.all(...this.params).map((r) => ({ ...r }));
      return { success: true, results, meta: { changes: results.length } };
    }
    const r = s.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

class Prepared {
  constructor(db, sql) { this.db = db; this.sql = sql; }
  bind(...params) { return new Bound(this.db, this.sql, params); }
  first(col) { return this.bind().first(col); }
  all() { return this.bind().all(); }
  run() { return this.bind().run(); }
}

export class SqliteD1 {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  }
  prepare(sql) { return new Prepared(this.db, sql); }
  async batch(list) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = list.map((b) => b._runSync());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }
  async exec(sql) { this.db.exec(sql); return { count: 1 }; }
}

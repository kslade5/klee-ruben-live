// Database access. Works with Cloudflare D1 in production and with a D1-compatible
// wrapper around Node's built-in SQLite (src/d1-sqlite.mjs) for local runs and tests.
// D1 has no interactive transactions: multi-step writes use batch() (atomic) and
// "claim" updates guarded by UNIQUE constraints, so retries can never double-count.
import { MIGRATIONS } from './migrations/index.mjs';

let D = null;
export function setDb(d1) { D = d1; ready = null; }
export function getDb() { if (!D) throw new Error('Database not configured'); return D; }

const norm = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
export const stmt = (sql, ...p) => getDb().prepare(sql).bind(...norm(p));
export const one = async (sql, ...p) => (await stmt(sql, ...p).first()) ?? undefined;
export const all = async (sql, ...p) => (await stmt(sql, ...p).all()).results || [];
export const run = async (sql, ...p) => {
  const r = await stmt(sql, ...p).run();
  return { changes: r.meta?.changes ?? 0, lastInsertRowid: r.meta?.last_row_id ?? null };
};
// Atomic: all statements commit together or none do. Pass [sql, ...params] tuples.
export async function batch(list) {
  if (!list.length) return [];
  const res = await getDb().batch(list.map(([sql, ...p]) => stmt(sql, ...p)));
  return res.map((r) => ({ changes: r.meta?.changes ?? 0, lastInsertRowid: r.meta?.last_row_id ?? null, results: r.results }));
}
export const now = () => new Date().toISOString();

// Split a migration file into statements (statements end with ";" at the end of a line).
function splitSql(sql) {
  const out = [];
  let cur = [];
  for (const line of sql.split('\n')) {
    if (!cur.length && (/^\s*--/.test(line) || !line.trim())) continue;
    cur.push(line);
    if (line.trimEnd().endsWith(';')) { out.push(cur.join('\n')); cur = []; }
  }
  if (cur.join('').trim()) out.push(cur.join('\n'));
  return out;
}

let ready = null;
export function migrate() {
  ready ||= (async () => {
    await run(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
    const done = new Set((await all('SELECT name FROM schema_migrations')).map((r) => r.name));
    for (const [name, sql] of MIGRATIONS) {
      if (done.has(name)) continue;
      const stmts = splitSql(sql).map((s) => [s]);
      stmts.push(['INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)', name, now()]);
      await batch(stmts);
      console.log(`[db] applied migration ${name}`);
    }
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

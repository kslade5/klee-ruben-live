// Node hosts: writes a consistent snapshot of the database. node scripts/backup.mjs [output-file]
// (On Cloudflare, D1 keeps automatic point-in-time backups for 30 days: Dashboard → D1 → Time Travel.)
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const src = process.env.DATABASE_PATH || path.join(ROOT, 'data', 'event.db');
const out = process.argv[2] || path.join(path.dirname(src), `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
new DatabaseSync(src).exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
console.log(`Backup written to ${out}`);

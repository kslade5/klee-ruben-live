// Create (or reset) an organizer account in a local/Node database.
// Usage: node scripts/create-admin.mjs --email you@example.com --name "Your Name" --role owner
// The password is read from ADMIN_PASSWORD, or prompted for.
// (On Cloudflare, use the /admin/setup link instead.)
import readline from 'node:readline';
import path from 'node:path';
import { SqliteD1 } from '../src/d1-sqlite.mjs';
import { setDb, migrate, one, run, now } from '../src/db.mjs';
import { hashPassword } from '../src/lib/security.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const email = (arg('email') || '').toLowerCase().trim();
const name = arg('name') || email.split('@')[0];
const role = arg('role') || 'owner';
if (!email.includes('@') || !['owner', 'admin', 'viewer'].includes(role)) {
  console.error('Usage: node scripts/create-admin.mjs --email you@example.com --name "Your Name" --role owner|admin|viewer');
  process.exit(1);
}
async function askPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const pw = await new Promise((r) => rl.question('Password (12+ characters): ', r));
  rl.close();
  return pw;
}
const pw = await askPassword();
if (pw.length < 12) { console.error('Password must be at least 12 characters.'); process.exit(1); }
setDb(new SqliteD1(process.env.DATABASE_PATH || path.join(ROOT, 'data', 'event.db')));
await migrate();
const existing = await one('SELECT id FROM admins WHERE email = ?', email);
const hash = await hashPassword(pw);
if (existing) {
  await run('UPDATE admins SET password_hash = ?, role = ?, name = ?, disabled = 0, failed_logins = 0, locked_until = NULL WHERE id = ?', hash, role, name, existing.id);
  await run('DELETE FROM admin_sessions WHERE admin_id = ?', existing.id);
  console.log(`Updated ${email} (${role}).`);
} else {
  await run('INSERT INTO admins (email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', email, name, role, hash, now());
  console.log(`Created ${email} (${role}).`);
}

// Admin authentication: scrypt passwords, server-side sessions, CSRF tokens, role checks, lockout.
import { one, run, now } from '../db.mjs';
import { randomToken, sha256, verifyPassword, timingSafeEqualStr } from './security.mjs';
import { parseCookies, setCookie, ipHash, HttpError } from './http.mjs';
import { audit } from './audit.mjs';

const COOKIE = 'kr_admin';
const SESSION_HOURS = 12;
export const ROLE_RANK = { viewer: 1, admin: 2, owner: 3 };
// Dummy hash so failed lookups take the same time as real ones.
const DUMMY = 'pbkdf2$20000$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(43) + '=';

export async function login(req, res, email, password) {
  const admin = await one('SELECT * FROM admins WHERE email = ?', String(email || '').trim());
  const ok = await verifyPassword(String(password || ''), admin?.password_hash || DUMMY);
  if (!admin || admin.disabled) return { ok: false, message: 'Email or password is incorrect.' };
  if (admin.locked_until && new Date(admin.locked_until) > new Date()) return { ok: false, message: 'Too many failed attempts. Try again in 15 minutes.' };
  if (!ok) {
    const fails = admin.failed_logins + 1;
    await run('UPDATE admins SET failed_logins = ?, locked_until = ? WHERE id = ?', fails, fails >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null, admin.id);
    await audit({ actor: `admin:${admin.id}`, action: 'admin.login_failed', ipHash: ipHash(req) });
    return { ok: false, message: 'Email or password is incorrect.' };
  }
  const token = randomToken(32);
  const t = now();
  await run('INSERT INTO admin_sessions (token_hash, admin_id, csrf_token, created_at, expires_at, ip_hash, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sha256(token), admin.id, randomToken(24), t, new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString(), ipHash(req), String(req.headers['user-agent'] || '').slice(0, 300));
  await run('UPDATE admins SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', t, admin.id);
  await run('DELETE FROM admin_sessions WHERE expires_at < ?', t);
  setCookie(res, COOKIE, token, { maxAge: SESSION_HOURS * 3600, sameSite: 'Strict' });
  await audit({ actor: `admin:${admin.id}`, action: 'admin.login', ipHash: ipHash(req) });
  return { ok: true };
}

export async function logout(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) await run('DELETE FROM admin_sessions WHERE token_hash = ?', sha256(token));
  setCookie(res, COOKIE, '', { maxAge: 0, sameSite: 'Strict' });
}

export async function currentAdmin(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const row = await one(
    `SELECT a.id, a.email, a.name, a.role, a.disabled, s.csrf_token, s.expires_at FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?`,
    sha256(token));
  if (!row || row.disabled || new Date(row.expires_at) < new Date()) return null;
  return row;
}

export function requireRole(admin, role) {
  if (!admin) throw new HttpError(401, 'Sign in required');
  if (ROLE_RANK[admin.role] < ROLE_RANK[role]) throw new HttpError(403, `This action needs the ${role} role.`);
}

// Double protection on every admin form POST: same-origin check + per-session CSRF token.
export function checkCsrf(req, admin, body) {
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (origin && origin !== 'null' && new URL(origin).host !== host) throw new HttpError(403, 'Cross-site request blocked.');
  if (!body || !timingSafeEqualStr(body._csrf || '', admin.csrf_token)) throw new HttpError(403, 'Your session expired. Reload the page and try again.');
}

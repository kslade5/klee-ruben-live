import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { config } from '../config.mjs';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const keyedHash = (s) => crypto.createHmac('sha256', config.hashSalt).update(String(s)).digest('hex').slice(0, 32);
export const uuid = () => crypto.randomUUID();

// Human-friendly codes without look-alike characters (no 0/O, 1/I/L).
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function friendlyCode(len) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHA[bytes[i] % ALPHA.length];
  return s;
}

export function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Password hashing: PBKDF2-SHA256 through the platform's native Web Crypto.
// The iteration count is sized for Cloudflare's free-plan CPU budget; admin logins
// are additionally protected by rate limiting, lockout and a 12-character minimum.
const ITER = 20000;
async function pbkdf2(pw, salt, iter) {
  const key = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return Buffer.from(bits);
}
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `pbkdf2$${ITER}$${salt.toString('base64')}$${(await pbkdf2(pw, salt, ITER)).toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  try {
    const [alg, iter, saltB64, hashB64] = String(stored).split('$');
    if (alg !== 'pbkdf2') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const got = await pbkdf2(String(pw), Buffer.from(saltB64, 'base64'), Number(iter));
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

// Short-lived signed values (e.g. "form rendered at" timestamps for bot checks).
export function sign(value) {
  const mac = crypto.createHmac('sha256', config.hashSalt).update(String(value)).digest('base64url').slice(0, 22);
  return `${value}.${mac}`;
}
export function unsign(signed) {
  const s = String(signed || '');
  const i = s.lastIndexOf('.');
  if (i < 0) return null;
  const value = s.slice(0, i);
  return timingSafeEqualStr(sign(value), s) ? value : null;
}

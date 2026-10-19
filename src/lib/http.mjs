// HTTP toolkit used by every route. Handlers receive a small `req` view of the incoming
// request and a `res` collector; app.mjs turns the collector into a standard Response.
import { Buffer } from 'node:buffer';
import { config } from '../config.mjs';
import { keyedHash } from './security.mjs';
import { run, one } from '../db.mjs';

const MAX_BODY = 256 * 1024;

export async function readRawBody(req, limit = MAX_BODY) {
  const buf = await req.body();
  if (buf.length > limit) throw Object.assign(new Error('Request body too large'), { status: 413 });
  return buf;
}

export async function readBody(req) {
  const buf = await readRawBody(req);
  const type = (req.headers['content-type'] || '').split(';')[0].trim();
  const text = buf.toString('utf8');
  if (type === 'application/json') {
    try { return JSON.parse(text || '{}'); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
  }
  if (type === 'application/x-www-form-urlencoded') {
    const out = {};
    for (const [k, v] of new URLSearchParams(text)) {
      if (k.endsWith('[]')) (out[k.slice(0, -2)] ||= []).push(v);
      else out[k] = v;
    }
    return out;
  }
  return {};
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return out;
}

export function setCookie(res, name, value, { maxAge, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
  const secure = config.baseUrl.startsWith('https://');
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (maxAge !== undefined) c += `; Max-Age=${Math.floor(maxAge)}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  res.cookies.push(c);
}

export function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf);
  if (config.trustProxy) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.remoteAddress || '0.0.0.0';
}
export const ipHash = (req) => keyedHash(`ip:${clientIp(req)}`);

export function send(res, status, body, headers = {}) {
  if (res.done) return;
  res.status = status;
  Object.assign(res.headers, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.body = body;
  res.done = true;
}
export const sendHtml = (res, body, status = 200) => send(res, status, String(body), { 'Cache-Control': 'no-store' });
export const sendJson = (res, obj, status = 200) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
export const redirect = (res, location, status = 303) => send(res, status, '', { Location: location });

// Fixed-window rate limiter stored in the database, so it holds across server instances.
export async function rateLimit(key, limit, windowSec) {
  const t = Math.floor(Date.now() / 1000);
  const row = await one(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN ? - rate_limits.window_start >= ? THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN ? - rate_limits.window_start >= ? THEN ? ELSE rate_limits.window_start END
     RETURNING count`,
    key.slice(0, 200), t, t, windowSec, t, windowSec, t,
  );
  return (row?.count ?? 1) <= limit;
}
export const purgeRateLimits = () => run('DELETE FROM rate_limits WHERE window_start < ?', Math.floor(Date.now() / 1000) - 86400);

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Node.js entry point (local development, tests, or any Node host such as a VPS or Render).
// Uses Node's built-in SQLite through a D1-compatible wrapper, so the app code is identical
// to what runs on Cloudflare. Requires Node 22.13+.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { SqliteD1 } from './src/d1-sqlite.mjs';
import { handle, scheduled } from './src/app.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname);

// Minimal .env loader. Real environment variables win.
const envFile = process.env.ENV_FILE || path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const env = { ...process.env, DB: new SqliteD1(process.env.DATABASE_PATH || path.join(ROOT, 'data', 'event.db')) };
const PORT = Number(process.env.PORT || 3000);
const BASE = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
env.BASE_URL = BASE;

const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

function serveStatic(req, res, pathname) {
  if (!/^\/(css|js|img|fonts)\//.test(pathname)) return false;
  const file = path.normalize(path.join(PUBLIC, pathname));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, BASE);
    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, url.pathname)) return;
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > 1024 * 1024) { res.writeHead(413).end(); return; } chunks.push(c); }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const pending = [];
    const response = await handle(request, env, { waitUntil: (p) => pending.push(p), remoteAddress: req.socket.remoteAddress });
    const out = {};
    response.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error('[server]', e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Server error');
  }
});

server.listen(PORT, () => console.log(`[server] ${BASE} (port ${PORT})`));

// The scheduled job Cloudflare runs by cron: reminders, message delivery, housekeeping.
if (process.env.DISABLE_WORKER !== '1') {
  setInterval(() => scheduled(env).catch((e) => console.error('[scheduled]', e)), 60_000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));

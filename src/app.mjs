// The whole site as one standard fetch handler: (Request) => Response.
// Runs unchanged on Cloudflare Workers (worker.mjs) and on Node (server.mjs).
import { Buffer } from 'node:buffer';
import { config, initConfig, useRequestOrigin, integrations } from './config.mjs';
import { setDb, migrate, one, run, now } from './db.mjs';
import { seed } from './lib/seed.mjs';
import { loadSettings } from './lib/settings.mjs';
import { randomToken, hashPassword, timingSafeEqualStr } from './lib/security.mjs';
import { sendHtml, sendJson, send, redirect, readBody, HttpError, rateLimit, ipHash, purgeRateLimits } from './lib/http.mjs';
import { login } from './lib/admin-auth.mjs';
import { audit } from './lib/audit.mjs';
import { html } from './lib/html.mjs';
import { withRequestContext } from './lib/background.mjs';
import { processQueue, queueReminders } from './lib/notify.mjs';
import { publicRoutes } from './routes/public.mjs';
import { adminRoutes } from './routes/admin.mjs';
import { messagePage } from './views/pages.mjs';
import { setupPage } from './views/admin.mjs';

// ---------- Router ----------
const routes = [];
for (const table of [setupRoutes(), publicRoutes, adminRoutes]) {
  for (const [key, handler] of Object.entries(table)) {
    const [method, pattern] = key.split(' ');
    const names = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z]+)/g, (_m, n) => { names.push(n); return '/([^/]+)'; }) + '/?$');
    routes.push({ method, re, names, handler });
  }
}
function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
    const m = pathname.match(r.re);
    if (m) {
      try { return { handler: r.handler, params: Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) }; } catch { return null; }
    }
  }
  return null;
}

// ---------- One-time startup per server instance ----------
let booted = null;
async function boot(env) {
  initConfig(env);
  setDb(env.DB);
  await migrate();
  if (!config.hashSalt) {
    // No APP_SECRET provided: generate one per install and keep it in the database.
    await run(`INSERT INTO app_secrets (name, value, created_at) VALUES ('app_secret', ?, ?) ON CONFLICT DO NOTHING`, randomToken(32), now());
    config.hashSalt = (await one(`SELECT value FROM app_secrets WHERE name = 'app_secret'`)).value;
  }
  await seed();
  // Owner account from ADMIN_EMAIL / ADMIN_PASSWORD on first launch (optional; /admin/setup also works).
  if (config.adminEmail.includes('@') && config.adminPassword.length >= 12 && !(await one('SELECT 1 AS x FROM admins LIMIT 1'))) {
    await run('INSERT INTO admins (email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      config.adminEmail, config.adminEmail.split('@')[0], 'owner', await hashPassword(config.adminPassword), now());
    console.log(`[setup] Created owner account ${config.adminEmail}.`);
  }
}
const ensureBooted = (env) => (booted ||= boot(env).catch((e) => { booted = null; throw e; }));

function securityHeaders(h) {
  const ts = integrations.turnstile() ? ' https://challenges.cloudflare.com' : '';
  const pl = config.plausibleDomain ? ' https://plausible.io' : '';
  h['Content-Security-Policy'] = [
    "default-src 'self'", `script-src 'self'${ts}${pl}`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data: https:", "font-src 'self'",
    `connect-src 'self'${pl}`, `frame-src${ts || " 'none'"}`, "form-action 'self'", "base-uri 'self'", "frame-ancestors 'none'", "object-src 'none'",
  ].join('; ');
  h['X-Content-Type-Options'] = 'nosniff';
  h['X-Frame-Options'] = 'DENY';
  h['Referrer-Policy'] = 'strict-origin-when-cross-origin';
  h['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=(), payment=()';
  h['Cross-Origin-Opener-Policy'] = 'same-origin';
  if (config.baseUrl.startsWith('https://')) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
}

export async function handle(request, env, ctx = {}) {
  return withRequestContext({ waitUntil: ctx.waitUntil?.bind(ctx) }, async () => {
    const url = new URL(request.url);
    await ensureBooted(env);
    useRequestOrigin(url.origin);
    await loadSettings();

    const headers = {};
    request.headers.forEach((v, k) => { headers[k] = v; });
    let bodyBuf = null;
    const req = {
      method: request.method,
      url: url.pathname + url.search,
      headers,
      remoteAddress: ctx.remoteAddress || '',
      body: async () => (bodyBuf ||= Buffer.from(await request.arrayBuffer())),
    };
    const res = { status: 200, headers: {}, cookies: [], body: '', done: false };

    try {
      const m = match(request.method, url.pathname);
      if (!m) {
        if (url.pathname.startsWith('/api/')) sendJson(res, { ok: false, message: 'Not found' }, 404);
        else sendHtml(res, messagePage('Page not found', 'That page doesn’t exist. Head back to the event page.'), 404);
      } else {
        await m.handler(req, res, url, m.params);
      }
    } catch (e) {
      const status = e instanceof HttpError || e.status ? e.status : 500;
      if (status >= 500) console.error('[error]', request.method, url.pathname, e);
      const message = status >= 500 ? 'Something went wrong on our side. Try again in a minute.' : e.message;
      res.done = false;
      const wantsJson = url.pathname.startsWith('/api/') || url.pathname.startsWith('/webhooks/') || (headers.accept || '').includes('application/json');
      if (wantsJson) sendJson(res, { ok: false, message, ...(e.extra || {}) }, status);
      else if (status === 401 && url.pathname.startsWith('/admin')) redirect(res, '/admin/login');
      else sendHtml(res, messagePage(status === 403 ? 'Not allowed' : 'Something went wrong', message), status);
    }

    securityHeaders(res.headers);
    const out = new Headers(res.headers);
    for (const c of res.cookies) out.append('Set-Cookie', c);
    return new Response(request.method === 'HEAD' || res.status === 204 || res.status === 304 ? null : res.body, { status: res.status, headers: out });
  });
}

// Scheduled job (Cloudflare cron, or the Node timer): reminders, message delivery, housekeeping.
export async function scheduled(env, ctx = {}) {
  return withRequestContext({ waitUntil: ctx.waitUntil?.bind(ctx) }, async () => {
    await ensureBooted(env);
    await loadSettings();
    await queueReminders();
    await processQueue(40);
    await purgeRateLimits();
  });
}

// ---------- First-run owner setup: /admin/setup?code=<SETUP_CODE> ----------
function setupRoutes() {
  const enabled = async () => Boolean(config.setupCode) && !(await one('SELECT 1 AS x FROM admins LIMIT 1'));
  const codeOk = (c) => config.setupCode && timingSafeEqualStr(String(c || ''), config.setupCode);
  return {
    'GET /admin/setup': async (req, res, url) => {
      if (!(await enabled())) return sendHtml(res, messagePage('Setup is complete', 'An organizer account already exists. Sign in at /admin.'), 404);
      if (!codeOk(url.searchParams.get('code'))) return sendHtml(res, messagePage('Setup link required', 'Open the setup link you were given.'), 403);
      sendHtml(res, setupPage({ code: url.searchParams.get('code') }));
    },
    'POST /admin/setup': async (req, res) => {
      const body = await readBody(req);
      if (!(await rateLimit(`setup:${ipHash(req)}`, 10, 900))) throw new HttpError(429, 'Too many attempts. Wait 15 minutes.');
      if (!(await enabled()) || !codeOk(body.code)) throw new HttpError(403, 'Setup is not available.');
      const email = String(body.email || '').trim().toLowerCase();
      const name = String(body.name || '').trim().slice(0, 80) || email.split('@')[0];
      const pw = String(body.password || '');
      let error = null;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) error = 'Enter a valid email address.';
      else if (pw.length < 12) error = 'Use a password with at least 12 characters.';
      else if (pw !== body.password2) error = 'The two passwords don’t match.';
      if (error) return sendHtml(res, setupPage({ code: body.code, error, email, name }), 400);
      const r = await run('INSERT INTO admins (email, name, role, password_hash, created_at) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM admins)',
        email, name, 'owner', await hashPassword(pw), now());
      if (!r.changes) throw new HttpError(409, 'An organizer account already exists.');
      await audit({ actor: 'system', action: 'admin.setup_owner_created', after: { email }, ipHash: ipHash(req) });
      await login(req, res, email, pw);
      redirect(res, '/admin');
    },
  };
}

export { html };

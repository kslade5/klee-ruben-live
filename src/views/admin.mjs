import { html, raw } from '../lib/html.mjs';
import { asset } from './layout.mjs';
import { integrations } from '../config.mjs';

const NAV = [
  ['/admin', 'Overview', 'overview'],
  ['/admin/rsvps', 'RSVPs', 'rsvps'],
  ['/admin/referrals', 'Referrals', 'referrals'],
  ['/admin/leaderboard', 'Who’s sharing', 'leaderboard'],
  ['/admin/raffle', 'Raffle & payments', 'raffle'],
  ['/admin/prizes', 'Prizes', 'prizes'],
  ['/admin/faq', 'FAQ', 'faq'],
  ['/admin/messages', 'Messages', 'messages'],
  ['/admin/settings', 'Settings', 'settings'],
  ['/admin/audit', 'Audit log', 'audit'],
  ['/admin/team', 'Team', 'team'],
];

export function adminLayout({ admin, title, active, body, flash }) {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Organizer dashboard</title><meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="${asset('/css/admin.css')}"><link rel="icon" href="/img/icon.svg"></head>
<body class="adm">
<a class="skip" href="#main">Skip to content</a>
<header class="adm__top">
  <a class="adm__brand" href="/admin">K&amp;R <b>Live</b> <span>Organizer</span></a>
  <button class="adm__menu" type="button" data-adm-menu aria-expanded="false" aria-controls="adm-nav">Menu</button>
  <div class="adm__who">${admin.name} <span class="role role--${admin.role}">${admin.role}</span>
    <form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${admin.csrf_token}"><button class="linkish">Sign out</button></form></div>
</header>
<div class="adm__shell">
  <nav class="adm__nav" id="adm-nav" aria-label="Dashboard">${NAV.map(([href, label, key]) => html`<a href="${href}" ${key === active ? raw('aria-current="page"') : ''}>${label}</a>`)}
    <a href="/" target="_blank" rel="noopener" class="adm__site">View site ↗</a></nav>
  <main class="adm__main" id="main">
    <h1 class="adm__h1">${title}</h1>
    ${flash ? html`<p class="flash flash--${flash.type}" role="status">${flash.text}</p>` : ''}
    ${body}
  </main>
</div>
<script src="${asset('/js/admin.js')}" defer></script>
</body></html>`;
}

export function loginPage({ error, email = '' }) {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Organizer sign in</title><meta name="robots" content="noindex, nofollow"><link rel="stylesheet" href="${asset('/css/admin.css')}"></head>
<body class="adm adm--login"><main class="login">
  <p class="adm__brand">K&amp;R <b>Live</b> <span>Organizer</span></p>
  <h1>Sign in</h1>
  ${error ? html`<p class="flash flash--error" role="alert">${error}</p>` : ''}
  <form method="post" action="/admin/login">
    <label>Email <input name="email" type="email" autocomplete="username" value="${email}" required autofocus></label>
    <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
    <button class="abtn abtn--primary" type="submit">Sign in</button>
  </form>
</main></body></html>`;
}

export const csrf = (admin) => html`<input type="hidden" name="_csrf" value="${admin.csrf_token}">`;

export const tile = (label, value, note = '') => html`<div class="tile"><span class="tile__label">${label}</span><b class="tile__value">${value}</b>${note ? html`<span class="tile__note">${note}</span>` : ''}</div>`;

export const money = (cents) => `$${(Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const fmtDate = (iso, withTime = true) =>
  iso ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}) }).format(new Date(iso)) : '—';

export function maskEmail(e) {
  const [l, d] = String(e).split('@');
  return `${l.slice(0, 2)}•••@${d || ''}`;
}
export const maskPhone = (p) => `•••-•••-${String(p).replace(/\D/g, '').slice(-4)}`;

// Single-hue vertical bar chart (SVG) with an accessible data table fallback.
export function barChart(rows, { label, height = 160 } = {}) {
  if (!rows.length) return html`<p class="empty">No data yet.</p>`;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const slot = 26, w = Math.max(600, rows.length * slot);
  const left = (w - rows.length * slot) / 2;
  const step = Math.max(1, Math.ceil(rows.length / 10));
  return html`<figure class="chart">
    <svg viewBox="0 0 ${w} ${height + 24}" role="img" aria-label="${label}">
      <line x1="0" x2="${w}" y1="${height}" y2="${height}" class="chart__axis"/>
      ${rows.map((r, i) => {
        const h = (r.value / max) * (height - 18);
        const x = left + i * slot;
        return raw(`<g><title>${String(r.label).replace(/</g, '')}: ${r.value}</title><rect x="${x + 4}" y="${height - h}" width="${slot - 8}" height="${h}" rx="2" class="chart__bar"/>${r.value ? `<text x="${x + slot / 2}" y="${height - h - 4}" text-anchor="middle" class="chart__val">${r.value}</text>` : ''}${i % step === 0 ? `<text x="${x + slot / 2}" y="${height + 16}" text-anchor="middle" class="chart__lbl">${String(r.label).replace(/</g, '')}</text>` : ''}</g>`);
      })}
    </svg>
    <figcaption class="sr-only">${label}</figcaption>
  </figure>`;
}

export function hbars(rows, { total } = {}) {
  if (!rows.length) return html`<p class="empty">No data yet.</p>`;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return html`<ul class="hbars">${rows.map((r) => html`<li><span class="hbars__label">${r.label}</span><span class="hbars__track"><span class="hbars__bar" style="width:${((r.value / max) * 100).toFixed(1)}%"></span></span><b>${r.value}${total ? html`<small> ${((r.value / Math.max(1, total)) * 100).toFixed(0)}%</small>` : ''}</b></li>`)}</ul>`;
}

export const statusTag = (s) => html`<span class="st st--${s}">${String(s).replace(/_/g, ' ')}</span>`;

export function pager(url, page, hasMore) {
  const link = (p) => { const u = new URL(url); u.searchParams.set('page', p); return `${u.pathname}${u.search}`; };
  return html`<nav class="pager" aria-label="Pages">${page > 1 ? html`<a href="${link(page - 1)}">Previous</a>` : ''}<span>Page ${page}</span>${hasMore ? html`<a href="${link(page + 1)}">Next</a>` : ''}</nav>`;
}

export function readiness(s) {
  const items = [
    ['Payments (Stripe keys + webhook secret)', integrations.stripe(), integrations.stripe() ? (integrations.stripeLive() ? 'Live mode' : 'Test mode') : 'Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET'],
    ['Raffle compliance approval', s.raffle.compliance_approved, s.raffle.compliance_approved ? `Approved by ${s.raffle.compliance_approved_by}` : 'Owner must record legal approval in Settings'],
    ['Raffle sales switched on', s.raffle.sales_enabled, s.raffle.sales_enabled ? 'On' : 'Off'],
    ['Email delivery', integrations.email(), integrations.email() ? 'Resend configured' : 'Set RESEND_API_KEY and EMAIL_FROM'],
    ['SMS delivery (optional)', integrations.sms(), integrations.sms() ? 'Twilio configured' : 'Optional: set TWILIO_* variables'],
    ['Venue address', Boolean(s.event.venue_address), s.event.venue_address || 'Not announced yet'],
    ['Contact email or phone', Boolean(s.contact.email || s.contact.phone), s.contact.email || s.contact.phone || 'Add in Settings → Contact'],
    ['Instagram handle', Boolean(s.contact.instagram_handle), s.contact.instagram_handle ? `@${s.contact.instagram_handle}` : 'Add in Settings → Contact'],
  ];
  return html`<ul class="ready">${items.map(([label, ok, note]) => html`<li class="${ok ? 'is-ok' : 'is-todo'}"><span class="ready__dot" aria-hidden="true"></span><span>${label}</span><small>${note}</small><span class="sr-only">${ok ? 'done' : 'to do'}</span></li>`)}</ul>`;
}

export function setupPage({ code, error, email = '', name = '' }) {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Create organizer account</title><meta name="robots" content="noindex, nofollow"><link rel="stylesheet" href="${asset('/css/admin.css')}"></head>
<body class="adm adm--login"><main class="login">
  <p class="adm__brand">K&amp;R <b>Live</b> <span>Organizer</span></p>
  <h1>Create your login</h1>
  <p class="hint">This is the owner account for the dashboard. You can add Ruben and helpers later under Team.</p>
  ${error ? html`<p class="flash flash--error" role="alert">${error}</p>` : ''}
  <form method="post" action="/admin/setup">
    <input type="hidden" name="code" value="${code}">
    <label>Your name <input name="name" value="${name}" autocomplete="name" required></label>
    <label>Email <input name="email" type="email" value="${email}" autocomplete="username" required></label>
    <label>Password (12+ characters) <input name="password" type="password" minlength="12" autocomplete="new-password" required></label>
    <label>Type it again <input name="password2" type="password" minlength="12" autocomplete="new-password" required></label>
    <button class="abtn abtn--primary" type="submit">Create account</button>
  </form>
</main></body></html>`;
}

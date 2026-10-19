// Organizer dashboard. Every route checks the session server-side; every POST checks role + CSRF + origin.
import { one, all, run, batch, now } from '../db.mjs';
import { html, raw } from '../lib/html.mjs';
import { readBody, sendHtml, send, redirect, rateLimit, ipHash, HttpError } from '../lib/http.mjs';
import { login, logout, currentAdmin, requireRole, checkCsrf, ROLE_RANK } from '../lib/admin-auth.mjs';
import { hashPassword, verifyPassword } from '../lib/security.mjs';
import { getSettings, setSettingsGroup, eventTimes, DEFAULTS } from '../lib/settings.mjs';
import { audit, auditStmt } from '../lib/audit.mjs';
import { INTERESTS, US_STATES, normalizeEmail, normalizePhone, AGE_GROUPS, HEARD_FROM, clean } from '../lib/validate.mjs';
import { raffleTotals, approveReward, reverseReward, raffleGate } from '../lib/raffle.mjs';
import { entryTotals, issueAccessToken } from '../lib/rsvp.mjs';
import { broadcastUpdate, sendRsvpConfirmation, sendAccessLink, processQueue } from '../lib/notify.mjs';
import { integrations } from '../config.mjs';
import { adminLayout, loginPage, csrf, tile, money, fmtDate, maskEmail, maskPhone, barChart, hbars, statusTag, pager, readiness } from '../views/admin.mjs';

const MSG = {
  saved: ['ok', 'Saved.'], created: ['ok', 'Created.'], deleted: ['ok', 'Deleted.'], sent: ['ok', 'Queued for delivery.'],
  approved: ['ok', 'Bonus approved and entries added.'], reversed: ['ok', 'Reward reversed. The ledger records the reversal.'],
  compliance_on: ['ok', 'Compliance approval recorded.'], compliance_off: ['ok', 'Compliance approval revoked. Raffle checkout is off.'],
  password: ['ok', 'Password updated.'], entries: ['ok', 'Ledger updated.'],
};

async function guard(req, role = 'viewer') {
  const admin = await currentAdmin(req);
  if (!admin) throw new HttpError(401, 'Sign in required');
  requireRole(admin, role);
  return admin;
}

async function guardPost(req, role) {
  const admin = await guard(req, 'viewer');
  const body = await readBody(req);
  checkCsrf(req, admin, body);
  requireRole(admin, role);
  return { admin, body };
}

const page = (res, admin, url, title, active, body) => {
  const m = MSG[url.searchParams.get('msg')];
  const err = url.searchParams.get('err');
  sendHtml(res, adminLayout({ admin, title, active, body, flash: m ? { type: m[0], text: m[1] } : err ? { type: 'error', text: err.slice(0, 200) } : null }));
};

const canSeePii = (admin) => ROLE_RANK[admin.role] >= ROLE_RANK.admin;
const email = (admin, e) => (canSeePii(admin) ? e : maskEmail(e));
const phone = (admin, p) => (canSeePii(admin) ? p : maskPhone(p));
const actor = (admin) => `admin:${admin.id}`;

function csv(res, filename, header, rows) {
  // Neutralize spreadsheet formula injection.
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  send(res, 200, '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n'), {
    'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store',
  });
}

const dayRange = (url) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('from') || '') ? url.searchParams.get('from') : '';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('to') || '') ? url.searchParams.get('to') : '';
  return { from, to, fromIso: from ? new Date(`${from}T00:00:00-05:00`).toISOString() : '0000', toIso: to ? new Date(`${to}T23:59:59.999-05:00`).toISOString() : '9999' };
};

// ---------------- RSVP query (shared by list + CSV) ----------------
async function rsvpQuery(url, { limit, offset } = {}) {
  const q = (url.searchParams.get('q') || '').trim();
  const status = url.searchParams.get('status') || '';
  const interest = url.searchParams.get('interest') || '';
  const ref = url.searchParams.get('ref') || '';
  const { fromIso, toIso } = dayRange(url);
  const where = ['r.created_at >= ?', 'r.created_at <= ?'];
  const p = [fromIso, toIso];
  if (q) {
    const digits = q.replace(/\D/g, '');
    where.push(`(a.first_name || ' ' || a.last_name LIKE ? OR a.email LIKE ? OR r.confirmation_no = ? OR rc.code = ?${digits.length >= 4 ? ' OR a.phone_norm LIKE ?' : ''})`);
    p.push(`%${q}%`, `%${q}%`, q.toUpperCase(), q.toUpperCase());
    if (digits.length >= 4) p.push(`%${digits}%`);
  }
  if (['confirmed', 'cancelled'].includes(status)) { where.push('r.status = ?'); p.push(status); }
  if (status === 'flagged') where.push('r.flagged = 1');
  if (INTERESTS[interest]) { where.push('r.interests LIKE ?'); p.push(`%"${interest}"%`); }
  if (ref === 'referred') where.push('rr.id IS NOT NULL');
  if (ref === 'direct') where.push('rr.id IS NULL');
  const sql = `SELECT a.*, r.id AS rsvp_id, r.confirmation_no, r.status, r.guests_count, r.created_at AS rsvp_at, r.flagged, r.flag_reason, r.interests, r.interests_other, r.heard_from, r.invited_by_text, r.utm_source,
      rc.code, ra.first_name || ' ' || ra.last_name AS referred_by, rr.status AS ref_status,
      (SELECT COUNT(*) FROM referral_relationships x WHERE x.referrer_id = a.id) AS referred_count,
      (SELECT COALESCE(SUM(entries),0) FROM raffle_ledger l WHERE l.attendee_id = a.id AND (l.kind IN ('paid','paid_reversal') OR (l.kind='adjustment' AND l.purchase_id IS NOT NULL))) AS paid_entries,
      (SELECT COALESCE(SUM(entries),0) FROM raffle_ledger l WHERE l.attendee_id = a.id AND l.kind IN ('referral_bonus','referral_bonus_reversal')) AS bonus_entries
    FROM attendees a JOIN rsvps r ON r.attendee_id = a.id
    LEFT JOIN referral_codes rc ON rc.attendee_id = a.id
    LEFT JOIN referral_relationships rr ON rr.referred_id = a.id
    LEFT JOIN attendees ra ON ra.id = rr.referrer_id
    WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC ${limit ? `LIMIT ${limit + 1} OFFSET ${offset}` : ''}`;
  return await all(sql, ...p);
}

function rsvpFilters(url, admin) {
  const v = (k) => url.searchParams.get(k) || '';
  const sel = (k, val) => (v(k) === val ? raw('selected') : '');
  const qs = url.search;
  return html`<form class="filters" method="get">
    <label>Search <input name="q" value="${v('q')}" placeholder="Name, email, phone, KR-…, invite code"></label>
    <label>Status <select name="status"><option value="">All</option><option value="confirmed" ${sel('status', 'confirmed')}>Confirmed</option><option value="cancelled" ${sel('status', 'cancelled')}>Cancelled</option><option value="flagged" ${sel('status', 'flagged')}>Flagged</option></select></label>
    <label>Interest <select name="interest"><option value="">Any</option>${Object.entries(INTERESTS).map(([k, l]) => html`<option value="${k}" ${sel('interest', k)}>${l}</option>`)}</select></label>
    <label>Source <select name="ref"><option value="">Any</option><option value="referred" ${sel('ref', 'referred')}>Referred by someone</option><option value="direct" ${sel('ref', 'direct')}>No referral</option></select></label>
    <label>From <input type="date" name="from" value="${v('from')}"></label>
    <label>To <input type="date" name="to" value="${v('to')}"></label>
    <button class="abtn">Apply</button>
    ${canSeePii(admin) ? html`<a class="abtn abtn--ghost" href="/admin/rsvps.csv${qs}">Export CSV</a>` : ''}
  </form>`;
}

// ---------------- Leaderboard query ----------------
async function leaderboard(url) {
  const { fromIso, toIso } = dayRange(url);
  const rows = (await all(`
    SELECT a.id, a.first_name, a.last_name, a.display_name, a.leaderboard_opt_in, rc.code,
      (SELECT COUNT(*) FROM referral_relationships rr WHERE rr.referrer_id = a.id AND rr.status <> 'invalid' AND rr.attributed_at BETWEEN ? AND ?) AS rsvps,
      (SELECT COUNT(DISTINCT p.attendee_id) FROM raffle_purchases p JOIN referral_relationships rr ON rr.referred_id = p.attendee_id
         WHERE rr.referrer_id = a.id AND p.status IN ('paid','partially_refunded') AND p.paid_at BETWEEN ? AND ?) AS purchasers,
      (SELECT COALESCE(SUM(p.amount_cents - p.amount_refunded_cents),0) FROM raffle_purchases p JOIN referral_relationships rr ON rr.referred_id = p.attendee_id
         WHERE rr.referrer_id = a.id AND p.status IN ('paid','partially_refunded') AND p.paid_at BETWEEN ? AND ?) AS revenue,
      (SELECT COALESCE(SUM(l.entries),0) FROM raffle_ledger l WHERE l.attendee_id = a.id AND l.kind IN ('referral_bonus','referral_bonus_reversal') AND l.created_at BETWEEN ? AND ?) AS bonus,
      (SELECT COUNT(DISTINCT rv.visitor_hash || rv.day) FROM referral_visits rv WHERE rv.code = rc.code AND rv.created_at BETWEEN ? AND ?) AS visits,
      (SELECT COUNT(*) FROM share_clicks sc WHERE sc.attendee_id = a.id AND sc.created_at BETWEEN ? AND ?) AS shares
    FROM attendees a JOIN referral_codes rc ON rc.attendee_id = a.id`,
    fromIso, toIso, fromIso, toIso, fromIso, toIso, fromIso, toIso, fromIso, toIso, fromIso, toIso,
  )).filter((r) => r.rsvps || r.purchasers || r.bonus || r.visits || r.shares);
  const sort = { rsvps: 'rsvps', purchasers: 'purchasers', revenue: 'revenue', bonus: 'bonus' }[url.searchParams.get('sort')] || 'rsvps';
  rows.sort((a, b) => b[sort] - a[sort] || b.rsvps - a.rsvps);
  return { rows, sort };
}

// ---------------- Settings form schema ----------------
const SETTINGS_FORMS = {
  event: { title: 'Event', role: 'admin', fields: [
    ['name', 'Event name', 'text'], ['hosts', 'Hosts', 'text'],
    ['start_local', 'Starts (Eastern Time)', 'datetime-local'], ['end_local', 'Ends (Eastern Time)', 'datetime-local'],
    ['venue_name', 'Venue name', 'text', 'Leave blank until announced'], ['venue_address', 'Venue street address', 'text', 'Shown publicly once filled in'],
    ['venue_directions_url', 'Directions link (Google Maps, etc.)', 'url'],
    ['capacity', 'Capacity (people including guests; 0 = no cap)', 'number'], ['rsvp_close_local', 'RSVPs close (blank = at start time)', 'datetime-local'],
  ] },
  contact: { title: 'Contact & social', role: 'admin', fields: [
    ['instagram_handle', 'Instagram handle', 'text', 'e.g. kleeandruben (placeholder: @YOURINSTAGRAM)'], ['instagram_url', 'Instagram profile URL', 'url'],
    ['phone', 'Event phone number', 'tel', 'Placeholder: YOUR EVENT PHONE NUMBER'], ['email', 'Event contact email', 'email', 'Placeholder: YOUR EVENT EMAIL'],
    ['facebook_url', 'Facebook page URL', 'url'], ['tiktok_url', 'TikTok profile URL', 'url'], ['whatsapp_url', 'WhatsApp contact or group link', 'url'],
  ] },
  referral: { title: 'Referral rules', role: 'admin', fields: [
    ['window_days', 'Attribution window (days)', 'number'], ['bonus_entries', 'Bonus entries per qualifying referred purchase', 'number'],
    ['repeat_purchase_rewards', 'Also reward repeat purchases by the same referred person (publish this in the rules first)', 'bool'],
    ['reverse_on_full_refund', 'Reverse the bonus when the qualifying purchase is fully refunded', 'bool'],
  ] },
  raffle: { title: 'Raffle', role: 'admin', fields: [
    ['sales_enabled', 'Raffle sales switched on (has no effect until compliance approval is recorded)', 'bool'],
    ['sales_close_local', 'Online sales close (Eastern Time)', 'datetime-local'], ['max_entries_per_purchase', 'Maximum entries per purchase', 'number'],
    ['min_age', 'Minimum age to buy', 'number'], ['eligible_states', 'Eligible states (comma-separated codes, e.g. MD,VA,DC; blank = none configured)', 'text'],
    ['drawing_info', 'Drawing date, time and method (public)', 'textarea'], ['free_entry_method', 'Free method of entry (public; required in some jurisdictions)', 'textarea'],
  ] },
  public: { title: 'Public stats', role: 'admin', fields: [
    ['show_rsvp_count', 'Show the RSVP count on the home page', 'bool'], ['rsvp_count_min', 'Only show the count once it reaches', 'number'],
  ] },
  notify: { title: 'Reminders', role: 'admin', fields: [
    ['reminder_hours', 'Reminder times (hours before start, comma-separated)', 'list'], ['referral_notifications', 'Email referrers when they earn bonus entries', 'bool'],
  ] },
  pages: { title: 'Policies & rules pages', role: 'admin', fields: [
    ['raffle_rules', 'Raffle rules', 'longtext'], ['event_rules', 'Event rules', 'longtext'], ['privacy', 'Privacy policy', 'longtext'],
    ['terms', 'Terms and conditions', 'longtext'], ['refund_policy', 'Refund policy', 'longtext'],
  ] },
};

function settingsForm(admin, group, values) {
  const def = SETTINGS_FORMS[group];
  const disabled = ROLE_RANK[admin.role] < ROLE_RANK[def.role];
  return html`<form class="card form" method="post" action="/admin/settings/${group}" id="s-${group}">
    ${csrf(admin)}<h2>${def.title}</h2>
    ${group === 'pages' ? html`<p class="hint">Formatting: blank line = new paragraph, “## ” = heading, “- ” = bullet, **bold**, [link text](https://…).</p>` : ''}
    <fieldset ${disabled ? raw('disabled') : ''}>
    ${def.fields.map(([k, label, type, help]) => {
      const v = values[k];
      const id = `${group}-${k}`;
      if (type === 'bool') return html`<label class="cbx"><input type="checkbox" name="${k}" ${v ? raw('checked') : ''}> ${label}</label>`;
      if (type === 'textarea') return html`<label for="${id}">${label}<textarea id="${id}" name="${k}" rows="3">${v}</textarea></label>`;
      if (type === 'longtext') return html`<label for="${id}">${label}<textarea id="${id}" name="${k}" rows="12" class="mono">${v}</textarea></label>`;
      return html`<label for="${id}">${label}<input id="${id}" name="${k}" type="${type === 'list' ? 'text' : type}" value="${Array.isArray(v) ? v.join(', ') : v}" ${type === 'number' ? raw('min="0" step="1"') : ''}>${help ? html`<small>${help}</small>` : ''}</label>`;
    })}
    <button class="abtn abtn--primary">Save ${def.title.toLowerCase()}</button>
    </fieldset>
  </form>`;
}

function parseSettings(group, body) {
  const out = {};
  for (const [k, , type] of SETTINGS_FORMS[group].fields) {
    const v = body[k];
    if (type === 'bool') out[k] = v === 'on';
    else if (type === 'number') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `“${k}” must be a whole number.`);
      out[k] = n;
    } else if (type === 'list') out[k] = String(v || '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0 && n <= 24 * 30);
    else if (type === 'datetime-local') {
      const s = String(v || '').trim();
      if (s && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) throw new HttpError(400, `“${k}” must be a date and time.`);
      out[k] = s;
    } else if (type === 'url') {
      const s = String(v || '').trim();
      if (s && !/^https:\/\/[^\s"'<>]+$/.test(s)) throw new HttpError(400, `“${k}” must be a full https:// link.`);
      out[k] = s;
    } else if (type === 'longtext') out[k] = String(v || '').slice(0, 30000);
    else out[k] = String(v || '').trim().slice(0, 2000);
  }
  if (group === 'contact') out.instagram_handle = out.instagram_handle.replace(/^@+/, '');
  if (group === 'raffle') out.eligible_states = out.eligible_states.toUpperCase().split(',').map((x) => x.trim()).filter((x) => US_STATES[x]).join(',');
  if (group === 'referral' && (out.bonus_entries < 0 || out.bonus_entries > 100)) throw new HttpError(400, 'Bonus entries must be between 0 and 100.');
  if (group === 'raffle' && (out.max_entries_per_purchase < 5 || out.max_entries_per_purchase % 5)) throw new HttpError(400, 'Maximum entries must be a multiple of 5.');
  if (group === 'event' && (!out.start_local || !out.end_local || out.end_local <= out.start_local)) throw new HttpError(400, 'The event needs a start and an end after the start.');
  return out;
}

// ======================================================================
export const adminRoutes = {
  'GET /admin/login': async (req, res) => {
    if (await currentAdmin(req)) return redirect(res, '/admin');
    sendHtml(res, loginPage({}));
  },
  'POST /admin/login': async (req, res) => {
    const body = await readBody(req);
    if (!await rateLimit(`login:${ipHash(req)}`, 10, 900)) return sendHtml(res, loginPage({ error: 'Too many attempts. Wait 15 minutes.', email: body.email }), 429);
    const r = await login(req, res, body.email, body.password);
    if (!r.ok) return sendHtml(res, loginPage({ error: r.message, email: body.email }), 401);
    redirect(res, '/admin');
  },
  'POST /admin/logout': async (req, res) => {
    const admin = await currentAdmin(req);
    if (admin) checkCsrf(req, admin, await readBody(req));
    await logout(req, res);
    redirect(res, '/admin/login');
  },

  // ---------- Overview ----------
  'GET /admin': async (req, res, url) => {
    const admin = await guard(req);
    const s = getSettings();
    const r = await one(`SELECT COUNT(*) AS total, SUM(status='confirmed') AS confirmed, SUM(CASE WHEN status='confirmed' THEN guests_count ELSE 0 END) AS guests, SUM(flagged) AS flagged FROM rsvps`);
    const pay = await one(`SELECT
        SUM(status IN ('paid','partially_refunded','refunded','disputed')) AS completed,
        SUM(status = 'pending') AS pending, SUM(status IN ('refunded','partially_refunded')) AS refunds, SUM(status='disputed') AS disputes, SUM(status='review') AS review,
        COALESCE(SUM(CASE WHEN status IN ('paid','partially_refunded','refunded','disputed') THEN amount_cents END),0) AS gross,
        COALESCE(SUM(amount_refunded_cents),0) AS refunded FROM raffle_purchases`);
    const totals = await raffleTotals();
    const ref = await one(`SELECT (SELECT COUNT(*) FROM referral_visits) AS visits, (SELECT COUNT(*) FROM referral_relationships WHERE status <> 'invalid') AS rsvps,
        (SELECT COUNT(*) FROM referral_rewards WHERE status = 'awarded') AS qualifying, (SELECT COUNT(*) FROM referral_rewards WHERE status = 'pending_review') AS pending,
        (SELECT COUNT(*) FROM share_clicks) AS shares`);
    const days = await all(`SELECT substr(datetime(created_at, '-5 hours'), 1, 10) AS d, COUNT(*) AS n FROM rsvps GROUP BY d ORDER BY d`);
    const dayRows = [];
    if (days.length) {
      const map = Object.fromEntries(days.map((x) => [x.d, x.n]));
      for (let t = new Date(`${days[0].d}T12:00:00Z`); t <= new Date(); t = new Date(t.getTime() + 86400_000)) {
        const k = t.toISOString().slice(0, 10);
        dayRows.push({ label: `${+k.slice(5, 7)}/${+k.slice(8)}`, value: map[k] || 0 });
      }
    }
    const interestCounts = (await Promise.all(Object.entries(INTERESTS).map(async ([k, label]) => ({ label, value: (await one(`SELECT COUNT(*) AS n FROM rsvps WHERE status='confirmed' AND interests LIKE ?`, `%"${k}"%`)).n })))).sort((a, b) => b.value - a.value).filter((x) => x.value);
    const funnel = await Promise.all(['page_view', 'rsvp_started', 'rsvp_completed', 'checkout_started', 'checkout_completed'].map(async (n) => ({ label: { page_view: 'Page views', rsvp_started: 'Started RSVP', rsvp_completed: 'Completed RSVP', checkout_started: 'Started checkout', checkout_completed: 'Paid' }[n], value: (await one('SELECT COUNT(*) AS n FROM analytics_events WHERE name = ?', n)).n })));
    const sources = await all(`SELECT COALESCE(utm_source, '(none)') AS src, COUNT(*) AS n FROM rsvps GROUP BY src ORDER BY n DESC LIMIT 8`);
    const top = (await leaderboard(new URL('http://x/admin'))).rows.slice(0, 5);
    const { start } = eventTimes(s);
    const gate = raffleGate();
    page(res, admin, url, 'Overview', 'overview', html`
      <section class="tiles">
        ${tile('RSVPs', r.total || 0, `${r.confirmed || 0} confirmed`)}
        ${tile('Expected headcount', (r.confirmed || 0) + (r.guests || 0), `${r.guests || 0} additional guests`)}
        ${tile('Raffle entries sold', totals.paid_entries)}
        ${tile('Gross raffle revenue', money(pay.gross), `${money(pay.refunded)} refunded`)}
        ${tile('Completed payments', pay.completed || 0, `${pay.pending || 0} pending · ${pay.refunds || 0} refunds · ${pay.disputes || 0} disputes`)}
        ${tile('Referral link visits', ref.visits, `${ref.shares} share taps tracked`)}
        ${tile('Referral-driven RSVPs', ref.rsvps)}
        ${tile('Qualifying referral purchases', ref.qualifying, ref.pending ? `${ref.pending} awaiting review` : '')}
        ${tile('Bonus entries awarded', totals.bonus_entries)}
        ${tile('Days until event', Math.max(0, Math.ceil((start - Date.now()) / 86400_000)))}
      </section>
      <div class="cols">
        <section class="card"><h2>Launch checklist</h2>${readiness(s)}<p class="hint">Raffle checkout is ${gate.open ? html`<strong class="ok">open</strong>` : html`<strong>closed</strong> (${gate.reasons.join(', ').replace(/_/g, ' ')})`}.</p></section>
        <section class="card"><h2>Top referrers</h2>${top.length ? html`<ol class="toplist">${top.map((t) => html`<li><a href="/admin/rsvps/${t.id}">${t.first_name} ${t.last_name}</a><span>${t.rsvps} RSVPs · ${t.purchasers} buyers · +${t.bonus}</span></li>`)}</ol><a href="/admin/leaderboard">Full leaderboard</a>` : html`<p class="empty">No referrals yet.</p>`}</section>
      </div>
      <section class="card"><h2>RSVPs per day</h2>${barChart(dayRows, { label: 'RSVPs per day' })}</section>
      <div class="cols">
        <section class="card"><h2>Topic interests</h2>${hbars(interestCounts, { total: r.confirmed })}</section>
        <section class="card"><h2>Funnel</h2>${hbars(funnel)}<p class="hint">First-party, anonymous counts. Page views count each load.</p></section>
      </div>
      <section class="card"><h2>RSVPs by campaign source (utm_source)</h2>${hbars(sources.map((x) => ({ label: x.src, value: x.n })))}</section>
    `);
  },

  // ---------- RSVPs ----------
  'GET /admin/rsvps': async (req, res, url) => {
    const admin = await guard(req);
    const pg = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const rows = await rsvpQuery(url, { limit: 50, offset: (pg - 1) * 50 });
    const hasMore = rows.length > 50;
    page(res, admin, url, 'RSVPs', 'rsvps', html`${rsvpFilters(url, admin)}
      <div class="tablewrap"><table class="atbl"><thead><tr><th>Name</th><th>Contact</th><th>Confirmation</th><th>Registered</th><th>Guests</th><th>Referred by</th><th>Referred</th><th>Entries (paid + bonus)</th><th>Status</th></tr></thead><tbody>
      ${rows.slice(0, 50).map((a) => html`<tr>
        <td><a href="/admin/rsvps/${a.id}">${a.first_name} ${a.last_name}</a>${a.flagged ? html` <span class="st st--flag" title="${a.flag_reason || ''}">flagged</span>` : ''}</td>
        <td class="small">${email(admin, a.email)}<br>${phone(admin, a.phone)}</td>
        <td class="mono">${a.confirmation_no}</td><td>${fmtDate(a.rsvp_at)}</td><td>${a.guests_count}</td>
        <td>${a.referred_by || '—'}${a.ref_status && a.ref_status !== 'valid' ? html` ${statusTag(a.ref_status)}` : ''}</td><td>${a.referred_count}</td>
        <td>${a.paid_entries} + ${a.bonus_entries}</td><td>${statusTag(a.status)}</td></tr>`)}
      ${rows.length ? '' : html`<tr><td colspan="9" class="empty">No RSVPs match these filters.</td></tr>`}
      </tbody></table></div>${pager(url, pg, hasMore)}`);
  },

  'GET /admin/rsvps.csv': async (req, res, url) => {
    const admin = await guard(req, 'admin');
    const rows = await rsvpQuery(url);
    await audit({ actor: actor(admin), action: 'export.rsvps', note: `${rows.length} rows; filters ${url.search}`, ipHash: ipHash(req) });
    csv(res, `rsvps-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Confirmation', 'Status', 'First name', 'Last name', 'Email', 'Phone', 'State', 'Instagram', 'Age group', 'Guests', 'Interests', 'Other interests', 'Heard from', 'Invited by (typed)', 'Referred by', 'Invite code', 'People referred', 'Paid entries', 'Bonus entries', 'Email opt-in', 'SMS opt-in', 'UTM source', 'Registered (UTC)', 'Flagged'],
      rows.map((a) => [a.confirmation_no, a.status, a.first_name, a.last_name, a.email, a.phone, a.state, a.instagram, AGE_GROUPS[a.age_group] || '', a.guests_count,
        JSON.parse(a.interests).map((i) => INTERESTS[i]).join('; '), a.interests_other, HEARD_FROM[a.heard_from] || '', a.invited_by_text, a.referred_by, a.code, a.referred_count,
        a.paid_entries, a.bonus_entries, a.marketing_email_opt_in ? 'yes' : 'no', a.sms_opt_in ? 'yes' : 'no', a.utm_source, a.rsvp_at, a.flagged ? a.flag_reason || 'yes' : '']));
  },

  'GET /admin/rsvps/:id': async (req, res, url, params) => {
    const admin = await guard(req);
    const a = await one(`SELECT a.*, r.id AS rsvp_id, r.confirmation_no, r.status, r.guests_count, r.created_at AS rsvp_at, r.flagged, r.flag_reason, r.interests, r.interests_other, r.heard_from, r.invited_by_text, r.utm_source, r.utm_campaign, rc.code
      FROM attendees a JOIN rsvps r ON r.attendee_id = a.id LEFT JOIN referral_codes rc ON rc.attendee_id = a.id WHERE a.id = ?`, Number(params.id));
    if (!a) throw new HttpError(404, 'Attendee not found');
    const by = await one(`SELECT rr.*, x.first_name, x.last_name FROM referral_relationships rr JOIN attendees x ON x.id = rr.referrer_id WHERE rr.referred_id = ?`, a.id);
    const referred = await all(`SELECT rr.*, x.first_name, x.last_name, (SELECT status FROM referral_rewards w WHERE w.relationship_id = rr.id ORDER BY id LIMIT 1) AS reward FROM referral_relationships rr JOIN attendees x ON x.id = rr.referred_id WHERE rr.referrer_id = ? ORDER BY rr.attributed_at DESC`, a.id);
    const purchases = await all('SELECT * FROM raffle_purchases WHERE attendee_id = ? ORDER BY id DESC', a.id);
    const ledger = await all('SELECT l.*, p.public_id FROM raffle_ledger l LEFT JOIN raffle_purchases p ON p.id = l.purchase_id WHERE l.attendee_id = ? ORDER BY l.id DESC', a.id);
    const t = await entryTotals(a.id);
    const trail = await all(`SELECT * FROM audit_log WHERE (entity_type = 'attendee' AND entity_id = ?) OR (entity_type = 'rsvp' AND entity_id = ?) OR actor = ? ORDER BY id DESC LIMIT 50`, String(a.id), String(a.rsvp_id), `attendee:${a.id}`);
    const isAdmin = canSeePii(admin);
    const interests = JSON.parse(a.interests);
    page(res, admin, url, `${a.first_name} ${a.last_name}`, 'rsvps', html`
      <p><a href="/admin/rsvps">← All RSVPs</a></p>
      <section class="tiles">
        ${tile('Status', a.status)}${tile('Confirmation', a.confirmation_no)}${tile('Raffle entries', t.total, `${t.paid} paid · ${t.bonus} bonus · ${t.free} free`)}${tile('People referred', referred.length)}
      </section>
      <div class="cols">
        <section class="card"><h2>Details</h2>
          <dl class="dl">
            <dt>Email</dt><dd>${email(admin, a.email)}</dd><dt>Phone</dt><dd>${phone(admin, a.phone)}</dd><dt>State</dt><dd>${US_STATES[a.state]}</dd>
            <dt>Instagram</dt><dd>${a.instagram ? `@${a.instagram}` : '—'}</dd><dt>Age group</dt><dd>${AGE_GROUPS[a.age_group] || '—'}</dd><dt>Guests</dt><dd>${a.guests_count}</dd>
            <dt>Interests</dt><dd>${interests.map((i) => INTERESTS[i]).join(', ') || '—'}${a.interests_other ? html`<br><em>${a.interests_other}</em>` : ''}</dd>
            <dt>Heard from</dt><dd>${HEARD_FROM[a.heard_from] || '—'}</dd><dt>Typed “invited by”</dt><dd>${a.invited_by_text || '—'}</dd>
            <dt>Referred by</dt><dd>${by ? html`<a href="/admin/rsvps/${by.referrer_id}">${by.first_name} ${by.last_name}</a> via ${by.code} ${statusTag(by.status)} ${JSON.parse(by.flags).join(', ')}` : '—'}</dd>
            <dt>Invite code</dt><dd class="mono">${a.code}</dd><dt>Campaign</dt><dd>${a.utm_source || '—'} ${a.utm_campaign || ''}</dd>
            <dt>Consents</dt><dd>Marketing email ${a.marketing_email_opt_in ? 'yes' : 'no'} · SMS ${a.sms_opt_in ? 'yes' : 'no'} · Reminders ${a.reminders_opt_out ? 'opted out' : 'on'}</dd>
            <dt>Registered</dt><dd>${fmtDate(a.rsvp_at)}</dd>${a.flagged ? html`<dt>Flag</dt><dd>${a.flag_reason}</dd>` : ''}
          </dl>
        </section>
        ${isAdmin ? html`<section class="card"><h2>Edit registration</h2>
          <form class="form" method="post" action="/admin/rsvps/${a.id}">${csrf(admin)}<input type="hidden" name="action" value="update">
            <div class="g2"><label>First name<input name="first_name" value="${a.first_name}" required></label><label>Last name<input name="last_name" value="${a.last_name}" required></label></div>
            <label>Email<input name="email" type="email" value="${a.email}" required></label>
            <div class="g2"><label>Phone<input name="phone" value="${a.phone}" required></label><label>State<select name="state">${Object.entries(US_STATES).map(([k, v]) => html`<option value="${k}" ${k === a.state ? raw('selected') : ''}>${v}</option>`)}</select></label></div>
            <div class="g2"><label>Instagram<input name="instagram" value="${a.instagram || ''}"></label><label>Guests<input name="guests_count" type="number" min="0" max="10" value="${a.guests_count}"></label></div>
            <label>Reason for change (saved in the audit log)<input name="note" required></label>
            <button class="abtn abtn--primary">Save changes</button>
          </form>
          <h3>Actions</h3>
          <form class="form inline" method="post" action="/admin/rsvps/${a.id}">${csrf(admin)}
            <input name="note" placeholder="Reason" required>
            ${a.status === 'confirmed' ? html`<button class="abtn abtn--danger" name="action" value="cancel">Cancel registration</button>` : html`<button class="abtn" name="action" value="restore">Restore registration</button>`}
            ${a.flagged ? html`<button class="abtn" name="action" value="unflag">Clear flag</button>` : html`<button class="abtn" name="action" value="flag">Flag</button>`}
          </form>
          <form class="form inline" method="post" action="/admin/rsvps/${a.id}">${csrf(admin)}
            <button class="abtn" name="action" value="resend">Re-send confirmation${integrations.email() ? '' : ' (email not configured)'}</button>
          </form>
          <h3>Free entries</h3>
          <p class="hint">Record free entries only under a free-entry method your published rules allow. Use a negative number to remove free entries.</p>
          <form class="form inline" method="post" action="/admin/rsvps/${a.id}">${csrf(admin)}<input type="hidden" name="action" value="free_entry">
            <input name="entries" type="number" min="-100" max="100" step="1" required placeholder="Entries"><input name="note" required placeholder="Reason / free-entry reference"><button class="abtn">Record</button>
          </form>
        </section>` : ''}
      </div>
      <section class="card"><h2>People ${a.first_name} referred</h2>${referred.length ? html`<table class="atbl"><thead><tr><th>Name</th><th>RSVP</th><th>Attribution</th><th>Bonus</th></tr></thead><tbody>${referred.map((r) => html`<tr><td><a href="/admin/rsvps/${r.referred_id}">${r.first_name} ${r.last_name}</a></td><td>${fmtDate(r.attributed_at)}</td><td>${statusTag(r.status)} <span class="small">${JSON.parse(r.flags).join(', ')}</span></td><td>${r.reward ? statusTag(r.reward) : '—'}</td></tr>`)}</tbody></table>` : html`<p class="empty">Nobody yet.</p>`}</section>
      <section class="card"><h2>Purchases</h2>${purchases.length ? html`<table class="atbl"><thead><tr><th>Receipt</th><th>Entries</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>${purchases.map((p) => html`<tr><td class="mono"><a href="/raffle/receipt/${p.public_id}" target="_blank">${p.public_id}</a></td><td>${p.quantity}</td><td>${money(p.amount_cents)}${p.amount_refunded_cents ? html` <small>(−${money(p.amount_refunded_cents)})</small>` : ''}</td><td>${statusTag(p.status)}</td><td>${fmtDate(p.paid_at || p.created_at)}</td></tr>`)}</tbody></table>` : html`<p class="empty">No purchases.</p>`}</section>
      <section class="card"><h2>Entry ledger</h2>${ledger.length ? html`<table class="atbl"><thead><tr><th>When</th><th>Type</th><th>Entries</th><th>Purchase</th><th>Note</th><th>By</th></tr></thead><tbody>${ledger.map((l) => html`<tr><td>${fmtDate(l.created_at)}</td><td>${l.kind.replace(/_/g, ' ')}</td><td class="${l.entries < 0 ? 'neg' : ''}">${l.entries > 0 ? '+' : ''}${l.entries}</td><td class="mono">${l.public_id || '—'}</td><td>${l.note || ''}</td><td class="small">${l.created_by}</td></tr>`)}</tbody></table>` : html`<p class="empty">No entries yet.</p>`}</section>
      <section class="card"><h2>History</h2>${trail.map((x) => html`<p class="trail"><span>${fmtDate(x.created_at)}</span> <b>${x.action}</b> <small>${x.actor}</small>${x.note ? html` — ${x.note}` : ''}</p>`)}</section>
    `);
  },

  'POST /admin/rsvps/:id': async (req, res, url, params) => {
    const { admin, body } = await guardPost(req, 'admin');
    const id = Number(params.id);
    const a = await one('SELECT a.*, r.status, r.flagged, r.guests_count, r.id AS rsvp_id FROM attendees a JOIN rsvps r ON r.attendee_id = a.id WHERE a.id = ?', id);
    if (!a) throw new HttpError(404, 'Attendee not found');
    const note = clean(body.note, 300);
    const back = (msg, err) => redirect(res, `/admin/rsvps/${id}?${err ? `err=${encodeURIComponent(err)}` : `msg=${msg}`}`);
    switch (body.action) {
      case 'update': {
        if (!note) return back(null, 'Add a reason for the change.');
        const e = clean(body.email, 254).toLowerCase(), pn = normalizePhone(body.phone), g = Number(body.guests_count);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return back(null, 'Enter a valid email.');
        if (pn.length !== 10) return back(null, 'Enter a 10-digit phone number.');
        if (!US_STATES[body.state]) return back(null, 'Choose a state.');
        if (!Number.isInteger(g) || g < 0 || g > 10) return back(null, 'Guests must be 0–10.');
        const en = normalizeEmail(e);
        if (await one('SELECT 1 FROM attendees WHERE email_norm = ? AND id <> ?', en, id)) return back(null, 'Another registration already uses that email.');
        const after = { first_name: clean(body.first_name, 60), last_name: clean(body.last_name, 60), email: e, phone: clean(body.phone, 30), state: body.state, instagram: clean(body.instagram, 31).replace(/^@/, '') || null, guests_count: g };
        await batch([
          ['UPDATE attendees SET first_name=?, last_name=?, email=?, email_norm=?, phone=?, phone_norm=?, state=?, instagram=?, updated_at=? WHERE id=?', after.first_name, after.last_name, e, en, after.phone, pn, after.state, after.instagram, now(), id],
          ['UPDATE rsvps SET guests_count = ?, updated_at = ? WHERE attendee_id = ?', g, now(), id],
          auditStmt({ actor: actor(admin), action: 'admin.rsvp_edited', entityType: 'attendee', entityId: id, before: { first_name: a.first_name, last_name: a.last_name, email: a.email, phone: a.phone, state: a.state, instagram: a.instagram, guests_count: a.guests_count }, after, note, ipHash: ipHash(req) }),
        ]);
        return back('saved');
      }
      case 'cancel': case 'restore': {
        if (!note) return back(null, 'Add a reason.');
        await run('UPDATE rsvps SET status = ?, updated_at = ? WHERE attendee_id = ?', body.action === 'cancel' ? 'cancelled' : 'confirmed', now(), id);
        await audit({ actor: actor(admin), action: `admin.rsvp_${body.action}`, entityType: 'attendee', entityId: id, before: { status: a.status }, note, ipHash: ipHash(req) });
        return back('saved');
      }
      case 'flag': case 'unflag': {
        if (!note) return back(null, 'Add a reason.');
        await run('UPDATE rsvps SET flagged = ?, flag_reason = ?, updated_at = ? WHERE attendee_id = ?', body.action === 'flag' ? 1 : 0, body.action === 'flag' ? note : null, now(), id);
        await audit({ actor: actor(admin), action: `admin.rsvp_${body.action}`, entityType: 'attendee', entityId: id, note, ipHash: ipHash(req) });
        return back('saved');
      }
      case 'resend': {
        const rsvp = await one('SELECT * FROM rsvps WHERE attendee_id = ?', id);
        const code = (await one('SELECT code FROM referral_codes WHERE attendee_id = ?', id)).code;
        await run('DELETE FROM notifications WHERE dedupe_key = ? AND status <> ?', `rsvp_confirmation:${id}`, 'queued');
        await sendRsvpConfirmation(a, rsvp, { accessToken: await issueAccessToken(id), referralCode: code });
        await audit({ actor: actor(admin), action: 'admin.confirmation_resent', entityType: 'attendee', entityId: id, ipHash: ipHash(req) });
        return back('sent');
      }
      case 'free_entry': {
        const n = Number(body.entries);
        if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 100) return back(null, 'Entries must be a whole number between −100 and 100.');
        if (!note) return back(null, 'Add a reason or free-entry reference.');
        if (n < 0 && (await entryTotals(id)).free + n < 0) return back(null, 'Cannot remove more free entries than the person has.');
        await batch([
          [`INSERT INTO raffle_ledger (attendee_id, kind, entries, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`, id, n > 0 ? 'free_entry' : 'free_entry_reversal', n, note, actor(admin), now()],
          auditStmt({ actor: actor(admin), action: 'admin.free_entries', entityType: 'attendee', entityId: id, after: { entries: n }, note, ipHash: ipHash(req) }),
        ]);
        return back('entries');
      }
    }
    throw new HttpError(400, 'Unknown action');
  },

  // ---------- Referrals ----------
  'GET /admin/referrals': async (req, res, url) => {
    const admin = await guard(req);
    const st = url.searchParams.get('status') || '';
    const where = ['valid', 'suspicious', 'invalid'].includes(st) ? 'WHERE rr.status = ?' : '';
    const rels = await all(`SELECT rr.*, a.first_name AS r_first, a.last_name AS r_last, b.first_name AS d_first, b.last_name AS d_last
        FROM referral_relationships rr JOIN attendees a ON a.id = rr.referrer_id JOIN attendees b ON b.id = rr.referred_id ${where} ORDER BY rr.attributed_at DESC LIMIT 300`, ...(where ? [st] : []));
    const rewards = await all(`SELECT w.*, p.public_id, p.status AS p_status, p.amount_cents, a.first_name AS r_first, a.last_name AS r_last, b.first_name AS d_first, b.last_name AS d_last
        FROM referral_rewards w JOIN raffle_purchases p ON p.id = w.purchase_id JOIN attendees a ON a.id = w.referrer_id JOIN attendees b ON b.id = w.referred_id ORDER BY (w.status = 'pending_review') DESC, w.id DESC LIMIT 300`);
    const blocked = await all(`SELECT * FROM audit_log WHERE action IN ('referral.self_referral_blocked','referral.bonus_not_awarded') ORDER BY id DESC LIMIT 30`);
    const isAdmin = canSeePii(admin);
    page(res, admin, url, 'Referrals', 'referrals', html`
      <section class="card"><h2>Bonus rewards</h2>
      <p class="hint">A bonus is created only from a payment Stripe confirmed. Rewards from referrals flagged as suspicious wait here for review.</p>
      <div class="tablewrap"><table class="atbl"><thead><tr><th>Referrer</th><th>Referred person</th><th>Qualifying transaction</th><th>Entries</th><th>Status</th><th>Created</th>${isAdmin ? html`<th>Action</th>` : ''}</tr></thead><tbody>
      ${rewards.map((w) => html`<tr><td><a href="/admin/rsvps/${w.referrer_id}">${w.r_first} ${w.r_last}</a></td><td><a href="/admin/rsvps/${w.referred_id}">${w.d_first} ${w.d_last}</a></td>
        <td class="mono">${w.public_id} ${statusTag(w.p_status)} ${money(w.amount_cents)}</td><td>+${w.entries}</td><td>${statusTag(w.status)}${w.status_reason ? html`<br><small>${w.status_reason}</small>` : ''}</td><td>${fmtDate(w.created_at)}</td>
        ${isAdmin ? html`<td>${['awarded', 'pending_review'].includes(w.status) ? html`<form class="inline" method="post" action="/admin/referrals/reward/${w.id}">${csrf(admin)}<input name="note" placeholder="Reason" required>
          ${w.status === 'pending_review' ? html`<button class="abtn" name="action" value="approve">Approve</button>` : ''}<button class="abtn abtn--danger" name="action" value="reverse">${w.status === 'pending_review' ? 'Deny' : 'Reverse'}</button></form>` : '—'}</td>` : ''}</tr>`)}
      ${rewards.length ? '' : html`<tr><td colspan="7" class="empty">No referral bonuses yet.</td></tr>`}
      </tbody></table></div></section>

      <section class="card"><h2>Referral relationships</h2>
      <form class="filters" method="get"><label>Status <select name="status"><option value="">All</option>${['valid', 'suspicious', 'invalid'].map((x) => html`<option ${st === x ? raw('selected') : ''}>${x}</option>`)}</select></label><button class="abtn">Apply</button></form>
      <div class="tablewrap"><table class="atbl"><thead><tr><th>Referrer</th><th>Code</th><th>Referred</th><th>Attributed</th><th>Status &amp; flags</th>${isAdmin ? html`<th>Change status</th>` : ''}</tr></thead><tbody>
      ${rels.map((r) => html`<tr><td><a href="/admin/rsvps/${r.referrer_id}">${r.r_first} ${r.r_last}</a></td><td class="mono">${r.code}</td><td><a href="/admin/rsvps/${r.referred_id}">${r.d_first} ${r.d_last}</a></td><td>${fmtDate(r.attributed_at)}</td>
        <td>${statusTag(r.status)} <small>${JSON.parse(r.flags).join(', ').replace(/_/g, ' ')}</small></td>
        ${isAdmin ? html`<td><form class="inline" method="post" action="/admin/referrals/rel/${r.id}">${csrf(admin)}<select name="status">${['valid', 'suspicious', 'invalid'].map((x) => html`<option ${x === r.status ? raw('selected') : ''}>${x}</option>`)}</select><input name="note" placeholder="Reason" required><button class="abtn">Save</button></form></td>` : ''}</tr>`)}
      ${rels.length ? '' : html`<tr><td colspan="6" class="empty">No referrals yet.</td></tr>`}
      </tbody></table></div></section>

      <section class="card"><h2>Blocked or not-awarded attempts</h2>${blocked.length ? blocked.map((x) => html`<p class="trail"><span>${fmtDate(x.created_at)}</span> <b>${x.action.replace('referral.', '').replace(/_/g, ' ')}</b> ${x.entity_type} #${x.entity_id} — ${x.note}</p>`) : html`<p class="empty">None.</p>`}</section>
    `);
  },

  'POST /admin/referrals/reward/:id': async (req, res, url, params) => {
    const { admin, body } = await guardPost(req, 'admin');
    const note = clean(body.note, 300);
    if (!note) return redirect(res, `/admin/referrals?err=${encodeURIComponent('Add a reason.')}`);
    try {
      if (body.action === 'approve') await approveReward(Number(params.id), actor(admin), note);
      else await reverseReward(Number(params.id), actor(admin), note);
    } catch (e) {
      return redirect(res, `/admin/referrals?err=${encodeURIComponent(e.message)}`);
    }
    redirect(res, `/admin/referrals?msg=${body.action === 'approve' ? 'approved' : 'reversed'}`);
  },

  'POST /admin/referrals/rel/:id': async (req, res, url, params) => {
    const { admin, body } = await guardPost(req, 'admin');
    const r = await one('SELECT * FROM referral_relationships WHERE id = ?', Number(params.id));
    if (!r || !['valid', 'suspicious', 'invalid'].includes(body.status)) throw new HttpError(400, 'Invalid request');
    const note = clean(body.note, 300);
    if (!note) return redirect(res, `/admin/referrals?err=${encodeURIComponent('Add a reason.')}`);
    await run('UPDATE referral_relationships SET status = ? WHERE id = ?', body.status, r.id);
    await audit({ actor: actor(admin), action: 'admin.referral_status', entityType: 'referral_relationship', entityId: r.id, before: { status: r.status }, after: { status: body.status }, note, ipHash: ipHash(req) });
    redirect(res, '/admin/referrals?msg=saved');
  },

  // ---------- Leaderboard ----------
  'GET /admin/leaderboard': async (req, res, url) => {
    const admin = await guard(req);
    const { rows, sort } = await leaderboard(url);
    const { from, to } = dayRange(url);
    const sortLink = (k, label) => { const u = new URL(url); u.searchParams.set('sort', k); return html`<a href="${u.pathname}${u.search}" ${sort === k ? raw('aria-current="true" class="on"') : ''}>${label}</a>`; };
    page(res, admin, url, 'Who’s sharing the event', 'leaderboard', html`
      <p class="hint">Private to organizers. Visits are unique visitors per day; share taps count button taps on this site — social apps don’t report actual posts or views.</p>
      <form class="filters" method="get"><input type="hidden" name="sort" value="${sort}"><label>From <input type="date" name="from" value="${from}"></label><label>To <input type="date" name="to" value="${to}"></label><button class="abtn">Apply date range</button></form>
      <p class="sorts">Sort by: ${sortLink('rsvps', 'Most RSVPs referred')} ${sortLink('purchasers', 'Most qualifying purchasers')} ${sortLink('revenue', 'Most attributed revenue')} ${sortLink('bonus', 'Most bonus entries')}</p>
      <div class="tablewrap"><table class="atbl"><thead><tr><th>#</th><th>Referrer</th><th>Code</th><th>Link visits</th><th>Share taps</th><th>RSVPs referred</th><th>Qualifying purchasers</th><th>Attributed revenue</th><th>Bonus entries</th><th>Conversion</th></tr></thead><tbody>
      ${rows.map((r, i) => html`<tr><td>${i + 1}</td><td><a href="/admin/rsvps/${r.id}">${r.first_name} ${r.last_name}</a>${r.leaderboard_opt_in ? html` <small title="Opted in to public display">(public: ${r.display_name})</small>` : ''}</td><td class="mono">${r.code}</td><td>${r.visits}</td><td>${r.shares}</td><td>${r.rsvps}</td><td>${r.purchasers}</td><td>${money(r.revenue)}</td><td>${r.bonus}</td><td>${r.rsvps >= 5 ? `${Math.round((r.purchasers / r.rsvps) * 100)}%` : html`<small>needs 5+ RSVPs</small>`}</td></tr>`)}
      ${rows.length ? '' : html`<tr><td colspan="10" class="empty">No referral activity in this range.</td></tr>`}
      </tbody></table></div>`);
  },

  // ---------- Raffle & payments ----------
  'GET /admin/raffle': async (req, res, url) => {
    const admin = await guard(req);
    const st = url.searchParams.get('status') || '';
    const q = (url.searchParams.get('q') || '').trim();
    const where = [];
    const p = [];
    if (['pending', 'paid', 'failed', 'expired', 'refunded', 'partially_refunded', 'disputed', 'review'].includes(st)) { where.push('p.status = ?'); p.push(st); }
    if (q) { where.push(`(p.public_id = ? OR p.stripe_session_id = ? OR p.stripe_payment_intent = ? OR a.first_name || ' ' || a.last_name LIKE ?)`); p.push(q.toUpperCase(), q, q, `%${q}%`); }
    const purchases = await all(`SELECT p.*, a.first_name, a.last_name, (SELECT COUNT(*) FROM referral_rewards w WHERE w.purchase_id = p.id AND w.status = 'awarded') AS bonus_awarded
      FROM raffle_purchases p JOIN attendees a ON a.id = p.attendee_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.id DESC LIMIT 300`, ...p);
    const totals = await raffleTotals();
    const agg = await one(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status IN ('paid','partially_refunded','refunded','disputed') THEN amount_cents END),0) AS gross,
      COALESCE(SUM(amount_refunded_cents),0) AS refunded, COALESCE(SUM(CASE WHEN status='disputed' THEN amount_cents END),0) AS disputed FROM raffle_purchases`);
    // Reconciliation: each purchase's net paid entries must match its payment state.
    const mismatches = (await all(`SELECT p.public_id, p.status, p.quantity, p.amount_refunded_cents,
        COALESCE((SELECT SUM(entries) FROM raffle_ledger l WHERE l.purchase_id = p.id AND l.kind IN ('paid','paid_reversal','adjustment')),0) AS ledger
      FROM raffle_purchases p`)).filter((x) => {
        const expected = ['paid', 'partially_refunded'].includes(x.status) ? x.quantity - Math.ceil(x.amount_refunded_cents / 100) : 0;
        x.expected = expected;
        return x.ledger !== expected;
      });
    const orphanBonus = (await one(`SELECT COUNT(*) AS n FROM raffle_ledger l WHERE l.kind = 'referral_bonus' AND NOT EXISTS (SELECT 1 FROM referral_rewards w WHERE w.id = l.reward_id)`)).n;
    const s = getSettings();
    const gate = raffleGate();
    page(res, admin, url, 'Raffle & payments', 'raffle', html`
      <section class="tiles">
        ${tile('Entries in the drawing', totals.paid_entries + totals.bonus_entries + totals.free_entries)}
        ${tile('Paid entries', totals.paid_entries)}${tile('Bonus entries', totals.bonus_entries)}${tile('Free entries', totals.free_entries)}
        ${tile('Gross revenue', money(agg.gross))}${tile('Refunded', money(agg.refunded))}${tile('Disputed', money(agg.disputed))}${tile('Net', money(agg.gross - agg.refunded - agg.disputed))}
      </section>
      <section class="card ${mismatches.length || orphanBonus ? 'card--warn' : ''}"><h2>Reconciliation</h2>
        ${mismatches.length || orphanBonus
          ? html`<p><strong>${mismatches.length} purchase(s) don’t match the ledger.</strong> ${orphanBonus ? `${orphanBonus} bonus rows lack a reward record.` : ''}</p><ul>${mismatches.map((m) => html`<li class="mono">${m.public_id}: ${m.status}, ledger ${m.ledger}, expected ${m.expected}</li>`)}</ul>`
          : html`<p class="ok">All ${agg.n} purchases reconcile with the entry ledger. Every paid entry traces to a Stripe-confirmed payment and every bonus to a reward record.</p>`}
        <p class="hint">Checkout is ${gate.open ? 'open' : `closed (${gate.reasons.join(', ').replace(/_/g, ' ')})`}. Sales close ${fmtDate(eventTimes(s).raffleClose.toISOString())} ET. <a href="/admin/settings#s-raffle">Raffle settings</a></p>
      </section>
      <form class="filters" method="get"><label>Search <input name="q" value="${q}" placeholder="Receipt, Stripe id or name"></label>
        <label>Status <select name="status"><option value="">All</option>${['pending', 'paid', 'failed', 'expired', 'refunded', 'partially_refunded', 'disputed', 'review'].map((x) => html`<option value="${x}" ${st === x ? raw('selected') : ''}>${x.replace('_', ' ')}</option>`)}</select></label>
        <button class="abtn">Apply</button>
        ${canSeePii(admin) ? html`<a class="abtn abtn--ghost" href="/admin/raffle/transactions.csv">Export transactions</a><a class="abtn abtn--ghost" href="/admin/raffle/entries.csv">Export drawing entries</a><a class="abtn abtn--ghost" href="/admin/raffle/ledger.csv">Export full ledger</a>` : ''}
      </form>
      <div class="tablewrap"><table class="atbl"><thead><tr><th>Receipt</th><th>Buyer</th><th>Entries</th><th>Amount</th><th>Status</th><th>Referral</th><th>Stripe</th><th>Created</th><th>Paid</th></tr></thead><tbody>
      ${purchases.map((x) => html`<tr><td class="mono"><a href="/raffle/receipt/${x.public_id}" target="_blank">${x.public_id}</a></td><td><a href="/admin/rsvps/${x.attendee_id}">${x.first_name} ${x.last_name}</a></td><td>${x.quantity}</td>
        <td>${money(x.amount_cents)}${x.amount_refunded_cents ? html`<br><small>−${money(x.amount_refunded_cents)}</small>` : ''}</td><td>${statusTag(x.status)}${x.review_reason ? html`<br><small>${x.review_reason}</small>` : ''}</td>
        <td>${x.referral_code ? html`<span class="mono">${x.referral_code}</span>${x.bonus_awarded ? html`<br><small>+bonus</small>` : ''}` : '—'}</td>
        <td class="mono small">${x.stripe_payment_intent || x.stripe_session_id || '—'}</td><td>${fmtDate(x.created_at)}</td><td>${fmtDate(x.paid_at)}</td></tr>`)}
      ${purchases.length ? '' : html`<tr><td colspan="9" class="empty">No transactions yet.</td></tr>`}
      </tbody></table></div>
      <p class="hint">Refunds and disputes are handled in your Stripe dashboard; this page updates automatically from Stripe’s webhook. Paid entries can’t be added by hand.</p>`);
  },

  'GET /admin/raffle/transactions.csv': async (req, res) => {
    const admin = await guard(req, 'admin');
    const rows = await all(`SELECT p.*, a.first_name, a.last_name, a.email, r.confirmation_no FROM raffle_purchases p JOIN attendees a ON a.id = p.attendee_id JOIN rsvps r ON r.attendee_id = a.id ORDER BY p.id`);
    await audit({ actor: actor(admin), action: 'export.transactions', note: `${rows.length} rows`, ipHash: ipHash(req) });
    csv(res, 'raffle-transactions.csv', ['Receipt', 'Status', 'Confirmation', 'First name', 'Last name', 'Email', 'Entries', 'Amount USD', 'Refunded USD', 'Referral code', 'Stripe session', 'Stripe payment intent', 'Created (UTC)', 'Paid (UTC)'],
      rows.map((p) => [p.public_id, p.status, p.confirmation_no, p.first_name, p.last_name, p.email, p.quantity, (p.amount_cents / 100).toFixed(2), (p.amount_refunded_cents / 100).toFixed(2), p.referral_code, p.stripe_session_id, p.stripe_payment_intent, p.created_at, p.paid_at]));
  },
  'GET /admin/raffle/entries.csv': async (req, res) => {
    const admin = await guard(req, 'admin');
    const rows = await all(`SELECT a.id, a.first_name, a.last_name, a.email, a.phone, r.confirmation_no, r.status,
        COALESCE(SUM(CASE WHEN l.kind IN ('paid','paid_reversal') OR (l.kind='adjustment' AND l.purchase_id IS NOT NULL) THEN l.entries END),0) AS paid,
        COALESCE(SUM(CASE WHEN l.kind IN ('referral_bonus','referral_bonus_reversal') THEN l.entries END),0) AS bonus,
        COALESCE(SUM(CASE WHEN l.kind IN ('free_entry','free_entry_reversal') OR (l.kind='adjustment' AND l.purchase_id IS NULL) THEN l.entries END),0) AS free
      FROM raffle_ledger l JOIN attendees a ON a.id = l.attendee_id JOIN rsvps r ON r.attendee_id = a.id GROUP BY a.id HAVING paid + bonus + free > 0 ORDER BY a.last_name`);
    await audit({ actor: actor(admin), action: 'export.drawing_entries', note: `${rows.length} people`, ipHash: ipHash(req) });
    csv(res, 'drawing-entries.csv', ['Confirmation', 'RSVP status', 'First name', 'Last name', 'Email', 'Phone', 'Paid entries', 'Bonus entries', 'Free entries', 'Total entries'],
      rows.map((x) => [x.confirmation_no, x.status, x.first_name, x.last_name, x.email, x.phone, x.paid, x.bonus, x.free, x.paid + x.bonus + x.free]));
  },
  'GET /admin/raffle/ledger.csv': async (req, res) => {
    const admin = await guard(req, 'admin');
    const rows = await all(`SELECT l.*, a.first_name, a.last_name, r.confirmation_no, p.public_id FROM raffle_ledger l JOIN attendees a ON a.id = l.attendee_id JOIN rsvps r ON r.attendee_id = a.id LEFT JOIN raffle_purchases p ON p.id = l.purchase_id ORDER BY l.id`);
    await audit({ actor: actor(admin), action: 'export.ledger', note: `${rows.length} rows`, ipHash: ipHash(req) });
    csv(res, 'entry-ledger.csv', ['Ledger id', 'Time (UTC)', 'Confirmation', 'Name', 'Type', 'Entries', 'Purchase', 'Reward id', 'Note', 'Recorded by'],
      rows.map((l) => [l.id, l.created_at, l.confirmation_no, `${l.first_name} ${l.last_name}`, l.kind, l.entries, l.public_id, l.reward_id, l.note, l.created_by]));
  },

  // ---------- Prizes ----------
  'GET /admin/prizes': async (req, res, url) => {
    const admin = await guard(req);
    const prizes = await all('SELECT * FROM prizes ORDER BY sort_order, id');
    const editId = Number(url.searchParams.get('edit')) || 0;
    const edit = editId ? await one('SELECT * FROM prizes WHERE id = ?', editId) : null;
    const v = edit || { name: '', description: '', image_url: '', eligibility: '', restrictions: '', sponsor: '', confirmation: 'pending', winner_status: 'not_drawn', winner_display: '', published: 0, sort_order: prizes.length };
    page(res, admin, url, 'Prizes', 'prizes', html`
      <div class="tablewrap"><table class="atbl"><thead><tr><th>Order</th><th>Prize</th><th>Confirmation</th><th>Winner</th><th>Public</th><th></th></tr></thead><tbody>
      ${prizes.map((p) => html`<tr><td>${p.sort_order}</td><td>${p.name}</td><td>${statusTag(p.confirmation)}</td><td>${p.winner_status.replace('_', ' ')}${p.winner_display ? `: ${p.winner_display}` : ''}</td><td>${p.published ? 'Published' : 'Hidden'}</td><td><a href="/admin/prizes?edit=${p.id}#prize-form">Edit</a></td></tr>`)}
      ${prizes.length ? '' : html`<tr><td colspan="6" class="empty">No prizes yet.</td></tr>`}
      </tbody></table></div>
      ${canSeePii(admin) ? html`<form class="card form" id="prize-form" method="post" action="${edit ? `/admin/prizes/${edit.id}` : '/admin/prizes'}">${csrf(admin)}
        <h2>${edit ? `Edit “${edit.name}”` : 'Add a prize'}</h2>
        <label>Prize name<input name="name" value="${v.name}" required maxlength="120"></label>
        <label>Description<textarea name="description" rows="3">${v.description || ''}</textarea></label>
        <label>Image URL (https)<input name="image_url" value="${v.image_url || ''}" placeholder="https://…"></label>
        <div class="g2"><label>Eligibility<textarea name="eligibility" rows="2">${v.eligibility || ''}</textarea></label><label>Restrictions<textarea name="restrictions" rows="2">${v.restrictions || ''}</textarea></label></div>
        <div class="g2"><label>Sponsor (optional)<input name="sponsor" value="${v.sponsor || ''}"></label><label>Display order<input name="sort_order" type="number" value="${v.sort_order}"></label></div>
        <div class="g2"><label>Confirmation<select name="confirmation"><option value="pending" ${v.confirmation === 'pending' ? raw('selected') : ''}>Pending — shows “confirmation pending”</option><option value="confirmed" ${v.confirmation === 'confirmed' ? raw('selected') : ''}>Confirmed — details, restrictions and eligibility verified</option></select></label>
        <label>Winner status<select name="winner_status">${['not_drawn', 'drawn', 'announced'].map((x) => html`<option value="${x}" ${v.winner_status === x ? raw('selected') : ''}>${x.replace('_', ' ')}</option>`)}</select></label></div>
        <label>Winner display name (only once they agree to be announced)<input name="winner_display" value="${v.winner_display || ''}"></label>
        <label class="cbx"><input type="checkbox" name="published" ${v.published ? raw('checked') : ''}> Show on the public site</label>
        <div class="row"><button class="abtn abtn--primary">${edit ? 'Save prize' : 'Add prize'}</button>${edit ? html`<a class="abtn abtn--ghost" href="/admin/prizes">Cancel</a>` : ''}</div>
      </form>
      ${edit ? html`<form class="form inline" method="post" action="/admin/prizes/${edit.id}">${csrf(admin)}<input type="hidden" name="_delete" value="1"><button class="abtn abtn--danger">Delete this prize</button></form>` : ''}` : ''}`);
  },
  'POST /admin/prizes': async (req, res) => prizeSave(req, res, null),
  'POST /admin/prizes/:id': async (req, res, url, params) => prizeSave(req, res, Number(params.id)),

  // ---------- FAQ ----------
  'GET /admin/faq': async (req, res, url) => {
    const admin = await guard(req);
    const faqs = await all('SELECT * FROM faqs ORDER BY sort_order, id');
    const isAdmin = canSeePii(admin);
    page(res, admin, url, 'FAQ', 'faq', html`
      <p class="hint">Answers support **bold** and [links](https://example.com). Changes are live immediately.</p>
      ${faqs.map((f) => html`<form class="card form faqedit" method="post" action="/admin/faq/${f.id}">${csrf(admin)}<fieldset ${isAdmin ? '' : raw('disabled')}>
        <div class="g2 g2--narrow"><label>Question<input name="question" value="${f.question}" required></label><label>Order<input name="sort_order" type="number" value="${f.sort_order}"></label></div>
        <label>Answer<textarea name="answer" rows="3" required>${f.answer}</textarea></label>
        <div class="row"><label class="cbx"><input type="checkbox" name="published" ${f.published ? raw('checked') : ''}> Published</label><button class="abtn abtn--primary">Save</button><button class="abtn abtn--danger" name="_delete" value="1">Delete</button></div>
      </fieldset></form>`)}
      ${isAdmin ? html`<form class="card form" method="post" action="/admin/faq">${csrf(admin)}<h2>Add a question</h2>
        <label>Question<input name="question" required></label><label>Answer<textarea name="answer" rows="3" required></textarea></label>
        <input type="hidden" name="sort_order" value="${faqs.length}"><input type="hidden" name="published" value="on"><button class="abtn abtn--primary">Add question</button></form>` : ''}`);
  },
  'POST /admin/faq': async (req, res) => faqSave(req, res, null),
  'POST /admin/faq/:id': async (req, res, url, params) => faqSave(req, res, Number(params.id)),

  // ---------- Messages ----------
  'GET /admin/messages': async (req, res, url) => {
    const admin = await guard(req);
    const counts = await all('SELECT status, COUNT(*) AS n FROM notifications GROUP BY status');
    const log = await all('SELECT * FROM notifications ORDER BY id DESC LIMIT 150');
    const confirmed = (await one(`SELECT COUNT(*) AS n FROM rsvps WHERE status = 'confirmed'`)).n;
    page(res, admin, url, 'Messages', 'messages', html`
      <section class="tiles">${counts.length ? counts.map((c) => tile(c.status.replace('_', ' '), c.n)) : tile('Messages', 0)}</section>
      ${!integrations.email() ? html`<p class="flash flash--warn">Email isn’t configured, so messages are logged as “not configured” and not delivered. Set RESEND_API_KEY and EMAIL_FROM.</p>` : ''}
      ${canSeePii(admin) ? html`<form class="card form" method="post" action="/admin/messages">${csrf(admin)}
        <h2>Send an update to all ${confirmed} confirmed attendees</h2>
        <p class="hint">Use for venue announcements, schedule changes and other important event updates. Event updates go to everyone registered; texts go only to people who opted in to SMS.</p>
        <label>Subject<input name="subject" required maxlength="120" placeholder="Venue announced!"></label>
        <label>Message<textarea name="message" rows="6" required maxlength="3000"></textarea></label>
        <label class="cbx"><input type="checkbox" name="sms"> Also text people who opted in to SMS</label>
        <label class="cbx"><input type="checkbox" name="confirm" required> I’ve double-checked this message</label>
        <button class="abtn abtn--primary">Send update</button></form>` : ''}
      <section class="card"><h2>Delivery log</h2><div class="tablewrap"><table class="atbl"><thead><tr><th>When</th><th>Channel</th><th>Template</th><th>To</th><th>Status</th><th>Detail</th></tr></thead><tbody>
      ${log.map((n) => html`<tr><td>${fmtDate(n.created_at)}</td><td>${n.channel}</td><td>${n.template}</td><td class="small">${n.channel === 'email' ? email(admin, n.to_addr) : phone(admin, n.to_addr)}</td><td>${statusTag(n.status)}</td><td class="small">${n.error || n.provider_id || ''}</td></tr>`)}
      ${log.length ? '' : html`<tr><td colspan="6" class="empty">No messages yet.</td></tr>`}
      </tbody></table></div></section>`);
  },
  'POST /admin/messages': async (req, res) => {
    const { admin, body } = await guardPost(req, 'admin');
    const subject = clean(body.subject, 120), message = String(body.message || '').slice(0, 3000).trim();
    if (!subject || !message || body.confirm !== 'on') return redirect(res, `/admin/messages?err=${encodeURIComponent('Add a subject and message, and tick the confirmation box.')}`);
    const broadcastId = `${Date.now()}`;
    const n = await broadcastUpdate({ subject, message, includeSms: body.sms === 'on', broadcastId });
    await audit({ actor: actor(admin), action: 'admin.broadcast', after: { subject, recipients: n, sms: body.sms === 'on' }, ipHash: ipHash(req) });
    processQueue().catch(() => {});
    redirect(res, '/admin/messages?msg=sent');
  },

  // ---------- Settings ----------
  'GET /admin/settings': async (req, res, url) => {
    const admin = await guard(req);
    const s = getSettings();
    const isOwner = admin.role === 'owner';
    page(res, admin, url, 'Settings', 'settings', html`
      <nav class="toc">${Object.entries(SETTINGS_FORMS).map(([k, d]) => html`<a href="#s-${k}">${d.title}</a>`)}<a href="#s-compliance">Raffle compliance</a></nav>
      <section class="card ${s.raffle.compliance_approved ? '' : 'card--warn'}" id="s-compliance"><h2>Raffle compliance approval</h2>
        <p>Paid raffle checkout stays off until the owner records that the raffle structure, payment model, eligibility rules, free-entry method (if any) and prizes were reviewed and approved for Maryland and any other relevant jurisdictions. A paid raffle isn’t automatically lawful because it’s called a giveaway.</p>
        ${s.raffle.compliance_approved
          ? html`<p class="ok">Approved by <strong>${s.raffle.compliance_approved_by}</strong> on ${fmtDate(s.raffle.compliance_approved_at)}.</p>${s.raffle.compliance_notes ? html`<p class="hint">${s.raffle.compliance_notes}</p>` : ''}
            ${isOwner ? html`<form class="form inline" method="post" action="/admin/compliance">${csrf(admin)}<input type="hidden" name="action" value="revoke"><input name="note" placeholder="Reason" required><button class="abtn abtn--danger">Revoke approval</button></form>` : ''}`
          : isOwner
            ? html`<form class="form" method="post" action="/admin/compliance">${csrf(admin)}<input type="hidden" name="action" value="approve">
                <label>Reviewed by (name of legal adviser or organization)<input name="approver" required maxlength="120"></label>
                <label>Notes (permit numbers, organization status, conditions)<textarea name="notes" rows="3"></textarea></label>
                <label class="cbx"><input type="checkbox" name="attest" required> I confirm the raffle structure, payment model, eligibility rules and prizes comply with applicable law, and that the published raffle rules are final.</label>
                <button class="abtn abtn--primary">Record approval</button></form>`
            : html`<p class="hint">Only an owner can record compliance approval.</p>`}
      </section>
      ${Object.keys(SETTINGS_FORMS).map((g) => settingsForm(admin, g, s[g]))}`);
  },
  'POST /admin/settings/:group': async (req, res, url, params) => {
    const def = SETTINGS_FORMS[params.group];
    if (!def) throw new HttpError(404, 'Unknown settings group');
    const { admin, body } = await guardPost(req, def.role);
    let patch;
    try { patch = parseSettings(params.group, body); } catch (e) { return redirect(res, `/admin/settings?err=${encodeURIComponent(e.message)}#s-${params.group}`); }
    const { before, after } = await setSettingsGroup(params.group, patch, actor(admin));
    await audit({ actor: actor(admin), action: `settings.${params.group}`, entityType: 'settings', entityId: params.group, before: params.group === 'pages' ? null : before, after: params.group === 'pages' ? { pages: 'updated' } : after, ipHash: ipHash(req) });
    redirect(res, `/admin/settings?msg=saved#s-${params.group}`);
  },
  'POST /admin/compliance': async (req, res) => {
    const { admin, body } = await guardPost(req, 'owner');
    if (body.action === 'approve') {
      const approver = clean(body.approver, 120);
      if (!approver || body.attest !== 'on') return redirect(res, `/admin/settings?err=${encodeURIComponent('Enter who reviewed it and tick the confirmation.')}#s-compliance`);
      await setSettingsGroup('raffle', { compliance_approved: true, compliance_approved_by: approver, compliance_approved_at: now(), compliance_notes: String(body.notes || '').slice(0, 2000) }, actor(admin));
      await audit({ actor: actor(admin), action: 'raffle.compliance_approved', after: { approver, notes: body.notes }, ipHash: ipHash(req) });
      return redirect(res, '/admin/settings?msg=compliance_on#s-compliance');
    }
    if (body.action === 'revoke') {
      await setSettingsGroup('raffle', { compliance_approved: false, compliance_approved_by: '', compliance_approved_at: '' }, actor(admin));
      await audit({ actor: actor(admin), action: 'raffle.compliance_revoked', note: clean(body.note, 300), ipHash: ipHash(req) });
      return redirect(res, '/admin/settings?msg=compliance_off#s-compliance');
    }
    throw new HttpError(400, 'Unknown action');
  },

  // ---------- Audit ----------
  'GET /admin/audit': async (req, res, url) => {
    const admin = await guard(req);
    const pg = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const q = (url.searchParams.get('q') || '').trim();
    const rows = await all(`SELECT * FROM audit_log ${q ? 'WHERE action LIKE ? OR actor = ? OR entity_id = ?' : ''} ORDER BY id DESC LIMIT 101 OFFSET ?`, ...(q ? [`%${q}%`, q, q] : []), (pg - 1) * 100);
    page(res, admin, url, 'Audit log', 'audit', html`
      <p class="hint">Append-only. Every admin change, export, payment event and referral decision is recorded here and can’t be edited or deleted.</p>
      <form class="filters" method="get"><label>Filter <input name="q" value="${q}" placeholder="action, admin:1, entity id"></label><button class="abtn">Apply</button></form>
      <div class="tablewrap"><table class="atbl"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Note</th><th>Change</th></tr></thead><tbody>
      ${rows.slice(0, 100).map((x) => html`<tr><td>${fmtDate(x.created_at)}</td><td class="small">${x.actor}</td><td>${x.action}</td><td class="small">${x.entity_type || ''} ${x.entity_id || ''}</td><td>${x.note || ''}</td><td class="small mono">${canSeePii(admin) ? [x.before_json && `before ${x.before_json}`, x.after_json && `after ${x.after_json}`].filter(Boolean).join(' → ').slice(0, 400) : '—'}</td></tr>`)}
      </tbody></table></div>${pager(url, pg, rows.length > 100)}`);
  },

  // ---------- Team ----------
  'GET /admin/team': async (req, res, url) => {
    const admin = await guard(req);
    const team = await all('SELECT id, email, name, role, disabled, last_login_at, created_at FROM admins ORDER BY id');
    const isOwner = admin.role === 'owner';
    page(res, admin, url, 'Team', 'team', html`
      <p class="hint">Owner: everything, including compliance approval and team. Admin: manage RSVPs, referrals, prizes, settings and exports. Viewer: read-only, with contact details masked.</p>
      <div class="tablewrap"><table class="atbl"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th>${isOwner ? html`<th>Change</th>` : ''}</tr></thead><tbody>
      ${team.map((t) => html`<tr><td>${t.name}${t.disabled ? html` ${statusTag('disabled')}` : ''}</td><td>${t.email}</td><td>${t.role}</td><td>${fmtDate(t.last_login_at)}</td>
        ${isOwner ? html`<td>${t.id === admin.id ? '—' : html`<form class="inline" method="post" action="/admin/team/${t.id}">${csrf(admin)}<select name="role">${['viewer', 'admin', 'owner'].map((r) => html`<option ${r === t.role ? raw('selected') : ''}>${r}</option>`)}</select><label class="cbx"><input type="checkbox" name="disabled" ${t.disabled ? raw('checked') : ''}> disabled</label><button class="abtn">Save</button></form>`}</td>` : ''}</tr>`)}
      </tbody></table></div>
      ${isOwner ? html`<form class="card form" method="post" action="/admin/team">${csrf(admin)}<h2>Add a team member</h2>
        <div class="g2"><label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label></div>
        <div class="g2"><label>Role<select name="role"><option>viewer</option><option>admin</option><option>owner</option></select></label><label>Temporary password (12+ characters)<input name="password" type="password" minlength="12" required autocomplete="new-password"></label></div>
        <button class="abtn abtn--primary">Add member</button></form>` : ''}
      <form class="card form" method="post" action="/admin/password">${csrf(admin)}<h2>Change my password</h2>
        <div class="g2"><label>Current password<input name="current" type="password" required autocomplete="current-password"></label><label>New password (12+ characters)<input name="next" type="password" minlength="12" required autocomplete="new-password"></label></div>
        <button class="abtn abtn--primary">Update password</button></form>`);
  },
  'POST /admin/team': async (req, res) => {
    const { admin, body } = await guardPost(req, 'owner');
    const em = clean(body.email, 254).toLowerCase();
    if (!em.includes('@') || !clean(body.name) || !ROLE_RANK[body.role] || String(body.password || '').length < 12) return redirect(res, `/admin/team?err=${encodeURIComponent('Fill in every field; passwords need 12+ characters.')}`);
    if (await one('SELECT 1 FROM admins WHERE email = ?', em)) return redirect(res, `/admin/team?err=${encodeURIComponent('That email already has an account.')}`);
    await run('INSERT INTO admins (email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', em, clean(body.name, 80), body.role, await hashPassword(body.password), now());
    await audit({ actor: actor(admin), action: 'admin.team_added', after: { email: em, role: body.role }, ipHash: ipHash(req) });
    redirect(res, '/admin/team?msg=created');
  },
  'POST /admin/team/:id': async (req, res, url, params) => {
    const { admin, body } = await guardPost(req, 'owner');
    const id = Number(params.id);
    if (id === admin.id || !ROLE_RANK[body.role]) throw new HttpError(400, 'Invalid change');
    const before = await one('SELECT role, disabled FROM admins WHERE id = ?', id);
    await run('UPDATE admins SET role = ?, disabled = ? WHERE id = ?', body.role, body.disabled === 'on' ? 1 : 0, id);
    if (body.disabled === 'on') await run('DELETE FROM admin_sessions WHERE admin_id = ?', id);
    await audit({ actor: actor(admin), action: 'admin.team_changed', entityType: 'admin', entityId: id, before, after: { role: body.role, disabled: body.disabled === 'on' }, ipHash: ipHash(req) });
    redirect(res, '/admin/team?msg=saved');
  },
  'POST /admin/password': async (req, res) => {
    const { admin, body } = await guardPost(req, 'viewer');
    const row = await one('SELECT password_hash FROM admins WHERE id = ?', admin.id);
    if (!await verifyPassword(String(body.current || ''), row.password_hash)) return redirect(res, `/admin/team?err=${encodeURIComponent('Current password is incorrect.')}`);
    if (String(body.next || '').length < 12) return redirect(res, `/admin/team?err=${encodeURIComponent('Use at least 12 characters.')}`);
    await run('UPDATE admins SET password_hash = ? WHERE id = ?', await hashPassword(body.next), admin.id);
    await audit({ actor: actor(admin), action: 'admin.password_changed', ipHash: ipHash(req) });
    redirect(res, '/admin/team?msg=password');
  },
  'GET /admin/:rest': async (req, res) => { await guard(req); throw new HttpError(404, 'Page not found'); },
};

async function prizeSave(req, res, id) {
  const { admin, body } = await guardPost(req, 'admin');
  if (id && body._delete) {
    const before = await one('SELECT * FROM prizes WHERE id = ?', id);
    await run('DELETE FROM prizes WHERE id = ?', id);
    await audit({ actor: actor(admin), action: 'prize.deleted', entityType: 'prize', entityId: id, before, ipHash: ipHash(req) });
    return redirect(res, '/admin/prizes?msg=deleted');
  }
  const img = String(body.image_url || '').trim();
  if (img && !/^https:\/\/[^\s"'<>]+$/.test(img)) return redirect(res, `/admin/prizes?err=${encodeURIComponent('Image URL must start with https://')}`);
  const v = {
    name: clean(body.name, 120), description: String(body.description || '').slice(0, 1000).trim(), image_url: img || null,
    eligibility: String(body.eligibility || '').slice(0, 1000).trim(), restrictions: String(body.restrictions || '').slice(0, 1000).trim(), sponsor: clean(body.sponsor, 120) || null,
    confirmation: body.confirmation === 'confirmed' ? 'confirmed' : 'pending', winner_status: ['not_drawn', 'drawn', 'announced'].includes(body.winner_status) ? body.winner_status : 'not_drawn',
    winner_display: clean(body.winner_display, 80) || null, published: body.published === 'on' ? 1 : 0, sort_order: Number(body.sort_order) || 0,
  };
  if (!v.name) return redirect(res, `/admin/prizes?err=${encodeURIComponent('Give the prize a name.')}`);
  const cols = Object.keys(v);
  if (id) {
    const before = await one('SELECT * FROM prizes WHERE id = ?', id);
    await run(`UPDATE prizes SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...Object.values(v), now(), id);
    await audit({ actor: actor(admin), action: 'prize.updated', entityType: 'prize', entityId: id, before, after: v, ipHash: ipHash(req) });
  } else {
    const r = await run(`INSERT INTO prizes (${cols.join(', ')}, created_at, updated_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`, ...Object.values(v), now(), now());
    await audit({ actor: actor(admin), action: 'prize.created', entityType: 'prize', entityId: Number(r.lastInsertRowid), after: v, ipHash: ipHash(req) });
  }
  redirect(res, `/admin/prizes?msg=${id ? 'saved' : 'created'}`);
}

async function faqSave(req, res, id) {
  const { admin, body } = await guardPost(req, 'admin');
  if (id && body._delete) {
    const before = await one('SELECT * FROM faqs WHERE id = ?', id);
    await run('DELETE FROM faqs WHERE id = ?', id);
    await audit({ actor: actor(admin), action: 'faq.deleted', entityType: 'faq', entityId: id, before, ipHash: ipHash(req) });
    return redirect(res, '/admin/faq?msg=deleted');
  }
  const q = clean(body.question, 300), a = String(body.answer || '').slice(0, 3000).trim();
  if (!q || !a) return redirect(res, `/admin/faq?err=${encodeURIComponent('Add a question and an answer.')}`);
  if (id) {
    await run('UPDATE faqs SET question = ?, answer = ?, published = ?, sort_order = ?, updated_at = ? WHERE id = ?', q, a, body.published === 'on' ? 1 : 0, Number(body.sort_order) || 0, now(), id);
    await audit({ actor: actor(admin), action: 'faq.updated', entityType: 'faq', entityId: id, after: { question: q }, ipHash: ipHash(req) });
  } else {
    await run('INSERT INTO faqs (question, answer, published, sort_order, updated_at) VALUES (?, ?, ?, ?, ?)', q, a, body.published === 'on' ? 1 : 0, Number(body.sort_order) || 0, now());
    await audit({ actor: actor(admin), action: 'faq.created', after: { question: q }, ipHash: ipHash(req) });
  }
  redirect(res, `/admin/faq?msg=${id ? 'saved' : 'created'}`);
}

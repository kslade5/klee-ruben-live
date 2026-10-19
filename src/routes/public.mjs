import { config, integrations } from '../config.mjs';
import { one, all, run, now } from '../db.mjs';
import { readBody, readRawBody, parseCookies, setCookie, sendHtml, sendJson, send, redirect, rateLimit, ipHash, clientIp, HttpError } from '../lib/http.mjs';
import { randomToken, keyedHash, unsign, timingSafeEqualStr } from '../lib/security.mjs';
import { getSettings } from '../lib/settings.mjs';
import { validateRsvp, normalizeEmail } from '../lib/validate.mjs';
import { createRsvp, attendeeFromToken, issueAccessToken, findReferralCode, normalizeRefCode, rsvpOpenState, updateAttendeeSelf, referralStats, entryTotals } from '../lib/rsvp.mjs';
import { raffleGate, startCheckout, handleStripeEvent, verifySessionFromStripe } from '../lib/raffle.mjs';
import { verifyWebhook } from '../lib/stripe.mjs';
import { audit, track } from '../lib/audit.mjs';
import { icsFile } from '../lib/calendar.mjs';
import { sendAccessLink, queueReminders, processQueue } from '../lib/notify.mjs';
import { homePage } from '../views/home.mjs';
import { contentPage, messagePage, receiptPage, mePage } from '../views/pages.mjs';
import { confirmationHtml } from '../views/confirm.mjs';
import { html } from '../lib/html.mjs';

const ATT = 'kr_att', REF = 'kr_ref', VID = 'kr_vid', UTM = 'kr_utm';

function visitor(req, res) {
  const cookies = parseCookies(req);
  let vid = cookies[VID];
  if (!vid || !/^[A-Za-z0-9_-]{16,40}$/.test(vid)) {
    vid = randomToken(16);
    setCookie(res, VID, vid, { maxAge: 365 * 86400 });
  }
  return { cookies, visitorHash: keyedHash(`vid:${vid}`) };
}

function utmFrom(req, url, res, cookies) {
  const q = url.searchParams;
  if (q.get('utm_source')) {
    const utm = { source: q.get('utm_source'), medium: q.get('utm_medium') || '', campaign: q.get('utm_campaign') || '' };
    setCookie(res, UTM, JSON.stringify(utm).slice(0, 300), { maxAge: 30 * 86400 });
    return utm;
  }
  try { return JSON.parse(cookies[UTM] || '{}'); } catch { return {}; }
}

export const currentAttendee = (req) => attendeeFromToken(parseCookies(req)[ATT]);

async function verifyTurnstile(token, ip) {
  if (!integrations.turnstile()) return true;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: config.turnstile.secretKey, response: String(token || ''), remoteip: ip }),
      signal: AbortSignal.timeout(8000),
    });
    return (await r.json()).success === true;
  } catch {
    return false;
  }
}

export const publicRoutes = {
  'GET /': async (req, res, url) => {
    const { cookies, visitorHash } = visitor(req, res);
    const utm = utmFrom(req, url, res, cookies);
    let refCode = normalizeRefCode(cookies[REF]);
    const qRef = normalizeRefCode(url.searchParams.get('ref'));
    if (qRef && await findReferralCode(qRef)) {
      refCode = qRef;
      setCookie(res, REF, qRef, { maxAge: getSettings().referral.window_days * 86400 });
      const day = new Date().toISOString().slice(0, 10);
      const r = await run(`INSERT INTO referral_visits (code, visitor_hash, day, utm_source, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, qRef, visitorHash, day, utm.source || null, now());
      if (r.changes) await track('referral_landing', { visitorHash, refCode: qRef, utm });
    }
    await track('page_view', { visitorHash, refCode, utm });
    const attendee = await currentAttendee(req);
    const ref = refCode ? await findReferralCode(refCode) : null;
    sendHtml(res, homePage({
      prizes: await all('SELECT * FROM prizes WHERE published = 1 ORDER BY sort_order, id'),
      faqs: await all('SELECT * FROM faqs WHERE published = 1 ORDER BY sort_order, id'),
      attendee,
      referrer: ref && (!attendee || ref.attendee_id !== attendee.id) ? ref.first_name : null,
      gate: raffleGate(),
      rsvpState: await rsvpOpenState(),
      rsvpCount: (await one(`SELECT COUNT(*) AS n FROM rsvps WHERE status = 'confirmed'`)).n,
      turnstileSiteKey: integrations.turnstile() ? config.turnstile.siteKey : null,
    }));
  },

  'POST /api/rsvp': async (req, res) => {
    const ip = ipHash(req);
    if (!await rateLimit(`rsvp:${ip}`, 8, 600)) throw new HttpError(429, 'Too many attempts from this network. Wait a few minutes and try again.');
    const body = await readBody(req);
    const { cookies, visitorHash } = visitor(req, res);
    // Bot checks: honeypot field must be empty; the form must have been open at least 3 seconds.
    const ts = Number(unsign(body.form_ts));
    if (body.company || !ts || Date.now() - ts < 3000 || Date.now() - ts > 2 * 86400_000) {
      throw new HttpError(400, 'We couldn’t verify this submission. Reload the page and try again.');
    }
    if (!(await verifyTurnstile(body['cf-turnstile-response'], clientIp(req)))) throw new HttpError(400, 'Complete the verification check and try again.');
    const { ok, errors, value } = validateRsvp(body);
    if (!ok) return sendJson(res, { ok: false, errors, message: 'Fix the highlighted fields.' }, 422);

    let out;
    try {
      out = await createRsvp(value, { refCookie: cookies[REF], ipHash: ip, userAgent: req.headers['user-agent'], utm: utmFrom(req, new URL('http://x/'), res, cookies), visitorHash });
    } catch (e) {
      if (e.extra?.code === 'duplicate') {
        const existing = await one('SELECT * FROM attendees WHERE email_norm = ?', value.email_norm);
        let message = 'This email is already registered. Use “Find my registration” with your confirmation number to view or update it.';
        if (integrations.email() && await rateLimit(`resend:${existing.id}`, 2, 3600)) {
          await sendAccessLink(existing, await issueAccessToken(existing.id));
          message = 'This email is already registered. We just emailed the link to your event page so you can view or update your details.';
        }
        return sendJson(res, { ok: false, code: 'duplicate', message }, 409);
      }
      throw e;
    }
    setCookie(res, ATT, out.accessToken, { maxAge: 180 * 86400 });
    sendJson(res, { ok: true, confirmation: out.rsvp.confirmation_no, referralCode: out.referralCode, html: confirmationHtml(out) });
  },

  'POST /api/lookup': async (req, res) => {
    if (!await rateLimit(`lookup:${ipHash(req)}`, 6, 900)) throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.');
    const body = await readBody(req);
    const conf = String(body.confirmation_no || '').trim().toUpperCase().replace(/^KR(?!-)/, 'KR-');
    const att = await one(
      `SELECT a.id FROM attendees a JOIN rsvps r ON r.attendee_id = a.id WHERE a.email_norm = ? AND r.confirmation_no = ?`,
      normalizeEmail(body.email || ''), conf);
    if (!att) throw new HttpError(404, 'We couldn’t find a registration with that email and confirmation number.');
    setCookie(res, ATT, await issueAccessToken(att.id), { maxAge: 180 * 86400 });
    await audit({ actor: `attendee:${att.id}`, action: 'attendee.lookup', ipHash: ipHash(req) });
    sendJson(res, { ok: true });
  },

  'POST /api/raffle/checkout': async (req, res) => {
    const att = await currentAttendee(req);
    if (!att) throw new HttpError(401, 'RSVP or find your registration first.');
    if (!await rateLimit(`checkout:${att.id}`, 20, 600)) throw new HttpError(429, 'Too many checkout attempts. Wait a few minutes.');
    const body = await readBody(req);
    const { visitorHash } = visitor(req, res);
    const out = await startCheckout(att, { quantity: body.quantity, ageConfirmed: body.age === true }, { ipHash: ipHash(req), visitorHash });
    sendJson(res, { ok: true, url: out.url });
  },

  'POST /api/share': async (req, res) => {
    const att = await currentAttendee(req);
    const body = await readBody(req);
    const channel = String(body.channel || '').slice(0, 20);
    if (att && ['copy', 'native', 'whatsapp', 'sms', 'email', 'facebook', 'instagram', 'tiktok'].includes(channel) && await rateLimit(`share:${att.id}`, 60, 3600)) {
      await run('INSERT INTO share_clicks (attendee_id, channel, created_at) VALUES (?, ?, ?)', att.id, channel, now());
      await track('share_clicked', {});
    }
    sendJson(res, { ok: true });
  },

  'POST /api/track': async (req, res) => {
    const body = await readBody(req);
    const { visitorHash, cookies } = visitor(req, res);
    if (['rsvp_started', 'raffle_viewed'].includes(body.name) && await rateLimit(`track:${visitorHash}:${body.name}`, 3, 3600)) {
      await track(body.name, { visitorHash, refCode: normalizeRefCode(cookies[REF]) });
    }
    sendJson(res, { ok: true });
  },

  'POST /api/me': async (req, res) => {
    const att = await currentAttendee(req);
    if (!att) throw new HttpError(401, 'Your session expired. Open your event page link again.');
    const body = await readBody(req);
    const { ok, errors, value } = validateRsvp({ ...body, email: att.email, understands_in_person: true, privacy_agreed: true });
    if (!ok) return sendJson(res, { ok: false, errors, message: 'Fix the highlighted fields.' }, 422);
    value.leaderboard_opt_in = body.leaderboard_opt_in === true;
    value.reminders_opt_out = body.reminders_opt_out === true;
    await updateAttendeeSelf(att, value, ipHash(req));
    sendJson(res, { ok: true, message: 'Saved.' });
  },

  'GET /me': async (req, res) => {
    const att = await currentAttendee(req);
    if (!att) return sendHtml(res, messagePage('Find your registration', 'Open the link from your confirmation email, or use “Find my registration” in the raffle section with your email and confirmation number.', { actions: html`<p><a class="btn btn--gold" href="/#raffle">Find my registration</a> <a class="btn btn--ghost" href="/#rsvp">RSVP</a></p>` }), 401);
    sendHtml(res, mePage({
      att,
      stats: await referralStats(att.id),
      totals: await entryTotals(att.id),
      purchases: await all(`SELECT * FROM raffle_purchases WHERE attendee_id = ? AND status <> 'pending' OR (attendee_id = ? AND status = 'pending' AND created_at > ?) ORDER BY id DESC`, att.id, att.id, new Date(Date.now() - 3600_000).toISOString()),
      gate: raffleGate(),
    }));
  },

  'GET /me/logout': async (req, res) => {
    setCookie(res, ATT, '', { maxAge: 0 });
    redirect(res, '/');
  },

  'GET /me/:token': async (req, res, url, params) => {
    const att = await attendeeFromToken(params.token);
    if (!att) return sendHtml(res, messagePage('Link not recognized', 'This event page link is invalid or was replaced. Use “Find my registration” with your email and confirmation number.', { actions: html`<p><a class="btn btn--gold" href="/#raffle">Find my registration</a></p>` }), 404);
    setCookie(res, ATT, params.token, { maxAge: 180 * 86400 });
    redirect(res, '/me', 302); // keeps the private token out of the address bar and history
  },

  'GET /raffle/success': async (req, res, url) => {
    const sessionId = url.searchParams.get('session_id') || '';
    let p = null;
    try { p = await verifySessionFromStripe(sessionId); } catch (e) { console.error('[raffle] verify failed', e.message); }
    p ||= await one('SELECT * FROM raffle_purchases WHERE stripe_session_id = ?', sessionId);
    if (!p) return sendHtml(res, messagePage('We’re checking your payment', 'If you completed checkout, your receipt will appear on your event page within a few minutes.', { actions: html`<p><a class="btn btn--gold" href="/me">Go to my event page</a></p>` }));
    redirect(res, `/raffle/receipt/${p.public_id}`);
  },

  'GET /raffle/cancelled': async (req, res) => {
    sendHtml(res, messagePage('Checkout cancelled', 'No payment was taken. You can pick a bundle and try again whenever you’re ready.', { actions: html`<p><a class="btn btn--gold" href="/#raffle">Back to the raffle</a></p>` }));
  },

  'GET /raffle/receipt/:id': async (req, res, url, params) => {
    const p = /^RP-[A-Z0-9]{10}$/.test(params.id) ? await one('SELECT * FROM raffle_purchases WHERE public_id = ?', params.id) : null;
    if (!p) return sendHtml(res, messagePage('Receipt not found', 'Check the receipt number and try again.'), 404);
    sendHtml(res, receiptPage(p, await one('SELECT * FROM attendees WHERE id = ?', p.attendee_id)));
  },

  'GET /unsubscribe/:token': async (req, res, url, params) => {
    const a = await one('SELECT id FROM attendees WHERE unsubscribe_token = ?', params.token);
    if (!a) return sendHtml(res, messagePage('Link not recognized', 'This unsubscribe link is invalid.'), 404);
    sendHtml(res, messagePage('Unsubscribe', 'Stop marketing emails and texts about future events? You’ll still get messages about registrations and purchases you make.', { actions: html`<form method="post"><button class="btn btn--gold" type="submit">Unsubscribe</button></form>` }));
  },
  'POST /unsubscribe/:token': async (req, res, url, params) => {
    const a = await one('SELECT id FROM attendees WHERE unsubscribe_token = ?', params.token);
    if (!a) return sendHtml(res, messagePage('Link not recognized', 'This unsubscribe link is invalid.'), 404);
    await run('UPDATE attendees SET marketing_email_opt_in = 0, sms_opt_in = 0, updated_at = ? WHERE id = ?', now(), a.id);
    await audit({ actor: `attendee:${a.id}`, action: 'attendee.unsubscribed' });
    sendHtml(res, messagePage('You’re unsubscribed', 'You won’t receive marketing emails or texts from us.'));
  },

  'POST /webhooks/stripe': async (req, res) => {
    const raw = await readRawBody(req, 1024 * 1024);
    const event = verifyWebhook(raw, req.headers['stripe-signature']);
    if (!event) {
      await audit({ actor: 'system', action: 'stripe.webhook_rejected', note: 'Invalid signature', ipHash: ipHash(req) });
      return sendJson(res, { error: 'Invalid signature' }, 400);
    }
    const result = await handleStripeEvent(event);
    sendJson(res, { received: true, result });
  },

  'POST /api/cron/run': async (req, res) => {
    const auth = String(req.headers.authorization || '');
    if (!config.cronSecret || !timingSafeEqualStr(auth, `Bearer ${config.cronSecret}`)) throw new HttpError(401, 'Unauthorized');
    const reminders = await queueReminders();
    await processQueue();
    sendJson(res, { ok: true, remindersQueued: reminders });
  },

  'GET /event.ics': async (req, res) => send(res, 200, icsFile(), { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="klee-ruben-live.ics"' }),
  'GET /rules/raffle': async (req, res) => sendHtml(res, contentPage('raffle_rules', 'Raffle rules', '/rules/raffle')),
  'GET /rules/event': async (req, res) => sendHtml(res, contentPage('event_rules', 'Event rules', '/rules/event')),
  'GET /privacy': async (req, res) => sendHtml(res, contentPage('privacy', 'Privacy policy', '/privacy')),
  'GET /terms': async (req, res) => sendHtml(res, contentPage('terms', 'Terms and conditions', '/terms')),
  'GET /refund-policy': async (req, res) => sendHtml(res, contentPage('refund_policy', 'Refund policy', '/refund-policy')),
  'GET /contact': async (req, res) => redirect(res, '/#contact', 302),
  'GET /robots.txt': async (req, res) => send(res, 200, `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /me\nDisallow: /api/\nDisallow: /raffle/\nSitemap: ${config.baseUrl}/sitemap.xml\n`, { 'Content-Type': 'text/plain' }),
  'GET /sitemap.xml': async (req, res) => {
    const urls = ['/', '/rules/raffle', '/rules/event', '/privacy', '/terms', '/refund-policy'];
    send(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${config.baseUrl}${u}</loc></url>`).join('')}</urlset>`, { 'Content-Type': 'application/xml' });
  },
  'GET /healthz': async (req, res) => sendJson(res, { ok: true, time: new Date().toISOString() }),
};

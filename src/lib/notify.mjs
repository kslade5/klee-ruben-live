// Email (Resend) and SMS (Twilio) delivery with a durable queue and honest delivery logs.
// If a provider is not configured, messages are logged as "not_configured" — never as sent.
import { Buffer } from 'node:buffer';
import { config, integrations } from '../config.mjs';
import { one, all, run, batch, now } from '../db.mjs';
import { esc } from './html.mjs';
import { getSettings, eventTimes } from './settings.mjs';
import { formatInZone } from './time.mjs';
import { venueText, googleCalendarUrl } from './calendar.mjs';
import { defer } from './background.mjs';

function enqueueStmt({ attendeeId = null, channel, template, to, subject = null, text, html = null, dedupeKey = null }) {
  const configured = channel === 'email' ? integrations.email() : integrations.sms();
  const t = now();
  return [
    `INSERT INTO notifications (attendee_id, channel, template, to_addr, subject, body_text, body_html, status, error, dedupe_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`,
    attendeeId, channel, template, to, subject, text, html, configured ? 'queued' : 'not_configured',
    configured ? null : `${channel === 'email' ? 'Email (RESEND_API_KEY, EMAIL_FROM)' : 'SMS (TWILIO_*)'} is not configured`,
    dedupeKey, t, t,
  ];
}

export async function enqueue(msg) {
  const r = await run(...enqueueStmt(msg));
  if (r.changes) defer(() => processQueue(10));
  return r.changes > 0;
}

// Many messages at once (reminders, broadcasts): written in atomic chunks, delivered by the queue.
export async function enqueueMany(msgs) {
  let added = 0;
  for (let i = 0; i < msgs.length; i += 50) {
    const res = await batch(msgs.slice(i, i + 50).map(enqueueStmt));
    added += res.reduce((n, r) => n + r.changes, 0);
  }
  if (added) defer(() => processQueue(30));
  return added;
}

async function sendEmail(n) {
  const body = { from: config.email.from, to: [n.to_addr], subject: n.subject, text: n.body_text };
  if (n.body_html) body.html = n.body_html;
  if (config.email.replyTo) body.reply_to = config.email.replyTo;
  const res = await fetch(`${config.email.apiBase}/emails`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.email.resendKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `notif-${n.id}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${json.message || 'error'}`);
  return json.id || null;
}

async function sendSms(n) {
  const auth = Buffer.from(`${config.sms.twilioSid}:${config.sms.twilioToken}`).toString('base64');
  const res = await fetch(`${config.sms.apiBase}/2010-04-01/Accounts/${encodeURIComponent(config.sms.twilioSid)}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: `+1${n.to_addr}`, From: config.sms.from, Body: n.body_text }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${json.message || 'error'}`);
  return json.sid || null;
}

// Delivers up to `max` queued messages. Each message is claimed atomically, so several
// server instances (or the scheduled job) can run this at once without double-sending.
export async function processQueue(max = 40) {
  // Messages stuck mid-send for 10+ minutes go back in the queue.
  await run(`UPDATE notifications SET status = 'queued' WHERE status = 'sending' AND updated_at < ?`, new Date(Date.now() - 600_000).toISOString());
  for (let i = 0; i < max; i++) {
    const n = await one(
      `UPDATE notifications SET status = 'sending', attempts = attempts + 1, updated_at = ?
       WHERE id = (SELECT id FROM notifications WHERE status = 'queued' AND attempts < 3 ORDER BY id LIMIT 1) RETURNING *`, now());
    if (!n) break;
    try {
      const providerId = n.channel === 'email' ? await sendEmail(n) : await sendSms(n);
      await run(`UPDATE notifications SET status = 'sent', provider_id = ?, error = NULL, updated_at = ? WHERE id = ?`, providerId, now(), n.id);
    } catch (e) {
      await run(`UPDATE notifications SET status = ?, error = ?, updated_at = ? WHERE id = ?`, n.attempts >= 3 ? 'failed' : 'queued', String(e.message).slice(0, 500), now(), n.id);
      if (n.attempts < 3) break; // retry on the next run
    }
  }
}

// ---------- Templates ----------

function contactLines() {
  const c = getSettings().contact;
  return [c.email && `Email: ${c.email}`, c.phone && `Phone: ${c.phone}`, c.instagram_handle && `Instagram: @${c.instagram_handle.replace(/^@/, '')}`].filter(Boolean);
}

function whenText() {
  const s = getSettings();
  const { start, end } = eventTimes(s);
  const day = formatInZone(start, s.event.timezone, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const t1 = formatInZone(start, s.event.timezone, { hour: 'numeric', minute: '2-digit' });
  const t2 = formatInZone(end, s.event.timezone, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  return `${day}, ${t1}–${t2}`;
}

function emailShell(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#000;font-family:Arial,Helvetica,sans-serif;color:#F5F7FA">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:560px;background:#070b14;border:1px solid #1E8BFF;border-radius:14px">
<tr><td style="padding:28px 28px 8px"><div style="font-size:13px;letter-spacing:2px;color:#3DE0FF;font-weight:bold">KLEE &amp; RUBEN LIVE</div>
<h1 style="font-size:26px;line-height:1.2;margin:10px 0 0;color:#fff">${esc(title)}</h1></td></tr>
<tr><td style="padding:8px 28px 28px;font-size:16px;line-height:1.55;color:#d9e1ec">${bodyHtml}</td></tr>
</table>
<p style="font-size:12px;color:#7c8799;max-width:560px">Educational content only — not financial, investment, legal or credit advice. ${esc(config.baseUrl)}</p>
</td></tr></table></body></html>`;
}

const btn = (href, label) =>
  `<a href="${esc(href)}" style="display:inline-block;background:#FFC531;color:#000;font-weight:bold;text-decoration:none;padding:12px 20px;border-radius:999px;margin:6px 6px 6px 0">${esc(label)}</a>`;

export async function sendRsvpConfirmation(att, rsvp, { accessToken, referralCode }) {
  const s = getSettings();
  const meUrl = `${config.baseUrl}/me/${accessToken}`;
  const refUrl = `${config.baseUrl}/?ref=${referralCode}`;
  const lines = [
    `Hi ${att.first_name}, you're registered!`,
    ``,
    `Confirmation number: ${rsvp.confirmation_no}`,
    `When: ${whenText()}`,
    `Where: ${venueText(s)}`,
    rsvp.guests_count ? `Additional guests: ${rsvp.guests_count}` : null,
    ``,
    `Your private page (raffle entries, referrals, update your details): ${meUrl}`,
    `Add to Google Calendar: ${googleCalendarUrl()}`,
    `Calendar file: ${config.baseUrl}/event.ics`,
    ``,
    `Invite friends with your personal link: ${refUrl}`,
    `When someone RSVPs with your link and completes a qualifying raffle purchase, you earn ${s.referral.bonus_entries} bonus raffle entries (see the raffle rules).`,
    ``,
    ...contactLines(),
  ].filter((l) => l !== null);
  const htmlBody = `
<p>Hi ${esc(att.first_name)}, you're registered.</p>
<p style="font-size:14px;color:#9fb0c6;margin:0">Confirmation number</p>
<p style="font-size:24px;font-weight:bold;letter-spacing:2px;color:#FFC531;margin:2px 0 14px">${esc(rsvp.confirmation_no)}</p>
<p><strong style="color:#fff">When:</strong> ${esc(whenText())}<br><strong style="color:#fff">Where:</strong> ${esc(venueText(s))}${rsvp.guests_count ? `<br><strong style="color:#fff">Additional guests:</strong> ${rsvp.guests_count}` : ''}</p>
<p>${btn(meUrl, 'Open my event page')}${btn(googleCalendarUrl(), 'Add to calendar')}</p>
<p><strong style="color:#fff">Invite friends:</strong> share your personal link<br><a href="${esc(refUrl)}" style="color:#3DE0FF">${esc(refUrl)}</a><br>
When someone RSVPs with your link and completes a qualifying raffle purchase, you earn ${s.referral.bonus_entries} bonus raffle entries, subject to the <a href="${esc(config.baseUrl)}/rules/raffle" style="color:#3DE0FF">raffle rules</a>.</p>
<p style="color:#9fb0c6;font-size:14px">${contactLines().map(esc).join('<br>')}</p>
<p style="color:#7c8799;font-size:12px">Keep this email — the button above is your private link. Don't share it.</p>`;
  await enqueue({ attendeeId: att.id, channel: 'email', template: 'rsvp_confirmation', to: att.email, subject: `You're in — ${s.event.name}`, text: lines.join('\n'), html: emailShell("You're registered", htmlBody), dedupeKey: `rsvp_confirmation:${att.id}` });
  if (att.sms_opt_in) {
    await enqueue({ attendeeId: att.id, channel: 'sms', template: 'rsvp_confirmation', to: att.phone_norm, text: `You're registered for ${s.event.hosts} Live, ${whenText()}. Confirmation ${rsvp.confirmation_no}. Your page: ${meUrl} Reply STOP to opt out.`, dedupeKey: `rsvp_confirmation_sms:${att.id}` });
  }
}

export async function sendAccessLink(att, accessToken) {
  const meUrl = `${config.baseUrl}/me/${accessToken}`;
  await enqueue({
    attendeeId: att.id, channel: 'email', template: 'access_link', to: att.email,
    subject: 'Your event page link',
    text: `Hi ${att.first_name}, here's your private event page: ${meUrl}\nIf you didn't request this, you can ignore this email.`,
    html: emailShell('Your event page', `<p>Hi ${esc(att.first_name)}, here's your private event page.</p><p>${btn(meUrl, 'Open my event page')}</p><p style="color:#7c8799;font-size:12px">If you didn't request this, ignore this email.</p>`),
    dedupeKey: `access_link:${att.id}:${Date.now()}`,
  });
}

export async function sendPurchaseConfirmation(att, purchase) {
  const amount = (purchase.amount_cents / 100).toFixed(2);
  const c = contactLines();
  const meUrl = `${config.baseUrl}/raffle/receipt/${purchase.public_id}`;
  await enqueue({
    attendeeId: att.id, channel: 'email', template: 'purchase_confirmation', to: att.email,
    subject: `Receipt: ${purchase.quantity} raffle entries`,
    text: `Hi ${att.first_name}, your payment was confirmed.\n\nEntries: ${purchase.quantity}\nAmount: $${amount}\nReceipt number: ${purchase.public_id}\n\nView your receipt: ${meUrl}\n\nQuestions about this purchase? ${c.join(' · ') || 'Reply to this email.'}`,
    html: emailShell('Payment confirmed', `<p>Hi ${esc(att.first_name)}, your payment was confirmed.</p>
<p style="font-size:34px;font-weight:bold;color:#FFC531;margin:6px 0">${purchase.quantity} entries</p>
<p>Amount paid: $${amount}<br>Receipt number: ${esc(purchase.public_id)}</p><p>${btn(meUrl, 'View receipt')}</p>
<p style="color:#9fb0c6;font-size:14px">Questions about this purchase?<br>${c.map(esc).join('<br>') || 'Reply to this email.'}</p>`),
    dedupeKey: `purchase_confirmation:${purchase.id}`,
  });
}

export async function sendReferralBonus(referrer, entries, referredFirstName) {
  if (!getSettings().notify.referral_notifications || referrer.reminders_opt_out) return;
  await enqueue({
    attendeeId: referrer.id, channel: 'email', template: 'referral_bonus', to: referrer.email,
    subject: `You earned ${entries} bonus raffle entries`,
    text: `Nice work, ${referrer.first_name}! ${referredFirstName} completed a qualifying raffle purchase through your link, so ${entries} bonus entries were added to your account.`,
    html: emailShell(`+${entries} bonus entries`, `<p>Nice work, ${esc(referrer.first_name)}! ${esc(referredFirstName)} completed a qualifying raffle purchase through your link, so <strong style="color:#FFC531">${entries} bonus entries</strong> were added to your account.</p>`),
    dedupeKey: `referral_bonus:${referrer.id}:${Date.now()}`,
  });
}

export async function queueReminders() {
  const s = getSettings();
  const { start } = eventTimes(s);
  const t = Date.now();
  if (t >= start.getTime()) return 0;
  const msgs = [];
  for (const hours of s.notify.reminder_hours || []) {
    const due = start.getTime() - hours * 3600_000;
    if (t < due || t > due + 6 * 3600_000) continue; // only inside a 6h window after the reminder time
    const label = hours >= 48 ? `in ${Math.round(hours / 24)} days` : hours >= 24 ? 'tomorrow' : `in ${hours} hour${hours === 1 ? '' : 's'}`;
    const already = new Set((await all(`SELECT dedupe_key FROM notifications WHERE dedupe_key LIKE ?`, `reminder:${hours}:%`)).map((r) => r.dedupe_key));
    const rows = await all(`SELECT a.*, r.confirmation_no FROM attendees a JOIN rsvps r ON r.attendee_id = a.id WHERE r.status = 'confirmed' AND a.reminders_opt_out = 0`);
    for (const a of rows) {
      const text = `Reminder: ${s.event.name} with ${s.event.hosts} is ${label}.\nWhen: ${whenText()}\nWhere: ${venueText(s)}\nConfirmation: ${a.confirmation_no}`;
      if (!already.has(`reminder:${hours}:email:${a.id}`)) msgs.push({ attendeeId: a.id, channel: 'email', template: `reminder_${hours}h`, to: a.email, subject: `Reminder: ${s.event.name}`, text, html: emailShell('See you soon', `<p>${esc(text).replace(/\n/g, '<br>')}</p>`), dedupeKey: `reminder:${hours}:email:${a.id}` });
      if (a.sms_opt_in && !already.has(`reminder:${hours}:sms:${a.id}`)) msgs.push({ attendeeId: a.id, channel: 'sms', template: `reminder_${hours}h`, to: a.phone_norm, text: `${text.split('\n')[0]} ${venueText(s)}. Reply STOP to opt out.`, dedupeKey: `reminder:${hours}:sms:${a.id}` });
    }
  }
  return enqueueMany(msgs);
}

export async function broadcastUpdate({ subject, message, includeSms, broadcastId }) {
  const rows = await all(`SELECT a.* FROM attendees a JOIN rsvps r ON r.attendee_id = a.id WHERE r.status = 'confirmed'`);
  const msgs = [];
  for (const a of rows) {
    msgs.push({ attendeeId: a.id, channel: 'email', template: 'event_update', to: a.email, subject, text: message, html: emailShell(subject, `<p>${esc(message).replace(/\n/g, '<br>')}</p>`), dedupeKey: `update:${broadcastId}:email:${a.id}` });
    if (includeSms && a.sms_opt_in) msgs.push({ attendeeId: a.id, channel: 'sms', template: 'event_update', to: a.phone_norm, text: `${subject}: ${message}`.slice(0, 600) + ' Reply STOP to opt out.', dedupeKey: `update:${broadcastId}:sms:${a.id}` });
  }
  await enqueueMany(msgs);
  return rows.length;
}

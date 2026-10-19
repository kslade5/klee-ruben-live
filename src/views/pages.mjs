import { html, richText } from '../lib/html.mjs';
import { layout, siteFooter, icon, bootData } from './layout.mjs';
import { nav } from './home.mjs';
import { getSettings, eventTimes } from '../lib/settings.mjs';
import { formatInZone } from '../lib/time.mjs';
import { venueText, googleCalendarUrl } from '../lib/calendar.mjs';
import { US_STATES, INTERESTS, AGE_GROUPS } from '../lib/validate.mjs';
import { eligibleStates } from '../lib/raffle.mjs';
import { config } from '../config.mjs';

const shell = (title, inner, opts = {}) =>
  layout({ title: `${title} — Klee & Ruben Live`, path: opts.path || '/', noindex: opts.noindex, body: html`${nav()}<main id="main" class="page">${inner}</main>${siteFooter()}${opts.boot ? bootData(opts.boot) : ''}` });

export function contentPage(key, title, path) {
  const s = getSettings();
  let extra = '';
  if (key === 'raffle_rules') {
    const { raffleClose } = eventTimes(s);
    const states = eligibleStates(s);
    extra = html`<div class="facts-box">
      <h2>Current settings</h2>
      <ul>
        <li><strong>Price:</strong> $1 per entry, sold in bundles of 5. Minimum purchase 5 entries ($5). Maximum ${s.raffle.max_entries_per_purchase} entries per purchase.</li>
        <li><strong>Minimum age to buy:</strong> ${s.raffle.min_age}</li>
        <li><strong>Eligible states:</strong> ${states.length ? states.map((x) => US_STATES[x]).join(', ') : 'To be published'}</li>
        <li><strong>Online sales close:</strong> ${formatInZone(raffleClose, s.event.timezone, { dateStyle: 'full', timeStyle: 'short' })} ${formatInZone(raffleClose, s.event.timezone, { timeZoneName: 'short' }).split(' ').pop()}</li>
        <li><strong>Referral bonus:</strong> ${s.referral.bonus_entries} entries per qualifying referred purchase${s.referral.repeat_purchase_rewards ? ', including repeat purchases' : ' (first qualifying purchase per referred person)'}; attribution window ${s.referral.window_days} days.</li>
        <li><strong>Drawing:</strong> ${s.raffle.drawing_info}</li>
        ${s.raffle.free_entry_method ? html`<li><strong>Free method of entry:</strong> ${s.raffle.free_entry_method}</li>` : ''}
        <li><strong>Status:</strong> ${s.raffle.compliance_approved && s.raffle.sales_enabled ? 'Sales open' : 'Sales not open yet'}</li>
      </ul></div>`;
  }
  return shell(title, html`<article class="wrap prose">
    <h1>${title}</h1>
    ${extra}
    ${richText(s.pages[key])}
  </article>`, { path });
}

export function messagePage(title, message, { status = '', actions = '' } = {}) {
  return shell(title, html`<div class="wrap prose msg"><p class="msg__status">${status}</p><h1>${title}</h1><p>${message}</p>${actions}</div>`, { noindex: true });
}

export function receiptPage(p, att) {
  const s = getSettings();
  const c = s.contact;
  const statusText = {
    pending: 'Waiting for payment confirmation',
    paid: 'Payment confirmed',
    failed: 'Payment did not go through',
    expired: 'Checkout expired — no charge was made',
    refunded: 'Refunded',
    partially_refunded: 'Partially refunded',
    disputed: 'Payment disputed — entries on hold',
    review: 'Under review by the organizers',
  }[p.status];
  return shell('Receipt', html`<div class="wrap prose receipt">
    <p class="msg__status ${p.status === 'paid' ? 'is-ok' : ''}">${statusText}</p>
    <h1>${p.status === 'paid' ? `${p.quantity} entries confirmed` : 'Raffle purchase'}</h1>
    ${p.status === 'pending' ? html`<p data-autorefresh>We’re confirming your payment with Stripe. This page updates automatically.</p>` : ''}
    <dl class="receipt__dl">
      <div><dt>Receipt number</dt><dd>${p.public_id}</dd></div>
      <div><dt>Name</dt><dd>${att.first_name} ${att.last_name}</dd></div>
      <div><dt>Entries</dt><dd>${p.quantity}</dd></div>
      <div><dt>Amount</dt><dd>$${(p.amount_cents / 100).toFixed(2)}</dd></div>
      ${p.amount_refunded_cents ? html`<div><dt>Refunded</dt><dd>$${(p.amount_refunded_cents / 100).toFixed(2)}</dd></div>` : ''}
      <div><dt>Date</dt><dd>${formatInZone(new Date(p.paid_at || p.created_at), s.event.timezone, { dateStyle: 'medium', timeStyle: 'short' })}</dd></div>
    </dl>
    <p>Questions about this purchase? ${c.email ? html`Email <a href="mailto:${c.email}?subject=Raffle receipt ${p.public_id}">${c.email}</a>` : ''}${c.email && c.phone ? ' or call ' : ''}${c.phone ? html`<a href="tel:${c.phone.replace(/[^\d+]/g, '')}">${c.phone}</a>` : ''}${!c.email && !c.phone ? 'Use the contact details at the bottom of this page.' : ''} and include your receipt number.</p>
    <p><a class="btn btn--gold" href="/me">Go to my event page</a></p>
  </div>`, { noindex: true });
}

export function mePage({ att, stats, totals, purchases, gate }) {
  const s = getSettings();
  const { start, end } = eventTimes(s);
  const refUrl = `${config.baseUrl}/?ref=${stats.code}`;
  const interests = JSON.parse(att.interests || '[]');
  const fmt = (d) => formatInZone(new Date(d), s.event.timezone, { month: 'short', day: 'numeric' });
  return shell('My event page', html`<div class="wrap me">
    <header class="me__head">
      <p class="chip"><span class="chip__dot"></span>${att.rsvp_status === 'confirmed' ? 'You’re registered' : 'Registration cancelled'}</p>
      <h1>Hey ${att.first_name}.</h1>
      <p class="me__conf">Confirmation <b>${att.confirmation_no}</b> · ${formatInZone(start, s.event.timezone, { weekday: 'short', month: 'short', day: 'numeric' })}, ${formatInZone(start, s.event.timezone, { hour: 'numeric' })}–${formatInZone(end, s.event.timezone, { hour: 'numeric', timeZoneName: 'short' })} · ${venueText(s)}</p>
      <div class="me__actions"><a class="btn btn--ghost btn--sm" href="${googleCalendarUrl()}" target="_blank" rel="noopener">${icon('calendar')} Add to calendar</a><a class="btn btn--ghost btn--sm" href="/event.ics">Download .ics</a></div>
      <p class="tiny">Bookmark this page — it’s private to you. Don’t share this page’s link; share your invite link below instead.</p>
    </header>

    <section class="me__card me__share" aria-labelledby="share-h">
      <h2 id="share-h">Your invite link</h2>
      ${shareBlock(refUrl, s, stats.code)}
    </section>

    <section class="me__stats" aria-labelledby="stats-h">
      <h2 id="stats-h" class="sr-only">Your numbers</h2>
      <div class="stat"><b>${totals.total}</b><span>Raffle entries</span><small>${totals.paid} paid · ${totals.bonus} bonus${totals.free ? ` · ${totals.free} free` : ''}</small></div>
      <div class="stat"><b>${stats.visits}</b><span>Visits from your link</span><small>Unique visitors per day</small></div>
      <div class="stat"><b>${stats.rsvps}</b><span>RSVPs from your link</span></div>
      <div class="stat"><b>${stats.qualifying}</b><span>Qualifying purchases</span><small>${stats.pendingReview ? `${stats.pendingReview} pending review` : 'Bonus awarded'}</small></div>
      <div class="stat"><b>${stats.shares}</b><span>Share taps tracked</span><small>Taps on share buttons here. Social apps don’t report actual posts or views.</small></div>
    </section>

    <section class="me__card" aria-labelledby="refs-h">
      <h2 id="refs-h">Your referrals</h2>
      ${stats.referred.length
        ? html`<table class="tbl"><thead><tr><th>Friend</th><th>RSVP</th><th>Status</th></tr></thead><tbody>
          ${stats.referred.map((r) => html`<tr><td>${r.first_name} ${r.last_initial}.</td><td>${fmt(r.attributed_at)}</td><td>${refStatus(r, s.referral.bonus_entries)}</td></tr>`)}
          </tbody></table>`
        : html`<p class="empty">No referrals yet. Share your link — when a friend RSVPs through it, they’ll show up here.</p>`}
    </section>

    <section class="me__card" aria-labelledby="buy-h">
      <h2 id="buy-h">Raffle entries</h2>
      ${purchases.length
        ? html`<table class="tbl"><thead><tr><th>Receipt</th><th>Entries</th><th>Status</th></tr></thead><tbody>
            ${purchases.map((p) => html`<tr><td><a href="/raffle/receipt/${p.public_id}">${p.public_id}</a></td><td>${p.quantity}</td><td>${p.status.replace('_', ' ')}</td></tr>`)}
          </tbody></table>`
        : html`<p class="empty">No purchases yet.</p>`}
      <p>${gate.open ? html`<a class="btn btn--gold" href="/#raffle">Buy raffle entries</a>` : html`<span class="tiny">${gate.publicMessage}</span>`}</p>
    </section>

    <section class="me__card" aria-labelledby="edit-h">
      <h2 id="edit-h">Update my details</h2>
      <form class="rsvp__form me__form" data-me-form novalidate>
        <div class="grid2">
          ${f('first_name', 'First name', att.first_name)}
          ${f('last_name', 'Last name', att.last_name)}
          <div class="field"><label>Email</label><input value="${att.email}" disabled><p class="tiny">To change your email, contact the organizers.</p></div>
          ${f('phone', 'Mobile phone', att.phone, 'tel')}
          <div class="field"><label for="m-state">State</label><select id="m-state" name="state">${Object.entries(US_STATES).map(([k, v]) => html`<option value="${k}" ${k === att.state ? 'selected' : ''}>${v}</option>`)}</select><p class="field-error" data-error-for="state"></p></div>
          ${f('instagram', 'Instagram username', att.instagram || '')}
          <div class="field"><label for="m-age">Age group</label><select id="m-age" name="age_group"><option value="">Prefer not to say</option>${Object.entries(AGE_GROUPS).map(([k, v]) => html`<option value="${k}" ${k === att.age_group ? 'selected' : ''}>${v}</option>`)}</select></div>
          <div class="field"><label for="m-guests">Additional guests</label><select id="m-guests" name="guests_count">${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => html`<option value="${n}" ${n === att.guests_count ? 'selected' : ''}>${n === 0 ? 'Just me' : `+${n}`}</option>`)}</select><p class="field-error" data-error-for="guests_count"></p></div>
          ${f('display_name', 'Display name (if a leaderboard is published)', att.display_name || '')}
        </div>
        <div class="pills">${Object.entries(INTERESTS).map(([k, v]) => html`<label class="pill"><input type="checkbox" name="interests" value="${k}" ${interests.includes(k) ? 'checked' : ''}><span>${v}</span></label>`)}</div>
        ${f('interests_other', 'Anything else you’d like covered?', att.interests_other || '')}
        <fieldset><legend>Messages and privacy</legend>
          <label class="check check--opt"><input type="checkbox" name="marketing_email_opt_in" ${att.marketing_email_opt_in ? 'checked' : ''}><span>Email me about future events</span></label>
          <label class="check check--opt"><input type="checkbox" name="sms_opt_in" ${att.sms_opt_in ? 'checked' : ''}><span>Text me event reminders (reply STOP anytime)</span></label>
          <label class="check check--opt"><input type="checkbox" name="reminders_opt_out" ${att.reminders_opt_out ? 'checked' : ''}><span>Don’t send me reminder or referral emails</span></label>
          <label class="check check--opt"><input type="checkbox" name="leaderboard_opt_in" ${att.leaderboard_opt_in ? 'checked' : ''}><span>Show my display name if the organizers publish a referral leaderboard</span></label>
        </fieldset>
        <p class="form-error" data-form-error role="alert"></p>
        <p class="form-ok" data-form-ok role="status"></p>
        <button class="btn btn--gold" type="submit">Save changes</button>
      </form>
    </section>
  </div>`, { noindex: true, boot: { refUrl, shareText: shareText(s), code: stats.code } });
}

function refStatus(r, bonus) {
  if (r.reward_status === 'awarded') return html`<span class="tag tag--ok">+${bonus} earned</span>`;
  if (r.reward_status === 'pending_review') return html`<span class="tag">Under review</span>`;
  if (r.reward_status === 'reversed' || r.reward_status === 'denied') return html`<span class="tag tag--bad">Not eligible</span>`;
  if (r.status === 'invalid') return html`<span class="tag tag--bad">Not eligible</span>`;
  return html`<span class="tag">Pending — no purchase yet</span>`;
}

const f = (name, label, value, type = 'text') => html`<div class="field"><label for="m-${name}">${label}</label><input id="m-${name}" name="${name}" type="${type}" value="${value}"><p class="field-error" data-error-for="${name}"></p></div>`;

export const shareText = (s = getSettings()) => {
  const { start } = eventTimes(s);
  return `I’m going to this FREE live event in Maryland on ${formatInZone(start, s.event.timezone, { month: 'long', day: 'numeric' })}! Trading education, credit education, food, games, prizes, live performances, and networking. RSVP here:`;
};

// Share UI used on the RSVP confirmation (rendered client-side too) and the personal page.
export function shareBlock(refUrl, s, code) {
  return html`<div class="share" data-share>
    <div class="share__link"><input value="${refUrl}" readonly aria-label="Your invite link" data-share-url><button class="btn btn--gold btn--sm" type="button" data-copy>${icon('link')} Copy link</button></div>
    <p class="tiny">Invite code: <b>${code}</b></p>
    <label class="share__msg-label" for="share-msg">Message (edit it if you like)</label>
    <textarea id="share-msg" rows="3" data-share-msg>${shareText(s)} ${refUrl}</textarea>
    <div class="share__btns">
      <button class="sbtn" type="button" data-share-native hidden>${icon('share')}Share…</button>
      <a class="sbtn" data-channel="whatsapp" target="_blank" rel="noopener">${icon('whatsapp')}WhatsApp</a>
      <a class="sbtn" data-channel="sms">${icon('sms')}Text</a>
      <a class="sbtn" data-channel="email">${icon('mail')}Email</a>
      <a class="sbtn" data-channel="facebook" target="_blank" rel="noopener">${icon('facebook')}Facebook</a>
      <button class="sbtn" type="button" data-channel="instagram">${icon('instagram')}Instagram</button>
      <button class="sbtn" type="button" data-channel="tiktok">${icon('tiktok')}TikTok</button>
    </div>
    <p class="share__hint" data-share-hint role="status"></p>
  </div>`;
}

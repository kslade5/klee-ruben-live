import { html } from '../lib/html.mjs';
import { icon } from './layout.mjs';
import { shareBlock } from './pages.mjs';
import { getSettings, eventTimes } from '../lib/settings.mjs';
import { formatInZone } from '../lib/time.mjs';
import { venueText, googleCalendarUrl } from '../lib/calendar.mjs';
import { integrations, config } from '../config.mjs';

export function confirmationHtml({ attendee, rsvp, referralCode, referredBy }) {
  const s = getSettings();
  const { start, end } = eventTimes(s);
  const c = s.contact;
  const refUrl = `${config.baseUrl}/?ref=${referralCode}`;
  return String(html`
  <div class="confirm__burst" aria-hidden="true"></div>
  <p class="chip"><span class="chip__dot"></span>You’re registered</p>
  <h3 class="confirm__title">See you there, ${attendee.first_name}.</h3>
  <div class="confirm__ticket">
    <div><span>Confirmation</span><b>${rsvp.confirmation_no}</b></div>
    <div><span>When</span><b>${formatInZone(start, s.event.timezone, { weekday: 'short', month: 'short', day: 'numeric' })}, ${formatInZone(start, s.event.timezone, { hour: 'numeric' })}–${formatInZone(end, s.event.timezone, { hour: 'numeric', timeZoneName: 'short' })}</b></div>
    <div><span>Where</span><b>${venueText(s)}</b></div>
    ${rsvp.guests_count ? html`<div><span>Guests</span><b>+${rsvp.guests_count}</b></div>` : ''}
  </div>
  ${referredBy ? html`<p class="tiny">Invited by ${referredBy}.</p>` : ''}
  <p>${integrations.email() ? 'A confirmation email is on its way with your private event page link.' : 'Save your confirmation number. Your private event page is linked below.'}</p>
  <div class="confirm__actions">
    <a class="btn btn--gold" href="/me">Open my event page</a>
    <a class="btn btn--ghost" href="${googleCalendarUrl()}" target="_blank" rel="noopener">${icon('calendar')} Add to calendar</a>
    <a class="btn btn--ghost" href="/event.ics">Download .ics</a>
  </div>
  <h4 class="confirm__h">Invite friends, earn bonus entries</h4>
  <p>When a friend RSVPs with your link and completes a qualifying raffle purchase, you get ${s.referral.bonus_entries} bonus raffle entries. <a href="/rules/raffle">Rules</a></p>
  ${shareBlock(refUrl, s, referralCode)}
  ${c.email || c.phone || c.instagram_handle ? html`<p class="tiny">Questions? ${[c.phone, c.email, c.instagram_handle && `@${c.instagram_handle.replace(/^@/, '')}`].filter(Boolean).join(' · ')}</p>` : ''}`);
}

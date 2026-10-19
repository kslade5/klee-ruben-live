import { html, raw, richText } from '../lib/html.mjs';
import { layout, siteFooter, icon, bootData, asset } from './layout.mjs';
import { getSettings, eventTimes } from '../lib/settings.mjs';
import { formatInZone } from '../lib/time.mjs';
import { venueText, googleCalendarUrl } from '../lib/calendar.mjs';
import { US_STATES, INTERESTS, AGE_GROUPS, HEARD_FROM } from '../lib/validate.mjs';
import { BUNDLES, eligibleStates } from '../lib/raffle.mjs';
import { config } from '../config.mjs';

export function nav() {
  return html`<header class="nav" data-nav>
  <div class="wrap nav__inner">
    <a class="nav__logo" href="/" aria-label="Klee and Ruben Live — home"><span>K</span><i>&amp;</i><span>R</span><b>Live</b></a>
    <button class="nav__toggle" type="button" aria-expanded="false" aria-controls="nav-menu" data-nav-toggle><span></span><span></span><span class="sr-only">Menu</span></button>
    <nav class="nav__menu" id="nav-menu" aria-label="Main">
      <a href="/#experience">Experience</a>
      <a href="/#prizes">Prizes</a>
      <a href="/#raffle">Raffle</a>
      <a href="/#faq">FAQ</a>
      <a class="btn btn--gold btn--sm" href="/#rsvp">RSVP free</a>
    </nav>
  </div>
</header>`;
}

function candles() {
  // Deterministic illustrative candlesticks (not real market data).
  const data = [[40, 52, 36, 50], [50, 58, 46, 47], [47, 55, 44, 54], [54, 66, 52, 63], [63, 64, 54, 56], [56, 60, 50, 59], [59, 74, 58, 72], [72, 76, 64, 66], [66, 70, 60, 69], [69, 84, 68, 82], [82, 86, 75, 78], [78, 92, 77, 90]];
  const w = 360, h = 150, cw = w / data.length;
  const y = (v) => h - ((v - 30) / 65) * h;
  return raw(`<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Illustrative candlestick chart">
  <g class="chart__grid">${[0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="${w}" y1="${h * f}" y2="${h * f}"/>`).join('')}</g>
  ${data.map(([o, hi, lo, c], i) => {
    const up = c >= o, x = i * cw + cw / 2, top = y(Math.max(o, c)), bh = Math.max(3, Math.abs(y(o) - y(c)));
    return `<g class="candle ${up ? 'up' : 'down'}" style="--i:${i}"><line x1="${x}" x2="${x}" y1="${y(hi)}" y2="${y(lo)}"/><rect x="${x - cw * 0.28}" y="${top}" width="${cw * 0.56}" height="${bh}" rx="1.5"/></g>`;
  }).join('')}
  <polyline class="chart__trend" points="${data.map(([, , , c], i) => `${i * cw + cw / 2},${y(c) - 10}`).join(' ')}"/>
</svg>`);
}

function gauge() {
  return raw(`<svg class="gauge" viewBox="0 0 220 130" role="img" aria-label="Illustrative credit score gauge">
  <defs><linearGradient id="gg" x1="0" x2="1"><stop offset="0" stop-color="#ff4d4d"/><stop offset=".5" stop-color="#FFC531"/><stop offset="1" stop-color="#2BE07A"/></linearGradient></defs>
  <path d="M20 115 A90 90 0 0 1 200 115" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="18" stroke-linecap="round"/>
  <path class="gauge__arc" d="M20 115 A90 90 0 0 1 200 115" fill="none" stroke="url(#gg)" stroke-width="18" stroke-linecap="round" pathLength="100"/>
  <g class="gauge__needle"><line x1="110" y1="115" x2="110" y2="40" stroke="#fff" stroke-width="4" stroke-linecap="round"/><circle cx="110" cy="115" r="9" fill="#fff"/></g>
</svg>`);
}

const ticketPrize = (p) => html`<article class="ticket ticket--prize" data-reveal>
  <div class="ticket__main">
    ${p.image_url ? html`<img class="ticket__img" src="${p.image_url}" alt="" loading="lazy" width="320" height="180">` : ''}
    <p class="ticket__status ${p.confirmation === 'confirmed' ? 'is-ok' : ''}">${p.confirmation === 'confirmed' ? 'Confirmed prize' : 'Proposed giveaway — confirmation pending'}</p>
    <h3 class="ticket__title">${p.name}</h3>
    ${p.description ? html`<p>${p.description}</p>` : ''}
    <dl class="ticket__meta">
      ${p.eligibility ? html`<div><dt>Eligibility</dt><dd>${p.eligibility}</dd></div>` : ''}
      ${p.restrictions ? html`<div><dt>Restrictions</dt><dd>${p.restrictions}</dd></div>` : ''}
      ${p.sponsor ? html`<div><dt>Sponsor</dt><dd>${p.sponsor}</dd></div>` : ''}
    </dl>
  </div>
  <div class="ticket__stub" aria-hidden="${p.winner_status === 'announced' ? 'false' : 'true'}">
    ${p.winner_status === 'announced' && p.winner_display ? html`<span>Winner</span><strong>${p.winner_display}</strong>` : p.winner_status === 'drawn' ? html`<span>Drawn</span><strong>Winner being notified</strong>` : html`<span>Draw</span><strong>At the event</strong>`}
  </div>
</article>`;

export function homePage({ prizes, faqs, attendee, referrer, gate, rsvpState, rsvpCount, turnstileSiteKey }) {
  const s = getSettings();
  const { start, end, raffleClose } = eventTimes(s);
  const tz = s.event.timezone;
  const dayLong = formatInZone(start, tz, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const timeRange = `${formatInZone(start, tz, { hour: 'numeric' })}–${formatInZone(end, tz, { hour: 'numeric', timeZoneName: 'short' })}`;
  const venue = venueText(s);
  const venueSet = Boolean(s.event.venue_address);
  const showCount = s.public.show_rsvp_count && rsvpCount >= s.public.rsvp_count_min;
  const states = eligibleStates(s);
  const bonus = s.referral.bonus_entries;

  const body = html`
${nav()}
<main id="main">

<section class="hero" aria-labelledby="hero-title">
  <div class="hero__bg" aria-hidden="true"><div class="brick"></div><div class="beam beam--blue"></div><div class="beam beam--gold"></div><canvas class="dust" data-dust></canvas></div>
  <div class="wrap hero__grid">
    <div class="hero__copy">
      <p class="chip"><span class="chip__dot"></span>Maryland • Live in person</p>
      <h1 class="hero__title" id="hero-title">
        <span class="t-invite">You’re invited to a</span>
        <span class="t-row"><span class="t-free">Free</span><span class="t-live">Live</span></span>
        <span class="t-session">In-person <span>session</span></span>
      </h1>
      <p class="hero__slogan">Learn trading &amp; get your credit fixed for free</p>
      <p class="hero__hosts">Hosted by <strong>Klee</strong> &amp; <strong>Ruben</strong></p>
      <ul class="facts" aria-label="Event details">
        <li>${icon('calendar')}<span>${formatInZone(start, tz, { month: 'long', day: 'numeric', year: 'numeric' })}</span></li>
        <li>${icon('clock')}<span>${timeRange}</span></li>
        <li>${icon('pin')}<span>${venueSet ? venue : 'Maryland — venue details coming soon'}</span></li>
      </ul>
      <div class="cd cd--hero" data-countdown aria-live="off">
        <div><b data-u="d">--</b><span>days</span></div>
        <div><b data-u="h">--</b><span>hrs</span></div>
        <div><b data-u="m">--</b><span>min</span></div>
        <div><b data-u="s">--</b><span>sec</span></div>
        <p class="cd__msg" data-cd-msg hidden></p>
      </div>
      <div class="hero__ctas">
        <a class="btn btn--gold btn--lg" href="#rsvp" data-track="rsvp_started">Claim your free spot</a>
        <a class="btn btn--ghost btn--lg" href="#experience">Explore the experience</a>
      </div>
    </div>
    <div class="hero__art" aria-hidden="true">
      <div class="frame"><span class="frame__line frame__line--a"></span><span class="frame__line frame__line--b"></span></div>
      <img class="hero__hosts-img" src="/img/hosts.webp" width="980" height="1048" alt="Klee and Ruben" fetchpriority="high">
      <p class="sticker">Everyone is welcome!</p>
    </div>
  </div>
  <a class="scroll-cue" href="#when" aria-label="Scroll to event details"><span></span></a>
</section>

<section class="when" id="when" aria-labelledby="when-title">
  <div class="wrap">
    <h2 class="sr-only" id="when-title">When and where</h2>
    <div class="board" data-reveal>
      <div class="board__clock">
        <p class="board__label" data-cd-label>Doors open in</p>
        <div class="cd cd--board" data-countdown>
          <div><b data-u="d">--</b><span>Days</span></div>
          <div><b data-u="h">--</b><span>Hours</span></div>
          <div><b data-u="m">--</b><span>Minutes</span></div>
          <div><b data-u="s">--</b><span>Seconds</span></div>
          <p class="cd__msg" data-cd-msg hidden></p>
        </div>
      </div>
      <dl class="board__facts">
        <div><dt>${icon('calendar')} When</dt><dd>${dayLong}<br>${timeRange}</dd></div>
        <div><dt>${icon('pin')} Where</dt><dd>${venue}${s.event.venue_directions_url ? html`<br><a href="${s.event.venue_directions_url}" target="_blank" rel="noopener">Get directions</a>` : ''}</dd></div>
        <div><dt>${icon('check')} Admission</dt><dd>Free with RSVP. Kids &amp; teens 8+ welcome.</dd></div>
      </dl>
      <div class="board__actions">
        <a class="btn btn--ghost" href="${googleCalendarUrl()}" target="_blank" rel="noopener">${icon('calendar')} Add to Google Calendar</a>
        <a class="btn btn--ghost" href="/event.ics" download="klee-ruben-live.ics">Download calendar invite (.ics)</a>
      </div>
    </div>
  </div>
</section>

<section class="exp" id="experience" aria-labelledby="exp-title">
  <div class="wrap">
    <h2 class="sec-title" id="exp-title">Three hours. <span>Real information.</span></h2>
    <p class="sec-lede">Live teaching, Q&amp;A, and a room full of people working on the same goals — plus food, games and performances.</p>
    <div class="exp__grid">
      <article class="panel panel--blue" data-reveal data-animate>
        <h3 class="panel__title"><small>Learn</small>Trading</h3>
        <div class="panel__visual">${candles()}<p class="tiny">Illustration</p></div>
        <ul class="checks">
          <li>Trading fundamentals</li><li>Day-trading concepts</li><li>Crypto education</li>
          <li>Live strategies &amp; demonstrations</li><li>Risk management</li><li>Educational tools &amp; resources</li>
        </ul>
      </article>
      <article class="panel panel--green" data-reveal data-animate>
        <h3 class="panel__title"><small>Understand your</small>Credit</h3>
        <div class="panel__visual">${gauge()}<p class="tiny">Illustration</p></div>
        <ul class="checks">
          <li>Read and understand your credit report</li><li>What affects your credit scores</li><li>How the credit-report dispute process works</li>
          <li>Responsible credit-building habits</li><li>Credit-improvement options explained</li>
        </ul>
        <p class="panel__note">Education and step-by-step guidance. Results depend on your own situation; no score change is promised.</p>
      </article>
    </div>
    <div class="stage" data-reveal>
      <div class="stage__bulbs" aria-hidden="true"></div>
      <h3 class="stage__title">Entertainment &amp; community</h3>
      <ul class="stage__list">
        <li><span class="stage__ico">${raw('<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 26h32a16 16 0 0 1-32 0z" fill="currentColor" opacity=".9"/><path d="M14 20c0-3 3-3 3-6M22 20c0-3 3-3 3-6M30 20c0-3 3-3 3-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>')}</span>Free food</li>
        <li><span class="stage__ico">${raw('<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="5" y="15" width="38" height="20" rx="10" fill="currentColor"/><path d="M15 21v8M11 25h8" stroke="#000" stroke-width="3" stroke-linecap="round"/><circle cx="31" cy="23" r="2.4" fill="#000"/><circle cx="36" cy="27" r="2.4" fill="#000"/></svg>')}</span>Games &amp; fun</li>
        <li><span class="stage__ico">${raw('<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 6v24M17 23a7 7 0 1 0 14 0" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><rect x="18" y="4" width="12" height="20" rx="6" fill="currentColor"/><path d="M24 37v6M17 43h14" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>')}</span>Live performances</li>
        <li><span class="stage__ico">${raw('<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="17" cy="16" r="6" fill="currentColor"/><circle cx="33" cy="16" r="6" fill="currentColor"/><path d="M6 38c1-8 6-12 11-12s10 4 11 12M22 38c1-8 6-12 11-12s10 4 11 12" fill="currentColor"/></svg>')}</span>Networking</li>
        <li><span class="stage__ico">${raw('<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 10h32v22H22l-9 7v-7H8z" fill="currentColor"/><text x="24" y="27" font-size="15" text-anchor="middle" fill="#000" font-family="Anton,sans-serif">?</text></svg>')}</span>Q&amp;A sessions</li>
        <li><span class="stage__ico">${raw('<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="8" y="20" width="32" height="20" rx="2" fill="currentColor"/><rect x="6" y="14" width="36" height="8" rx="2" fill="currentColor"/><path d="M24 14v26" stroke="#000" stroke-width="3"/><path d="M24 14c-3-7-11-7-9-2 1 2 9 2 9 2s8 0 9-2c2-5-6-5-9 2z" fill="currentColor"/></svg>')}</span>Prizes &amp; giveaways</li>
      </ul>
      <p class="stage__foot">A welcoming room for adults, young adults, families, and kids &amp; teens 8+.</p>
    </div>
  </div>
</section>

<section class="prizes" id="prizes" aria-labelledby="prizes-title">
  <div class="wrap">
    <h2 class="sec-title" id="prizes-title">Prizes &amp; <span class="gold">giveaways</span></h2>
    <p class="sec-lede">Prize details are posted here as they’re confirmed. Anything not yet confirmed is labeled.</p>
    <div class="prizes__list">
      ${prizes.length ? prizes.map(ticketPrize) : ''}
      <article class="ticket ticket--soon" data-reveal><div class="ticket__main"><p class="ticket__status">Coming soon</p><h3 class="ticket__title">More prizes to be announced</h3><p>Check back — or RSVP and we’ll tell you when new prizes are added.</p></div><div class="ticket__stub"><span>More</span><strong>Soon</strong></div></article>
    </div>
  </div>
</section>

<section class="raffle" id="raffle" aria-labelledby="raffle-title">
  <div class="wrap">
    <h2 class="sec-title" id="raffle-title">Raffle <span class="gold">entries</span></h2>
    <p class="sec-lede">$1 per entry, sold in bundles of 5. Optional — admission is free either way. <a href="/rules/raffle">Read the raffle rules</a>.</p>
    <div class="raffle__grid">
      <form class="raffle__picker" data-raffle-form novalidate>
        <fieldset>
          <legend class="sr-only">Choose how many entries</legend>
          <div class="bundles">
            ${BUNDLES.map((n, i) => html`<label class="bundle">
              <input type="radio" name="bundle" value="${n}" ${i === 1 ? raw('checked') : ''}>
              <span class="bundle__tkt"><b>${n}</b><span>entries</span><em>$${n}</em></span>
            </label>`)}
            <label class="bundle bundle--custom">
              <input type="radio" name="bundle" value="custom">
              <span class="bundle__tkt"><b>#</b><span>custom</span><em>×5</em></span>
            </label>
          </div>
          <div class="custom-qty" data-custom hidden>
            <label for="custom-qty">Number of entries (multiples of 5)</label>
            <div class="stepper"><button type="button" data-step="-5" aria-label="5 fewer entries">−</button><input id="custom-qty" type="number" inputmode="numeric" min="5" step="5" max="${s.raffle.max_entries_per_purchase}" value="25"><button type="button" data-step="5" aria-label="5 more entries">+</button></div>
            <p class="field-error" data-qty-error role="alert"></p>
          </div>
        </fieldset>
        <div class="tally" aria-live="polite">
          <div class="tally__count"><b data-tally>10</b><span>entries</span></div>
          <div class="tally__price">Total <b data-total>$10.00</b></div>
        </div>
        ${gate.open
          ? attendee
            ? html`<p class="raffle__who">Buying as <strong>${attendee.first_name} ${attendee.last_name.charAt(0)}.</strong> · ${attendee.confirmation_no} <a href="/me/logout">Not you?</a></p>
              <label class="check"><input type="checkbox" name="age" required><span>I am at least ${s.raffle.min_age} years old${states.length ? html` and live in ${states.map((x) => US_STATES[x]).join(', ')}` : ''}.</span></label>
              <button class="btn btn--gold btn--lg btn--block" type="submit" data-checkout>Continue to secure checkout</button>
              <p class="tiny">Payments are processed by Stripe. Entries are added after your payment is confirmed. Sales close ${formatInZone(raffleClose, tz, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}.</p>`
            : html`<p class="raffle__who">RSVP first (it’s free) — then you can buy entries.</p>
              <a class="btn btn--gold btn--lg btn--block" href="#rsvp">RSVP to buy entries</a>
              <button class="link-btn" type="button" data-open-lookup>Already registered? Find my registration</button>`
          : html`<div class="raffle__closed" role="status"><strong>${gate.publicMessage}</strong>${!gate.reasons.includes('closed') ? html`<span>${attendee ? 'We’ll let you know when checkout opens.' : 'RSVP now and we’ll let you know.'} Checkout turns on once the raffle rules are finalized.</span>` : ''}</div>
            ${!attendee ? html`<button class="link-btn" type="button" data-open-lookup>Already registered? Find my registration</button>` : ''}`}
        <p class="form-error" data-raffle-error role="alert"></p>
      </form>
      <div class="refer" data-reveal>
        <h3 class="refer__title">Share it. Earn <span class="gold">+${bonus}</span>.</h3>
        <ol class="refer__steps">
          <li><b>You RSVP</b> and get your personal invite link.</li>
          <li><b>A friend RSVPs</b> through your link and buys raffle entries.</li>
          <li><b>Their payment is confirmed</b> — you get ${bonus} bonus entries. They keep every entry they bought.</li>
        </ol>
        <p class="tiny">One bonus per referred friend. Self-referrals and duplicate accounts don’t count. Bonuses can be reversed if the purchase is refunded. See the <a href="/rules/raffle">raffle rules</a>.</p>
      </div>
    </div>
    <dialog class="lookup" data-lookup>
      <form method="dialog" class="lookup__close"><button aria-label="Close">×</button></form>
      <h3>Find my registration</h3>
      <p>Enter the email you registered with and your confirmation number (it starts with KR-).</p>
      <form data-lookup-form novalidate>
        <label>Email <input name="email" type="email" autocomplete="email" required></label>
        <label>Confirmation number <input name="confirmation_no" autocomplete="off" placeholder="KR-XXXXXX" required></label>
        <p class="form-error" data-lookup-error role="alert"></p>
        <button class="btn btn--gold btn--block" type="submit">Find my registration</button>
      </form>
    </dialog>
  </div>
</section>

<section class="rsvp" id="rsvp" aria-labelledby="rsvp-title">
  <div class="wrap rsvp__wrap">
    <div class="rsvp__intro">
      <h2 class="sec-title" id="rsvp-title">Claim your <span class="gold">free</span> spot</h2>
      <p class="sec-lede">Takes about a minute. You’ll get a confirmation number, a calendar invite, and your own invite link.</p>
      ${referrer ? html`<p class="invited">${icon('check')} Invited by <strong>${referrer}</strong></p>` : ''}
      ${attendee ? html`<p class="invited">You’re already registered as ${attendee.first_name}. <a href="/me">Open your event page</a></p>` : ''}
    </div>
    ${rsvpState.open
      ? html`<form class="rsvp__form" data-rsvp-form novalidate>
      <input type="hidden" name="form_ts" value="${raw(sign(Date.now()))}">
      <div class="hp" aria-hidden="true"><label>Company <input name="company" tabindex="-1" autocomplete="off"></label></div>
      <fieldset class="grid2">
        <legend>About you</legend>
        ${field('first_name', 'First name', { autocomplete: 'given-name', required: true })}
        ${field('last_name', 'Last name', { autocomplete: 'family-name', required: true })}
        ${field('email', 'Email', { type: 'email', autocomplete: 'email', required: true, inputmode: 'email' })}
        ${field('phone', 'Mobile phone', { type: 'tel', autocomplete: 'tel-national', required: true, inputmode: 'tel', placeholder: '(410) 555-0123' })}
        <div class="field"><label for="f-state">State <i>required</i></label>
          <select id="f-state" name="state" required autocomplete="address-level1"><option value="">Choose…</option>${Object.entries(US_STATES).map(([k, v]) => html`<option value="${k}" ${k === 'MD' ? raw('selected') : ''}>${v}</option>`)}</select>
          <p class="field-error" data-error-for="state"></p></div>
        ${field('instagram', 'Instagram username', { placeholder: '@yourname', autocomplete: 'off' })}
      </fieldset>
      <fieldset class="grid2">
        <legend>Your visit <span>optional</span></legend>
        <div class="field"><label for="f-age">Age group</label><select id="f-age" name="age_group"><option value="">Prefer not to say</option>${Object.entries(AGE_GROUPS).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select><p class="field-error" data-error-for="age_group"></p></div>
        <div class="field"><label for="f-guests">Additional guests</label><select id="f-guests" name="guests_count">${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => html`<option value="${n}">${n === 0 ? 'Just me' : `+${n}`}</option>`)}</select><p class="field-error" data-error-for="guests_count"></p></div>
        <div class="field"><label for="f-heard">How did you hear about us?</label><select id="f-heard" name="heard_from"><option value="">Choose…</option>${Object.entries(HEARD_FROM).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></div>
        ${field('invited_by_text', 'Who invited you? (name or invite code)', { autocomplete: 'off' })}
      </fieldset>
      <fieldset>
        <legend>What do you want to learn? <span>optional</span></legend>
        <div class="pills">${Object.entries(INTERESTS).map(([k, v]) => html`<label class="pill"><input type="checkbox" name="interests" value="${k}"><span>${v}</span></label>`)}</div>
        ${field('interests_other', 'Anything else you’d like covered?', { autocomplete: 'off' })}
      </fieldset>
      <fieldset>
        <legend>Confirm</legend>
        <label class="check"><input type="checkbox" name="understands_in_person" required><span>I understand this is an <strong>in-person event in Maryland</strong>.</span></label>
        <p class="field-error" data-error-for="understands_in_person"></p>
        <label class="check"><input type="checkbox" name="privacy_agreed" required><span>I agree to the <a href="/privacy" target="_blank">privacy policy</a> and <a href="/rules/event" target="_blank">event rules</a>.</span></label>
        <p class="field-error" data-error-for="privacy_agreed"></p>
        <label class="check check--opt"><input type="checkbox" name="marketing_email_opt_in"><span>Email me about future events. <em>Optional.</em></span></label>
        <label class="check check--opt"><input type="checkbox" name="sms_opt_in"><span>Text me my confirmation and event reminders. Msg &amp; data rates may apply; reply STOP to opt out. <em>Optional.</em></span></label>
      </fieldset>
      ${turnstileSiteKey ? html`<div class="cf-turnstile" data-sitekey="${turnstileSiteKey}" data-theme="dark"></div>` : ''}
      <p class="form-error" data-form-error role="alert"></p>
      <button class="btn btn--gold btn--lg btn--block" type="submit" data-submit>Claim my free spot</button>
      <noscript><p class="form-error">Turn on JavaScript to register, or contact the organizers.</p></noscript>
    </form>`
      : html`<div class="rsvp__closed"><strong>${rsvpState.reason}</strong><p>Contact the organizers if you have questions.</p></div>`}
    <div class="confirm" data-confirm hidden tabindex="-1"></div>
  </div>
</section>

<section class="faq" id="faq" aria-labelledby="faq-title">
  <div class="wrap faq__wrap">
    <h2 class="sec-title" id="faq-title">Questions</h2>
    <div class="faq__list">
      ${faqs.map((f) => html`<details class="faq__item"><summary>${f.question}</summary><div class="faq__a">${richText(f.answer)}</div></details>`)}
    </div>
  </div>
</section>

<section class="finale" aria-labelledby="finale-title">
  <div class="wrap finale__inner" data-reveal>
    <p class="finale__date">${formatInZone(start, tz, { month: 'short', day: 'numeric' })}</p>
    <h2 class="finale__title" id="finale-title">Pull up. Bring a friend. Leave knowing more.</h2>
    ${showCount ? html`<p class="finale__count"><b data-countup="${rsvpCount}">${rsvpCount}</b> people have RSVPed</p>` : ''}
    <a class="btn btn--gold btn--lg" href="#rsvp">Claim your free spot</a>
  </div>
</section>
</main>
${siteFooter()}
${attendee ? '' : html`<a class="sticky-cta" href="#rsvp" data-sticky-cta>RSVP free — ${formatInZone(start, tz, { month: 'short', day: 'numeric' })}</a>`}
${bootData({
    start: start.getTime(),
    end: end.getTime(),
    serverNow: Date.now(),
    raffleOpen: gate.open,
    hasAttendee: Boolean(attendee),
    maxEntries: s.raffle.max_entries_per_purchase,
    bonus,
    shareText: `I’m going to this FREE live event in Maryland on ${formatInZone(start, tz, { month: 'long', day: 'numeric' })}! Trading education, credit education, food, games, prizes, live performances, and networking. RSVP here:`,
    baseUrl: config.baseUrl,
  })}`;

  return layout({
    title: `Free Live In-Person Session — Klee & Ruben | ${formatInZone(start, tz, { month: 'short', day: 'numeric' })}, Maryland`,
    body,
    path: '/',
    extraHead: turnstileSiteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : '',
  });
}

import { sign } from '../lib/security.mjs';

function field(name, label, { type = 'text', required = false, autocomplete, inputmode, placeholder } = {}) {
  return html`<div class="field">
    <label for="f-${name}">${label}${required ? html` <i>required</i>` : ''}</label>
    <input id="f-${name}" name="${name}" type="${type}" ${required ? raw('required') : ''} ${autocomplete ? html`autocomplete="${autocomplete}"` : ''} ${inputmode ? html`inputmode="${inputmode}"` : ''} ${placeholder ? html`placeholder="${placeholder}"` : ''} aria-describedby="e-${name}">
    <p class="field-error" id="e-${name}" data-error-for="${name}"></p>
  </div>`;
}

export { asset };

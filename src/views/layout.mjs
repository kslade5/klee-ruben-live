import { html, raw, jsonForScript } from '../lib/html.mjs';
import { config } from '../config.mjs';
import { getSettings, eventTimes } from '../lib/settings.mjs';
import { venueText } from '../lib/calendar.mjs';

export const asset = (p) => `${p}?v=${config.assetVersion}`;

export function layout({ title, description, body, path = '/', bodyClass = '', noindex = false, extraHead = '', scripts = ['/js/site.js'] }) {
  const s = getSettings();
  const { start, end } = eventTimes(s);
  const desc = description || `Free live in-person session in Maryland hosted by ${s.event.hosts}. Trading, crypto and credit education, free food, games, prizes and live performances. RSVP free.`;
  const canonical = `${config.baseUrl}${path}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: `${s.event.name} — Hosted by ${s.event.hosts}`,
    description: desc,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: { '@type': 'Place', name: s.event.venue_name || 'Venue to be announced', address: { '@type': 'PostalAddress', streetAddress: s.event.venue_address || undefined, addressRegion: 'MD', addressCountry: 'US' } },
    image: [`${config.baseUrl}/img/og.jpg`],
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', availability: 'https://schema.org/InStock', url: config.baseUrl },
    organizer: { '@type': 'Organization', name: `${s.event.hosts} Live`, url: config.baseUrl },
  };
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${desc}">
${noindex ? raw('<meta name="robots" content="noindex, nofollow">') : html`<link rel="canonical" href="${canonical}">`}
<meta name="theme-color" content="#000000">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${config.baseUrl}/img/og.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${config.baseUrl}/img/og.jpg">
<link rel="icon" href="/img/icon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/Anton-Regular.woff" as="font" type="font/woff" crossorigin>
<link rel="preload" href="/fonts/BarlowCondensed-Bold.woff" as="font" type="font/woff" crossorigin>
<link rel="stylesheet" href="${asset('/css/site.css')}">
<script src="${asset('/js/early.js')}"></script>
${path === '/' ? html`<script type="application/ld+json">${jsonForScript(jsonLd)}</script>` : ''}
${config.plausibleDomain ? html`<script defer data-domain="${config.plausibleDomain}" src="https://plausible.io/js/script.js"></script>` : ''}
${raw(extraHead)}
</head>
<body class="${bodyClass}">
<a class="skip" href="#main">Skip to content</a>
${body}
${scripts.map((src) => html`<script src="${asset(src)}" defer></script>`)}
</body>
</html>`;
}

export function siteFooter() {
  const s = getSettings();
  const c = s.contact;
  const ig = c.instagram_handle.replace(/^@/, '');
  const socials = [
    ig && { href: c.instagram_url || `https://instagram.com/${ig}`, label: `Instagram @${ig}`, icon: 'instagram' },
    c.facebook_url && { href: c.facebook_url, label: 'Facebook', icon: 'facebook' },
    c.tiktok_url && { href: c.tiktok_url, label: 'TikTok', icon: 'tiktok' },
    c.whatsapp_url && { href: c.whatsapp_url, label: 'WhatsApp', icon: 'whatsapp' },
  ].filter(Boolean);
  const hasContact = c.email || c.phone || socials.length;
  return html`<footer class="footer" id="contact">
  <div class="wrap footer__grid">
    <div>
      <p class="footer__brand">Klee <span aria-hidden="true">&amp;</span><span class="sr-only">and</span> Ruben <em>Live</em></p>
      <p class="footer__muted">${venueText(s)}</p>
    </div>
    <div>
      <h2 class="footer__h">Contact the organizers</h2>
      ${hasContact
        ? html`<ul class="footer__list">
            ${c.phone ? html`<li><a href="tel:${c.phone.replace(/[^\d+]/g, '')}">${c.phone}</a></li>` : ''}
            ${c.email ? html`<li><a href="mailto:${c.email}">${c.email}</a></li>` : ''}
            ${socials.map((x) => html`<li><a href="${x.href}" rel="noopener" target="_blank">${icon(x.icon)}<span>${x.label}</span></a></li>`)}
          </ul>`
        : html`<p class="footer__muted">Phone, email and social links will be posted here soon.</p>`}
    </div>
    <div>
      <h2 class="footer__h">Fine print</h2>
      <ul class="footer__list">
        <li><a href="/rules/raffle">Raffle rules</a></li>
        <li><a href="/rules/event">Event rules</a></li>
        <li><a href="/privacy">Privacy policy</a></li>
        <li><a href="/terms">Terms</a></li>
        <li><a href="/refund-policy">Refund policy</a></li>
      </ul>
    </div>
  </div>
  <div class="wrap footer__legal">
    <p>All trading, crypto and credit sessions are general education — not financial, investment, legal or credit advice. Trading involves risk, including the loss of money. No specific income, return, credit score change or credit report outcome is promised. Admission is free; raffle entries are optional and subject to the published raffle rules.</p>
  </div>
</footer>`;
}

export function icon(name) {
  const paths = {
    instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor"/>',
    facebook: '<path d="M14 8h3V4h-3a4 4 0 0 0-4 4v3H7v4h3v6h4v-6h3l1-4h-4V8z"/>',
    tiktok: '<path d="M14 3v11.5a3.5 3.5 0 1 1-3.5-3.5"/><path d="M14 3c.5 2.5 2.5 4.5 5 4.6"/>',
    whatsapp: '<path d="M4 20l1.3-4A8 8 0 1 1 8.3 19z"/><path d="M9 9.5c.3 2 2.3 4.2 4.5 4.6l1-1.1 1.7.8-.4 1.6c-3.6.3-7.4-3.4-7.3-7l1.6-.5.8 1.7z"/>',
    sms: '<path d="M4 5h16v11H9l-5 4z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    pin: '<path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  };
  return raw(`<svg class="ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`);
}

export const bootData = (obj) => html`<script type="application/json" id="boot">${jsonForScript(obj)}</script>`;

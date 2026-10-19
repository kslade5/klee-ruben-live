// Organizer-editable settings with safe defaults. Values are stored as JSON in the settings table.
import { all, run, now } from '../db.mjs';
import { zonedToUtc } from './time.mjs';

const DRAFT = '**Draft — have this reviewed by your legal adviser before launch.**';

export const DEFAULTS = {
  event: {
    name: 'Free Live In-Person Session',
    hosts: 'Klee & Ruben',
    start_local: '2026-11-21T18:00',
    end_local: '2026-11-21T21:00',
    timezone: 'America/New_York',
    venue_name: '',
    venue_address: '',
    venue_directions_url: '',
    capacity: 0, // 0 = no cap
    rsvp_close_local: '', // empty = RSVPs close when the event starts
  },
  contact: {
    instagram_handle: '',
    instagram_url: '',
    phone: '',
    email: '',
    facebook_url: '',
    tiktok_url: '',
    whatsapp_url: '',
  },
  referral: {
    window_days: 30,
    bonus_entries: 2,
    repeat_purchase_rewards: false,
    reverse_on_full_refund: true,
  },
  raffle: {
    compliance_approved: false,
    compliance_approved_by: '',
    compliance_approved_at: '',
    compliance_notes: '',
    sales_enabled: false,
    sales_close_local: '2026-11-21T19:30',
    max_entries_per_purchase: 500,
    min_age: 18,
    eligible_states: '', // comma-separated USPS codes; empty = no state restriction configured
    drawing_info: 'Winners will be drawn at the event. The drawing method and time will be published here before sales open.',
    free_entry_method: '',
  },
  public: {
    show_rsvp_count: true,
    rsvp_count_min: 25,
  },
  notify: {
    reminder_hours: [168, 24, 2],
    referral_notifications: true,
  },
  pages: {
    raffle_rules: `${DRAFT}

## Who can enter
Raffle entries are available to registered attendees who are at least 18 years old. Eligibility may be limited by state; any restriction is listed on the checkout screen.

## How entries work
Entries are sold in bundles of 5 for $5 ($1 per entry). The minimum purchase is 5 entries. Entries are added to your account only after your payment is confirmed by our payment processor.

## Referral bonus entries
When someone RSVPs through your personal link and completes a qualifying raffle purchase, you receive 2 bonus entries. One bonus is awarded per referred person unless a repeat-purchase policy is published here. Self-referrals and duplicate accounts do not qualify. Bonus entries may be reversed if the qualifying purchase is refunded or charged back, or if the referral breaks these rules.

## Sales cutoff and drawing
Online sales close at the time shown on the raffle section. The drawing date, time and method are published before sales open.

## Winners
Winners are contacted using the email or phone number on their registration. Prize descriptions and restrictions are listed with each prize.

## Refunds
See the refund policy.

## Free entry
If a free method of entry is required, it will be described here.

Admission to the event is free. You do not need to buy raffle entries to attend.`,
    event_rules: `${DRAFT}

## Admission
Admission is free with an RSVP. Kids and teens ages 8+ are welcome with a parent or guardian.

## Conduct
Be respectful. Organizers may refuse entry or remove anyone who puts others at risk.

## Educational content
Trading, crypto and credit sessions are general education only — not financial, investment, legal or credit advice. Trading involves risk, including loss of money. No specific income, return, credit score change or report outcome is promised.

## Photos and video
The event may be photographed or filmed for promotional use.`,
    privacy: `${DRAFT}

## What we collect
Your name, email, phone, state, and the optional details you choose to share (Instagram, age group, guests, interests, how you heard about us).

## How we use it
To manage your RSVP, send event confirmations, reminders and updates, run the referral and raffle programs, and contact winners. Marketing emails and text messages are sent only if you opt in, and you can unsubscribe at any time.

## Who sees it
Organizers only. We use service providers to deliver email (Resend), text messages (Twilio) and payments (Stripe). Card details are handled by Stripe and never stored by us. We do not sell your information.

## Retention
We keep registration and transaction records as long as needed to run the event, meet legal and accounting obligations, and resolve disputes.

## Your choices
Contact us to view, correct or delete your information.`,
    terms: `${DRAFT}

By registering you agree to the event rules and, if you buy raffle entries, the raffle rules. Event details may change; registered attendees will be notified of important updates. Educational content is not financial, investment, legal or credit advice.`,
    refund_policy: `${DRAFT}

Raffle entry purchases may be refunded before the sales cutoff by contacting the organizers. Refunded entries are removed from the drawing, and any referral bonus earned from that purchase may be reversed. If the raffle is cancelled, all purchases are refunded.`,
  },
};

let cache = null;
let loadedAt = 0;
const TTL_MS = 15000; // other server instances pick up setting changes within 15 seconds

// Call once per request (app.mjs does) before using getSettings().
export async function loadSettings(force = false) {
  if (cache && !force && Date.now() - loadedAt < TTL_MS) return cache;
  const rows = await all('SELECT key, value FROM settings');
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  const out = {};
  for (const [k, def] of Object.entries(DEFAULTS)) out[k] = { ...def, ...(stored[k] || {}) };
  cache = out;
  loadedAt = Date.now();
  return cache;
}

export function getSettings() {
  if (!cache) throw new Error('Settings not loaded');
  return cache;
}

export async function setSettingsGroup(group, patch, actor) {
  if (!(group in DEFAULTS)) throw new Error(`Unknown settings group ${group}`);
  await loadSettings(true);
  const current = cache[group];
  const next = { ...current, ...patch };
  await run(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    group, JSON.stringify(next), now(), actor);
  await loadSettings(true);
  return { before: current, after: next };
}

export function eventTimes(s = getSettings()) {
  const tz = s.event.timezone;
  const start = zonedToUtc(s.event.start_local, tz);
  const end = zonedToUtc(s.event.end_local, tz);
  const rsvpClose = s.event.rsvp_close_local ? zonedToUtc(s.event.rsvp_close_local, tz) : start;
  const raffleClose = s.raffle.sales_close_local ? zonedToUtc(s.raffle.sales_close_local, tz) : start;
  return { start, end, rsvpClose, raffleClose, tz };
}

# Klee & Ruben Live — event website

The complete website for the **Free Live In-Person Session** (Saturday, November 21, 2026, 6–9 PM Eastern, Maryland): an animated landing page, free RSVPs, personal invite links with referral rewards, raffle entry checkout through Stripe, and a private organizer dashboard.

---

## What's included

**Public site**
- Animated hero built from the flyer (chrome "FREE", gold-brushed "LIVE", neon "SESSION"), hosts photo, floating light particles, live countdown.
- Countdown to Nov 21, 2026 6:00 PM **Eastern** (time-zone and daylight-saving correct; corrects for wrong phone clocks), "live now" and "that's a wrap" states, Google Calendar link and `.ics` download.
- Experience section (animated trading chart, credit gauge, entertainment stage), prize "tickets", raffle bundle picker with live counter, referral explainer, RSVP form, editable FAQ, final call to action, contact footer.
- Sticky RSVP bar on phones, accessible forms, keyboard navigation, reduced-motion support, no horizontal scroll from 320px to 4K.
- SEO: title/description, Open Graph share image, `Event` structured data, sitemap, robots.

**RSVP & referrals**
- Server-validated RSVP saved to the database, confirmation number (`KR-XXXXXX`), personal invite link (`/?ref=SARAH7K2P`), private attendee page (`/me`), calendar buttons, confirmation email/SMS (when configured and consented).
- Duplicate prevention (including Gmail dot/plus aliases), "find my registration" with email + confirmation number, self-service updates.
- Referral capture from links (30-day attribution window, configurable), visit tracking, share buttons (WhatsApp, text, email, Facebook, native share sheet, copy link; Instagram/TikTok copy the message with honest instructions).
- Self-referral blocking, suspicious-activity flags (same network as referrer, burst from one network, disposable email, shared phone) — flagged rewards wait for admin review.

**Raffle**
- $1 per entry, bundles of 5 (5/10/15/20/50/custom), $5 minimum, server-enforced.
- Stripe Checkout (server-side sessions); entries are added **only** after Stripe confirms payment (signed webhook, or a server-to-server check on the success page). Idempotent: duplicate webhooks or retries never add entries twice.
- Referrer earns 2 bonus entries per qualifying referred purchase (first purchase per referred person unless you enable repeat rewards).
- Refunds, partial refunds and chargebacks reverse entries and bonuses automatically. Amount mismatches go to review.
- Append-only entry ledger: paid, bonus and free entries are separate and every row traces to a payment or reward. The database itself blocks edits/deletes to the ledger and audit log.
- **Checkout stays off until an owner records legal approval** in the dashboard *and* sales are switched on *and* Stripe is configured.

**Organizer dashboard** (`/admin`)
- Overview: RSVPs, headcount, entries sold, revenue, payments, refunds, referral visits/RSVPs/purchases, bonuses, RSVPs per day, topic interests, conversion funnel, campaign sources, launch checklist.
- RSVPs: search (name, email, phone, confirmation, invite code), filters, profile with referral source/referrals/purchases/ledger/history, audited edits, cancel/flag, free-entry recording, CSV export.
- Referrals: rewards (approve/deny/reverse with reason), relationships (mark valid/suspicious/invalid), blocked attempts.
- Who's sharing: private leaderboard sortable by RSVPs, purchasers, revenue or bonus entries, with date range.
- Raffle & payments: totals, automatic ledger-vs-payments reconciliation, transactions, CSV exports (transactions, drawing entries, full ledger).
- Prizes, FAQ, settings (event, venue, contact & social, referral rules, raffle rules, reminders, policy pages), messages (broadcast updates + delivery log), audit log, team (owner/admin/viewer roles; viewers see masked contact info and can't export).

---

## Why this stack

The brief suggested Next.js + Supabase. This build is **plain JavaScript with zero npm dependencies**, written as one standard web request handler:

- **Free hosting:** it runs on **Cloudflare Workers + D1** (Cloudflare's SQLite database) on the free plan: 100,000 requests a day, 5 GB of data, automatic backups (D1 Time Travel), no cold starts, and a free `*.workers.dev` address.
- **Same code on Node:** `server.mjs` runs the identical app on Node 22 with its built-in SQLite, for local development, tests, or any VPS/Render host.
- **Nothing to keep patched:** no `node_modules`, no framework upgrades before the event. Stripe, Resend and Twilio are called through their REST APIs.
- **Safe without transactions:** D1 has no interactive transactions, so every multi-step payment write is one atomic batch guarded by a claim token, with UNIQUE constraints as a second guard. A test fires duplicate webhooks in parallel to prove entries are only ever awarded once.

## Project structure

```
server.mjs                 Node entry point (local, tests, VPS)
src/config.mjs             environment settings
worker.mjs                 Cloudflare Workers entry point
src/app.mjs                the whole site as one fetch handler + first-run setup + scheduled job
src/db.mjs                 D1 access, atomic batches, migrations
src/d1-sqlite.mjs          D1-compatible wrapper over Node's built-in SQLite
src/migrations/            database schema (15+ tables, constraints, append-only triggers)
src/lib/
  rsvp.mjs                 registration, access links, referral attribution & abuse checks
  raffle.mjs               checkout, verified fulfillment, bonuses, refunds, disputes, gate
  stripe.mjs               Stripe REST client + webhook signature verification
  notify.mjs               email/SMS queue, templates, reminders, broadcasts
  admin-auth.mjs           admin sessions, roles, CSRF, lockout
  settings.mjs             organizer settings + default policy text
  validate.mjs, security.mjs, html.mjs (auto-escaping templates), calendar.mjs, audit.mjs, seed.mjs
src/routes/public.mjs      site, RSVP/raffle/referral APIs, webhook, receipts, policy pages
src/routes/admin.mjs       dashboard
src/views/                 page templates
public/                    CSS, JS, fonts (self-hosted), images
scripts/                   create-admin, migrate, backup
tests/run-scenarios.mjs    end-to-end tests (18 scenarios) with a local Stripe stand-in
tests/browser-check.py     real-browser check on phone/tablet/laptop/desktop
```

---

## Publish it free on Cloudflare

1. Push this folder to a GitHub repository (private is fine).
2. In the Cloudflare dashboard: **Workers & Pages → Create → Import a repository**, pick the repo, keep the defaults and **Deploy**. Cloudflare reads `wrangler.toml`, creates the D1 database automatically, and gives you `https://klee-ruben-live.<your-subdomain>.workers.dev`. Every push to GitHub redeploys.
3. Create your organizer login: open `https://<your-site>/admin/setup?code=<SETUP_CODE from wrangler.toml>`. The link stops working once the first account exists.
4. Add secrets under **Workers & Pages → klee-ruben-live → Settings → Variables and Secrets** (type: Secret):
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (webhook URL: `https://<your-site>/webhooks/stripe`)
   - `RESEND_API_KEY`, and `EMAIL_FROM` (e.g. `Klee & Ruben Live <hello@yourdomain.com>`)
   - optional: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`
   - optional: `BASE_URL` once you attach a custom domain (otherwise the site uses the address it's visited at)
5. Sign in at `/admin` and work through the **Launch checklist** on the overview page.

`APP_SECRET` is optional on Cloudflare: if it's missing, a random one is generated on first launch and kept in the database.

**Free-plan notes:** emails and texts are sent by a job that runs every minute, about 40 per minute. A broadcast to 600 people finishes in roughly 15 minutes, and the Messages page shows progress. Resend's free plan allows 100 emails a day / 3,000 a month; upgrade it for large blasts.

## Run it on your computer (or any Node host)

Requires **Node.js 22.13 or newer** (`node -v`).

```bash
cp .env.example .env          # set BASE_URL=http://localhost:3000
npm run admin:create -- --email you@example.com --name "Klee" --role owner
npm start                     # → http://localhost:3000   dashboard: /admin
```

Tests: `npm test` (18 end-to-end scenarios against the real app with a local stand-in for Stripe) and optionally `python3 tests/browser-check.py http://localhost:3000` with Playwright installed. `Dockerfile` and `render.yaml` remain for Node hosts that keep a persistent disk.

### Stripe
1. Stripe Dashboard → Developers → API keys: copy the **test** secret key into `STRIPE_SECRET_KEY`.
2. Developers → Webhooks → Add endpoint `https://<your-site>/webhooks/stripe` with the events listed in `.env.example`; copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Make a test purchase with card `4242 4242 4242 4242`, then refund it in Stripe and watch the dashboard update.
4. Switch to live keys only after compliance approval.

### Email (Resend) and SMS (Twilio)
Verify your domain in Resend, then set `RESEND_API_KEY` and `EMAIL_FROM`. For texts, set the three `TWILIO_*` values (U.S. numbers need A2P 10DLC registration). Until these are configured, messages are logged as "not configured" — never as sent — and the confirmation screen tells people to save their confirmation number.

## What only you can provide

| Item | Where |
|---|---|
| Domain (optional) | Cloudflare → your Worker → Settings → Domains & Routes |
| Venue name, address, directions | Dashboard → Settings → Event |
| Instagram handle, phone, email, Facebook/TikTok/WhatsApp | Dashboard → Settings → Contact & social |
| Stripe account + keys + webhook | Cloudflare → Variables and Secrets |
| Resend (and optional Twilio) | Cloudflare → Variables and Secrets |
| Flight prize details (airline, value, dates, restrictions) | Dashboard → Prizes → set to "Confirmed" only when verified |
| Raffle legal review, drawing method, eligible states, free-entry method | Dashboard → Settings → Raffle + Raffle compliance |
| Final privacy policy, terms, rules, refund policy | Dashboard → Settings → Policies (drafts included, marked for review) |

---

## Legal notes (please read)

- **Raffles:** Maryland regulates raffles county by county under the state Criminal Law code, generally limiting them to qualified organizations (such as nonprofits) operating under a county permit. A paid raffle run by individuals or a business may not be allowed. Have a Maryland attorney review the structure, prizes, referral bonus and eligibility before you record approval in the dashboard. The site will not take a single payment until you do.
- **Credit content:** the flyer's "get your credit fixed" wording and the "remove negative items" promise can create risk under federal and Maryland credit-services laws. The site presents credit content as education and never promises outcomes; consider keeping it that way in social posts too. The flyer's TransUnion logo and sample score were intentionally left off the site.
- **Trading content** is labeled as general education, not financial advice, throughout.
- **Kids & teens 8+:** raffle purchases require age 18+ (configurable).

---

## How the key rules work

- **Who gets a referral bonus?** The referrer, when the person who RSVPed through their link (within the attribution window) completes a Stripe-confirmed purchase. One bonus per referred person by default. Bonuses tied to flagged referrals wait for admin approval. A full refund or chargeback reverses the bonus.
- **Can an admin add paid entries by hand?** No. Paid entries only come from verified payments. Admins can record *free* entries (for an approved free-entry method) with a required reason; everything is in the audit log.
- **What can't the site track?** Whether someone actually posted to Instagram/TikTok or how many people saw it — no website can. The dashboard counts what's measurable: share-button taps, link visits, RSVPs and purchases.

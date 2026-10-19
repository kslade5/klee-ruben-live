// End-to-end scenario tests. Starts the real server against a throwaway database and a local
// stand-in for Stripe's API, then exercises the site over HTTP exactly like a browser would.
// Run: npm test
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { signPayload } from '../src/lib/stripe.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = 3200, STRIPE_PORT = 4242;
const BASE = `http://localhost:${PORT}`;
const WHSEC = 'whsec_test_' + crypto.randomBytes(8).toString('hex');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-test-'));
const DB = path.join(TMP, 'test.db');
const ADMIN_EMAIL = 'owner@example.com', ADMIN_PW = 'correct-horse-battery-staple';

// ---------------- Mock Stripe API (test only) ----------------
const sessions = new Map();
const stripeMock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (!String(req.headers.authorization).startsWith('Bearer sk_test_')) { res.writeHead(401); return res.end('{}'); }
    if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
      const p = new URLSearchParams(body);
      const id = `cs_test_${crypto.randomBytes(6).toString('hex')}`;
      const qty = Number(p.get('line_items[0][quantity]'));
      const unit = Number(p.get('line_items[0][price_data][unit_amount]'));
      const s = { id, object: 'checkout.session', url: `https://checkout.stripe.test/pay/${id}`, amount_total: qty * unit, currency: 'usd', payment_status: 'unpaid', status: 'open',
        metadata: { purchase_id: p.get('metadata[purchase_id]') }, payment_intent: null, client_reference_id: p.get('client_reference_id') };
      sessions.set(id, s);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(s));
    }
    const m = req.url.match(/^\/v1\/checkout\/sessions\/(.+)$/);
    if (req.method === 'GET' && m && sessions.has(m[1])) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(sessions.get(m[1]))); }
    res.writeHead(404); res.end('{}');
  });
});

// ---------------- Tiny cookie-aware client ----------------
class Client {
  constructor(ip) { this.jar = {}; this.ip = ip; }
  async req(method, p, { json, form, headers = {}, redirect = 'manual' } = {}) {
    const h = { 'X-Forwarded-For': this.ip, Cookie: Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '), ...headers };
    let body;
    if (json) { h['Content-Type'] = 'application/json'; h.Accept = 'application/json'; body = JSON.stringify(json); }
    if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; h.Origin ||= BASE; body = new URLSearchParams(form).toString(); }
    const r = await fetch(BASE + p, { method, headers: h, body, redirect });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (/Max-Age=0/.test(c)) delete this.jar[k]; else this.jar[k] = v;
    }
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { status: r.status, text, data, location: r.headers.get('location') };
  }
  get(p, o) { return this.req('GET', p, o); }
  post(p, o) { return this.req('POST', p, o); }
}

let ipN = 10;
const newClient = () => new Client(`203.0.113.${ipN++}`);

async function webhook(event) {
  const payload = JSON.stringify(event);
  const r = await fetch(`${BASE}/webhooks/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signPayload(payload, WHSEC) }, body: payload });
  return { status: r.status, data: await r.json() };
}
const evt = (type, object, id = `evt_${crypto.randomBytes(8).toString('hex')}`) => ({ id, type, data: { object } });
let testDb;
function sql(q) { testDb ||= new DatabaseSync(DB); return testDb.prepare(q).all().map((r) => ({ ...r })); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- Harness ----------------
const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([false, name, e.message]); console.log(`  ✗ ${name}\n      ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const eq = (a, b, msg) => assert(a === b, `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

let formTs;
async function rsvp(client, overrides = {}) {
  return client.post('/api/rsvp', { json: {
    form_ts: formTs, company: '', first_name: 'Test', last_name: 'Person', email: `t${crypto.randomBytes(4).toString('hex')}@example.com`,
    phone: `410${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`.replace(/^410[01]/, '4105'), state: 'MD',
    understands_in_person: true, privacy_agreed: true, interests: ['day_trading', 'credit_reports'], guests_count: '1', ...overrides,
  } });
}
const tokenOf = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];

async function main() {
  await new Promise((r) => stripeMock.listen(STRIPE_PORT, r));
  const env = { ...process.env, PORT: String(PORT), BASE_URL: BASE, DATABASE_PATH: DB, APP_SECRET: crypto.randomBytes(24).toString('hex'), DISABLE_WORKER: '1',
    STRIPE_SECRET_KEY: 'sk_test_mock', STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API_BASE: `http://localhost:${STRIPE_PORT}`, ENV_FILE: '/dev/null', TRUST_PROXY: '1' };
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-admin.mjs', '--email', ADMIN_EMAIL, '--name', 'Test Owner', '--role', 'owner'], { cwd: ROOT, env: { ...env, ADMIN_PASSWORD: ADMIN_PW }, stdio: 'pipe' });
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => (log += d)); server.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 50 && !log.includes('[server]'); i++) await sleep(100);

  try {
    const home = await newClient().get('/');
    formTs = home.text.match(/name="form_ts" value="([^"]+)"/)[1];
    await sleep(3100); // the form must be open for 3+ seconds (bot check)

    const admin = newClient();
    let csrf;
    const adminPost = (p, form) => admin.post(p, { form: { _csrf: csrf, ...form } });

    console.log('\nScenarios');
    let sarah, sarahCode, james;
    const sarahC = newClient(), jamesC = newClient();

    await scenario('1. A visitor RSVPs successfully', async () => {
      const r = await rsvp(sarahC, { first_name: 'Sarah', last_name: 'Lee', email: 'sarah@example.com', phone: '(410) 555-0101' });
      eq(r.status, 200, 'status'); assert(r.data.ok, 'ok flag');
      assert(/^KR-[A-Z0-9]{6}$/.test(r.data.confirmation), 'confirmation number format');
      assert(sarahC.jar.kr_att, 'private access cookie set');
      sarah = sql(`SELECT a.*, r.confirmation_no FROM attendees a JOIN rsvps r ON r.attendee_id = a.id WHERE email = 'sarah@example.com'`)[0];
      assert(sarah, 'saved in database');
      await sleep(150); // confirmation is queued right after the response
      eq(sql(`SELECT template, status FROM notifications WHERE attendee_id = ${sarah.id}`)[0]?.status, 'not_configured', 'confirmation email logged honestly as not configured');
      const me = await sarahC.get('/me');
      eq(me.status, 200, 'private page'); assert(me.text.includes(sarah.confirmation_no), 'private page shows confirmation');
    });

    await scenario('2. An invalid RSVP is rejected with useful errors', async () => {
      const r = await rsvp(newClient(), { first_name: '', email: 'not-an-email', phone: '123', understands_in_person: false });
      eq(r.status, 422, 'status');
      assert(r.data.errors.first_name && r.data.errors.email && r.data.errors.phone && r.data.errors.understands_in_person, 'field errors returned');
      const dup = await rsvp(newClient(), { email: 'S.arah+promo@Example.com'.replace('S.arah', 'sarah') });
      eq(dup.status, 409, 'duplicate email blocked'); eq(dup.data.code, 'duplicate', 'duplicate code');
      const bot = await newClient().post('/api/rsvp', { json: { form_ts: formTs, company: 'spam inc', first_name: 'B' } });
      eq(bot.status, 400, 'honeypot rejected');
    });

    await scenario('3. An attendee receives a unique referral link', async () => {
      sarahCode = sql(`SELECT code FROM referral_codes WHERE attendee_id = ${sarah.id}`)[0].code;
      assert(/^SARAH[A-Z0-9]{4}$/.test(sarahCode), `code format ${sarahCode}`);
      const me = await sarahC.get('/me');
      assert(me.text.includes(`${BASE}/?ref=${sarahCode}`), 'link shown on private page');
      const other = await rsvp(newClient(), { first_name: 'Sam' });
      assert(other.data.referralCode !== sarahCode, 'codes are unique');
    });

    await scenario('4. A referred visitor RSVPs successfully', async () => {
      const land = await jamesC.get(`/?ref=${sarahCode.toLowerCase()}`);
      eq(land.status, 200, 'landing'); eq(jamesC.jar.kr_ref, sarahCode, 'referral cookie captured');
      assert(land.text.includes('Invited by <strong>Sarah</strong>'), 'shows who invited them');
      eq(sql(`SELECT COUNT(*) n FROM referral_visits WHERE code = '${sarahCode}'`)[0].n, 1, 'visit recorded');
      const r = await rsvp(jamesC, { first_name: 'James', last_name: 'Ford', email: 'james@example.com', phone: '4105550202' });
      eq(r.status, 200, 'rsvp');
      james = sql(`SELECT * FROM attendees WHERE email = 'james@example.com'`)[0];
      const rel = sql(`SELECT * FROM referral_relationships WHERE referred_id = ${james.id}`)[0];
      eq(rel?.referrer_id, sarah.id, 'linked to Sarah'); eq(rel.status, 'valid', 'relationship valid');
    });

    await scenario('17. Raffle checkout stays disabled until legal approval is recorded', async () => {
      let r = await jamesC.post('/api/raffle/checkout', { json: { quantity: 10, age: true } });
      eq(r.status, 403, 'blocked before approval'); assert(/open soon/i.test(r.data.message), 'public message');
      // sign in as owner
      const lp = await admin.post('/admin/login', { form: { email: ADMIN_EMAIL, password: ADMIN_PW } });
      eq(lp.status, 303, 'login');
      csrf = tokenOf((await admin.get('/admin/settings')).text);
      // sales switch alone is not enough
      r = await adminPost('/admin/settings/raffle', { sales_enabled: 'on', sales_close_local: '2026-11-21T19:30', max_entries_per_purchase: '500', min_age: '18', eligible_states: '', drawing_info: 'At the event', free_entry_method: '' });
      eq(r.status, 303, 'settings saved');
      r = await jamesC.post('/api/raffle/checkout', { json: { quantity: 10, age: true } });
      eq(r.status, 403, 'still blocked without compliance approval');
      // a non-owner can't approve
      execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-admin.mjs', '--email', 'helper@example.com', '--role', 'admin'], { cwd: ROOT, env: { ...env, ADMIN_PASSWORD: 'another-long-password' }, stdio: 'pipe' });
      const helper = newClient();
      await helper.post('/admin/login', { form: { email: 'helper@example.com', password: 'another-long-password' } });
      const hc = tokenOf((await helper.get('/admin/settings')).text);
      r = await helper.post('/admin/compliance', { form: { _csrf: hc, action: 'approve', approver: 'Me', attest: 'on' } });
      eq(r.status, 403, 'admin role cannot approve compliance');
      r = await adminPost('/admin/compliance', { action: 'approve', approver: 'Example Law LLP', notes: 'Test approval', attest: 'on' });
      eq(r.status, 303, 'owner approval');
      r = await jamesC.post('/api/raffle/checkout', { json: { quantity: 10, age: true } });
      eq(r.status, 200, 'open after approval');
      sql(`SELECT 1`); // checkout created; left pending
    });

    await scenario('5. Buying fewer than 5 entries (or a non-multiple of 5) is rejected', async () => {
      for (const q of [0, 3, 4, 7, 12, 505]) {
        const r = await jamesC.post('/api/raffle/checkout', { json: { quantity: q, age: true } });
        eq(r.status, 400, `quantity ${q}`);
      }
      const noAge = await jamesC.post('/api/raffle/checkout', { json: { quantity: 5, age: false } });
      eq(noAge.status, 400, 'age confirmation required');
      const anon = await newClient().post('/api/raffle/checkout', { json: { quantity: 5, age: true } });
      eq(anon.status, 401, 'must be registered');
    });

    let jamesPurchase, jamesSession;
    await scenario('6. A visitor buys a valid bundle (entries only after verified payment)', async () => {
      const r = await jamesC.post('/api/raffle/checkout', { json: { quantity: 10, age: true } });
      eq(r.status, 200, 'checkout'); assert(r.data.url.startsWith('https://checkout.stripe.test/'), 'redirect to Stripe');
      jamesPurchase = sql(`SELECT * FROM raffle_purchases WHERE attendee_id = ${james.id} ORDER BY id DESC LIMIT 1`)[0];
      eq(jamesPurchase.status, 'pending', 'pending before payment'); eq(jamesPurchase.amount_cents, 1000, 'amount $10');
      eq(sql(`SELECT COUNT(*) n FROM raffle_ledger WHERE attendee_id = ${james.id}`)[0].n, 0, 'no entries yet');
      jamesSession = sessions.get(jamesPurchase.stripe_session_id);
      Object.assign(jamesSession, { payment_status: 'paid', status: 'complete', payment_intent: 'pi_james1' });
      const w = await webhook(evt('checkout.session.completed', jamesSession, 'evt_james_paid'));
      eq(w.status, 200, 'webhook'); eq(w.data.result, 'fulfilled', 'fulfilled');
      eq(sql(`SELECT SUM(entries) n FROM raffle_ledger WHERE attendee_id = ${james.id} AND kind = 'paid'`)[0].n, 10, '10 paid entries');
      const success = await jamesC.get(`/raffle/success?session_id=${jamesSession.id}`);
      eq(success.status, 303, 'success redirects to receipt');
      const receipt = await jamesC.get(success.location);
      assert(receipt.text.includes('10 entries confirmed') && receipt.text.includes(jamesPurchase.public_id), 'receipt shows confirmed entries');
    });

    await scenario('7. A failed or abandoned payment awards no entries', async () => {
      const c = newClient();
      await rsvp(c, { first_name: 'Fail' });
      const r = await c.post('/api/raffle/checkout', { json: { quantity: 20, age: true } });
      eq(r.status, 200, 'checkout');
      const p = sql(`SELECT * FROM raffle_purchases ORDER BY id DESC LIMIT 1`)[0];
      const s = sessions.get(p.stripe_session_id);
      // an unpaid "completed" session (async method still processing) must not award entries
      Object.assign(s, { status: 'complete', payment_status: 'unpaid' });
      eq((await webhook(evt('checkout.session.completed', s))).data.result, 'not_paid', 'unpaid completion ignored');
      eq((await webhook(evt('checkout.session.async_payment_failed', s))).data.result, 'failed', 'marked failed');
      eq(sql(`SELECT status FROM raffle_purchases WHERE id = ${p.id}`)[0].status, 'failed', 'status failed');
      eq(sql(`SELECT COUNT(*) n FROM raffle_ledger WHERE purchase_id = ${p.id}`)[0].n, 0, 'no ledger rows');
      // forged webhook without a valid signature is rejected
      const forged = await fetch(`${BASE}/webhooks/stripe`, { method: 'POST', headers: { 'Stripe-Signature': 't=1,v1=deadbeef' }, body: JSON.stringify(evt('checkout.session.completed', { ...s, payment_status: 'paid' })) });
      eq(forged.status, 400, 'bad signature rejected');
      // tampered amount goes to review, not to the ledger
      const r2 = await c.post('/api/raffle/checkout', { json: { quantity: 5, age: true } });
      const p2 = sql(`SELECT * FROM raffle_purchases ORDER BY id DESC LIMIT 1`)[0];
      const s2 = sessions.get(p2.stripe_session_id);
      Object.assign(s2, { status: 'complete', payment_status: 'paid', amount_total: 100, payment_intent: 'pi_tampered' });
      eq((await webhook(evt('checkout.session.completed', s2))).data.result, 'amount_mismatch', 'mismatch detected');
      eq(sql(`SELECT COUNT(*) n FROM raffle_ledger WHERE purchase_id = ${p2.id}`)[0].n, 0, 'no entries for mismatched amount');
      assert(r2.status === 200, 'checkout ok');
    });

    await scenario('8. A verified referred purchase gives the referrer exactly 2 bonus entries', async () => {
      const bonus = sql(`SELECT * FROM raffle_ledger WHERE attendee_id = ${sarah.id} AND kind = 'referral_bonus'`);
      eq(bonus.length, 1, 'one bonus row'); eq(bonus[0].entries, 2, '2 entries');
      const reward = sql(`SELECT * FROM referral_rewards WHERE purchase_id = ${jamesPurchase.id}`)[0];
      eq(reward.status, 'awarded', 'reward awarded'); eq(bonus[0].reward_id, reward.id, 'traceable to the reward'); eq(bonus[0].purchase_id, jamesPurchase.id, 'traceable to the transaction');
      eq(sql(`SELECT SUM(entries) n FROM raffle_ledger WHERE attendee_id = ${james.id}`)[0].n, 10, 'James keeps his 10 entries');
      // a repeat purchase by James does not earn Sarah another bonus (repeat policy off)
      const r = await jamesC.post('/api/raffle/checkout', { json: { quantity: 5, age: true } });
      eq(r.status, 200, 'second checkout');
      const p = sql(`SELECT * FROM raffle_purchases WHERE attendee_id = ${james.id} ORDER BY id DESC LIMIT 1`)[0];
      Object.assign(sessions.get(p.stripe_session_id), { payment_status: 'paid', status: 'complete', payment_intent: 'pi_james2' });
      await webhook(evt('checkout.session.completed', sessions.get(p.stripe_session_id)));
      eq(sql(`SELECT SUM(entries) n FROM raffle_ledger WHERE attendee_id = ${sarah.id} AND kind = 'referral_bonus'`)[0].n, 2, 'still 2 bonus entries after repeat purchase');
      const me = await sarahC.get('/me');
      assert(/\+2 earned/.test(me.text), 'Sarah sees the earned bonus');
    });

    await scenario('9. Duplicate webhooks never duplicate entries', async () => {
      const before = sql(`SELECT SUM(entries) n FROM raffle_ledger`)[0].n;
      eq((await webhook(evt('checkout.session.completed', jamesSession, 'evt_james_paid'))).data.result, 'duplicate_event', 'same event id');
      eq((await webhook(evt('checkout.session.completed', jamesSession))).data.result, 'already_fulfilled', 'new event id, same payment');
      await jamesC.get(`/raffle/success?session_id=${jamesSession.id}`); // success-page verification is idempotent too
      eq(sql(`SELECT SUM(entries) n FROM raffle_ledger`)[0].n, before, 'ledger unchanged');
      let blocked = false;
      try { sql('DELETE FROM raffle_ledger WHERE id = 1 RETURNING id'); } catch { blocked = true; }
      assert(blocked, 'ledger is append-only (delete blocked by trigger)');
    });

    await scenario('10. A self-referral earns nothing', async () => {
      const c = newClient();
      await c.get(`/?ref=${sarahCode}`);
      const r = await rsvp(c, { first_name: 'Sarah', last_name: 'Alt', email: 'sarah.other.address@example.com', phone: '410-555-0101' }); // Sarah's own phone
      eq(r.status, 200, 'registration itself is allowed');
      const alt = sql(`SELECT id FROM attendees WHERE email = 'sarah.other.address@example.com'`)[0];
      eq(sql(`SELECT COUNT(*) n FROM referral_relationships WHERE referred_id = ${alt.id}`)[0].n, 0, 'no referral relationship');
      eq(sql(`SELECT COUNT(*) n FROM audit_log WHERE action = 'referral.self_referral_blocked'`)[0].n, 1, 'blocked attempt logged');
      // same-network referrals are flagged; their rewards wait for admin review
      const sameNet = new Client(sarahC.ip);
      await sameNet.get(`/?ref=${sarahCode}`);
      await rsvp(sameNet, { first_name: 'Neighbor', email: 'neighbor@example.com' });
      const nb = sql(`SELECT * FROM attendees WHERE email = 'neighbor@example.com'`)[0];
      const rel = sql(`SELECT * FROM referral_relationships WHERE referred_id = ${nb.id}`)[0];
      eq(rel.status, 'suspicious', 'flagged'); assert(rel.flags.includes('same_network_as_referrer'), 'flag reason');
      await sameNet.post('/api/raffle/checkout', { json: { quantity: 5, age: true } });
      const p = sql(`SELECT * FROM raffle_purchases WHERE attendee_id = ${nb.id}`)[0];
      Object.assign(sessions.get(p.stripe_session_id), { payment_status: 'paid', status: 'complete', payment_intent: 'pi_neighbor' });
      await webhook(evt('checkout.session.completed', sessions.get(p.stripe_session_id)));
      const rw = sql(`SELECT * FROM referral_rewards WHERE purchase_id = ${p.id}`)[0];
      eq(rw.status, 'pending_review', 'reward held for review');
      eq(sql(`SELECT SUM(entries) n FROM raffle_ledger WHERE attendee_id = ${sarah.id} AND kind = 'referral_bonus'`)[0].n, 2, 'no bonus until approved');
      const ap = await adminPost(`/admin/referrals/reward/${rw.id}`, { action: 'approve', note: 'Verified: roommate' });
      eq(ap.status, 303, 'admin approves');
      eq(sql(`SELECT SUM(entries) n FROM raffle_ledger WHERE attendee_id = ${sarah.id} AND kind = 'referral_bonus'`)[0].n, 4, 'bonus added after approval');
    });

    await scenario('11. A refund is recorded and reverses entries and the referral bonus', async () => {
      const w = await webhook(evt('charge.refunded', { id: 'ch_1', object: 'charge', payment_intent: 'pi_james1', amount: 1000, amount_refunded: 1000 }));
      eq(w.data.result, 'refunded', 'refund processed');
      eq(sql(`SELECT status FROM raffle_purchases WHERE id = ${jamesPurchase.id}`)[0].status, 'refunded', 'status refunded');
      eq(sql(`SELECT SUM(entries) n FROM raffle_ledger WHERE purchase_id = ${jamesPurchase.id} AND kind IN ('paid','paid_reversal')`)[0].n, 0, 'paid entries reversed');
      eq(sql(`SELECT status FROM referral_rewards WHERE purchase_id = ${jamesPurchase.id}`)[0].status, 'reversed', 'bonus reversed');
      eq(sql(`SELECT SUM(entries) n FROM raffle_ledger WHERE attendee_id = ${sarah.id} AND kind LIKE 'referral_bonus%'`)[0].n, 2, 'Sarah keeps only the approved bonus');
      eq((await webhook(evt('charge.refunded', { id: 'ch_1', object: 'charge', payment_intent: 'pi_james1', amount: 1000, amount_refunded: 1000 }))).data.result, 'no_change', 'repeat refund event is a no-op');
      // partial refund + dispute paths
      eq((await webhook(evt('charge.refunded', { id: 'ch_2', payment_intent: 'pi_james2', amount: 500, amount_refunded: 200 }))).data.result, 'partially_refunded', 'partial refund');
      eq(sql(`SELECT SUM(entries) n FROM raffle_ledger WHERE purchase_id = (SELECT id FROM raffle_purchases WHERE stripe_payment_intent = 'pi_james2')`)[0].n, 3, '2 of 5 entries removed');
      eq((await webhook(evt('charge.dispute.created', { id: 'dp_1', payment_intent: 'pi_james2', reason: 'fraudulent' }))).data.result, 'disputed', 'dispute holds entries');
      eq(sql(`SELECT SUM(entries) n FROM raffle_ledger WHERE purchase_id = (SELECT id FROM raffle_purchases WHERE stripe_payment_intent = 'pi_james2')`)[0].n, 0, 'disputed entries on hold');
      eq((await webhook(evt('charge.dispute.closed', { id: 'dp_1', payment_intent: 'pi_james2', status: 'won' }))).data.result, 'reinstated', 'dispute won');
      eq(sql(`SELECT SUM(entries) n FROM raffle_ledger WHERE purchase_id = (SELECT id FROM raffle_purchases WHERE stripe_payment_intent = 'pi_james2')`)[0].n, 3, 'entries reinstated');
    });

    await scenario('Extra: simultaneous duplicate webhooks award entries exactly once', async () => {
      const c = newClient();
      await c.get(`/?ref=${sarahCode}`);
      await rsvp(c, { first_name: 'Racer', email: 'racer@example.com' });
      await c.post('/api/raffle/checkout', { json: { quantity: 15, age: true } });
      const racer = sql(`SELECT id FROM attendees WHERE email = 'racer@example.com'`)[0];
      const p = sql(`SELECT * FROM raffle_purchases WHERE attendee_id = ${racer.id}`)[0];
      const s = sessions.get(p.stripe_session_id);
      Object.assign(s, { payment_status: 'paid', status: 'complete', payment_intent: 'pi_racer' });
      const bonusBefore = sql(`SELECT COALESCE(SUM(entries),0) n FROM raffle_ledger WHERE attendee_id = ${sarah.id} AND kind = 'referral_bonus'`)[0].n;
      const results = await Promise.all([...Array(6)].map(() => webhook(evt('checkout.session.completed', s))).concat([c.get(`/raffle/success?session_id=${s.id}`)]));
      eq(results.filter((r) => r.data?.result === 'fulfilled').length, 1, 'exactly one delivery fulfilled');
      eq(sql(`SELECT SUM(entries) n FROM raffle_ledger WHERE purchase_id = ${p.id} AND kind = 'paid'`)[0].n, 15, '15 paid entries, once');
      eq(sql(`SELECT COALESCE(SUM(entries),0) n FROM raffle_ledger WHERE attendee_id = ${sarah.id} AND kind = 'referral_bonus'`)[0].n, bonusBefore + 2, 'one bonus of 2');
    });

    await scenario('12. An unauthorized visitor cannot reach the admin dashboard', async () => {
      const anon = newClient();
      for (const p of ['/admin', '/admin/rsvps', '/admin/rsvps.csv', '/admin/raffle/entries.csv', `/admin/rsvps/${sarah.id}`]) {
        const r = await anon.get(p);
        eq(r.status, 303, `${p} redirects`); eq(r.location, '/admin/login', `${p} to login`);
      }
      const bad = await anon.post('/admin/login', { form: { email: ADMIN_EMAIL, password: 'wrong-password-123' } });
      eq(bad.status, 401, 'wrong password');
      const noCsrf = await admin.post(`/admin/rsvps/${sarah.id}`, { form: { action: 'flag', note: 'x' } });
      eq(noCsrf.status, 403, 'POST without CSRF token blocked');
      const crossSite = await admin.req('POST', `/admin/rsvps/${sarah.id}`, { form: { _csrf: csrf, action: 'flag', note: 'x' }, headers: { Origin: 'https://evil.example' } });
      eq(crossSite.status, 403, 'cross-origin POST blocked');
      execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-admin.mjs', '--email', 'viewer@example.com', '--role', 'viewer'], { cwd: ROOT, env: { ...env, ADMIN_PASSWORD: 'viewer-long-password' }, stdio: 'pipe' });
      const viewer = newClient();
      await viewer.post('/admin/login', { form: { email: 'viewer@example.com', password: 'viewer-long-password' } });
      const vl = await viewer.get('/admin/rsvps');
      eq(vl.status, 200, 'viewer can read'); assert(!vl.text.includes('sarah@example.com') && vl.text.includes('sa•••@example.com'), 'viewer sees masked emails');
      eq((await viewer.get('/admin/rsvps.csv')).status, 403, 'viewer cannot export');
    });

    await scenario('13. An admin can search RSVPs and see referral relationships', async () => {
      const r = await admin.get('/admin/rsvps?q=james');
      assert(r.text.includes('James Ford') && r.text.includes('Sarah Lee'), 'search finds James and shows Sarah as referrer');
      assert(!r.text.includes('Neighbor'), 'search filters others out');
      const byCode = await admin.get(`/admin/rsvps?q=${sarah.confirmation_no}`);
      assert(byCode.text.includes('Sarah Lee'), 'search by confirmation number');
      const profile = await admin.get(`/admin/rsvps/${sarah.id}`);
      assert(profile.text.includes('James Ford') && profile.text.includes('Neighbor'), 'profile lists people Sarah referred');
      const lb = await admin.get('/admin/leaderboard?sort=bonus');
      assert(lb.text.includes('Sarah Lee'), 'leaderboard lists Sarah');
      const csvR = await admin.get('/admin/rsvps.csv?ref=referred');
      assert(csvR.text.includes('james@example.com') && !csvR.text.includes('sarah@example.com'), 'CSV export respects filters');
      const edit = await adminPost(`/admin/rsvps/${james.id}`, { action: 'update', first_name: 'James', last_name: 'Ford', email: 'james@example.com', phone: '4105550202', state: 'VA', instagram: '', guests_count: '2', note: 'Called in update' });
      eq(edit.status, 303, 'edit saved');
      eq(sql(`SELECT COUNT(*) n FROM audit_log WHERE action = 'admin.rsvp_edited' AND entity_id = '${james.id}'`)[0].n, 1, 'edit is audited');
    });

    await scenario('14. Dashboard statistics come from real database records', async () => {
      const total = sql(`SELECT COUNT(*) n FROM rsvps`)[0].n;
      const html = (await admin.get('/admin')).text;
      assert(new RegExp(`RSVPs</span><b class="tile__value">${total}</b>`).test(html), `RSVP tile shows ${total}`);
      const paid = sql(`SELECT SUM(entries) n FROM raffle_ledger WHERE kind IN ('paid','paid_reversal','adjustment')`)[0].n;
      assert(new RegExp(`Raffle entries sold</span><b class="tile__value">${paid}</b>`).test(html), `entries tile shows ${paid}`);
      await rsvp(newClient(), { first_name: 'Late' });
      const after = (await admin.get('/admin')).text;
      assert(new RegExp(`RSVPs</span><b class="tile__value">${total + 1}</b>`).test(after), 'updates after a new RSVP');
      const raffle = (await admin.get('/admin/raffle')).text;
      assert(raffle.includes('reconcile with the entry ledger'), 'ledger reconciles with payments');
    });

    await scenario('16. The countdown targets Nov 21, 2026 6:00 PM Eastern (EST, UTC−5)', async () => {
      const boot = JSON.parse((await newClient().get('/')).text.match(/<script type="application\/json" id="boot">(.+?)<\/script>/)[1]);
      eq(new Date(boot.start).toISOString(), '2026-11-21T23:00:00.000Z', 'start instant');
      eq(new Date(boot.end).toISOString(), '2026-11-22T02:00:00.000Z', 'end instant');
      const ics = (await newClient().get('/event.ics')).text;
      assert(ics.includes('DTSTART:20261121T230000Z'), 'calendar invite start');
    });

    await scenario('Extra: private pages, SEO and security headers', async () => {
      eq((await newClient().get('/me')).status, 401, '/me requires a link');
      const r = await fetch(`${BASE}/`);
      assert(r.headers.get('content-security-policy')?.includes("default-src 'self'"), 'CSP header');
      eq(r.headers.get('x-frame-options'), 'DENY', 'clickjacking protection');
      const html = await r.text();
      assert(html.includes('"@type":"Event"') && html.includes('og:image'), 'structured data + Open Graph');
      assert((await (await fetch(`${BASE}/robots.txt`)).text()).includes('Disallow: /admin'), 'robots');
      eq((await fetch(`${BASE}/css/../../.env`)).status, 404, 'no path traversal');
    });
  } finally {
    server.kill();
    stripeMock.close();
  }
  const failed = results.filter((r) => !r[0]);
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed. (Scenario 15, mobile/desktop rendering, runs in tests/browser-check.py.)`);
  if (failed.length) { console.log('\nServer log tail:\n' + log.split('\n').slice(-25).join('\n')); process.exitCode = 1; }
  fs.rmSync(TMP, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });

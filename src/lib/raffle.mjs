// Raffle sales, verified fulfillment, referral bonuses, refunds and disputes.
// Entries only ever come from a payment Stripe has confirmed. Every change is an append-only
// ledger row written in the same atomic batch as the status "claim" that authorizes it:
//   UPDATE ... SET claim_token = <random> WHERE status = <expected>   -- only one writer can win this
//   INSERT ... SELECT ... WHERE EXISTS (row still carries this caller's claim token)
// UNIQUE indexes on the ledger and rewards are a second, independent guard against duplicates.
import { config, integrations } from '../config.mjs';
import { one, all, run, batch, now } from '../db.mjs';
import { getSettings, eventTimes } from './settings.mjs';
import { audit, auditStmt, track } from './audit.mjs';
import { HttpError } from './http.mjs';
import { validateQuantity, US_STATES } from './validate.mjs';
import { friendlyCode, randomToken } from './security.mjs';
import { stripe } from './stripe.mjs';
import { sendPurchaseConfirmation, sendReferralBonus } from './notify.mjs';
import { defer } from './background.mjs';

export const PRICE_PER_ENTRY_CENTS = 100;
export const BUNDLES = [5, 10, 15, 20, 50];

export function eligibleStates(s = getSettings()) {
  return String(s.raffle.eligible_states || '').split(',').map((x) => x.trim().toUpperCase()).filter((x) => US_STATES[x]);
}

// Site-wide gate. Every condition must be true before anyone can pay.
export function raffleGate() {
  const s = getSettings();
  const { raffleClose } = eventTimes(s);
  const reasons = [];
  if (!s.raffle.compliance_approved) reasons.push('compliance');
  if (!s.raffle.sales_enabled) reasons.push('disabled');
  if (!integrations.stripe()) reasons.push('payments_not_configured');
  if (Date.now() >= raffleClose.getTime()) reasons.push('closed');
  const publicMessage = reasons.includes('closed') ? 'Online raffle sales are closed.' : 'Raffle entry sales open soon.';
  return { open: reasons.length === 0, reasons, publicMessage, closesAt: raffleClose };
}

export async function startCheckout(att, { quantity, ageConfirmed }, ctx) {
  const s = getSettings();
  const gate = raffleGate();
  if (!gate.open) throw new HttpError(403, gate.publicMessage, { code: 'raffle_closed' });
  if (att.rsvp_status !== 'confirmed') throw new HttpError(403, 'Your registration is not active. Contact the organizers.');
  const qErr = validateQuantity(quantity, s.raffle.max_entries_per_purchase);
  if (qErr) throw new HttpError(400, qErr, { field: 'quantity' });
  if (!ageConfirmed) throw new HttpError(400, `Confirm you are at least ${s.raffle.min_age} years old to buy entries.`, { field: 'age' });
  const states = eligibleStates(s);
  if (states.length && !states.includes(att.state)) throw new HttpError(403, `Raffle entries are only available to residents of: ${states.map((x) => US_STATES[x]).join(', ')}.`);

  const qty = Number(quantity);
  const rel = await one('SELECT code FROM referral_relationships WHERE referred_id = ?', att.id);
  const publicId = `RP-${friendlyCode(10)}`;
  const t = now();
  await run(
    `INSERT INTO raffle_purchases (public_id, attendee_id, quantity, amount_cents, status, referral_code, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    publicId, att.id, qty, qty * PRICE_PER_ENTRY_CENTS, rel?.code || null, t, t,
  );

  let session;
  try {
    session = await stripe.createCheckoutSession(
      {
        mode: 'payment',
        client_reference_id: publicId,
        customer_email: att.email,
        success_url: `${config.baseUrl}/raffle/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${config.baseUrl}/raffle/cancelled?p=${publicId}`,
        line_items: { 0: { quantity: qty / 5, price_data: { currency: 'usd', unit_amount: 5 * PRICE_PER_ENTRY_CENTS, product_data: { name: 'Raffle entries — bundle of 5', description: `${s.event.name} raffle` } } } },
        metadata: { purchase_id: publicId, attendee_id: att.public_id, entries: qty },
        payment_intent_data: { metadata: { purchase_id: publicId }, description: `${qty} raffle entries (${publicId})` },
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      },
      `checkout-${publicId}`,
    );
  } catch (e) {
    await run(`UPDATE raffle_purchases SET status = 'failed', review_reason = ?, updated_at = ? WHERE public_id = ?`, `Checkout could not start: ${e.message}`.slice(0, 300), now(), publicId);
    throw new HttpError(502, 'Checkout is unavailable right now. Try again in a minute.');
  }
  await run('UPDATE raffle_purchases SET stripe_session_id = ?, updated_at = ? WHERE public_id = ?', session.id, now(), publicId);
  const p = await one('SELECT id FROM raffle_purchases WHERE public_id = ?', publicId);
  await audit({ actor: `attendee:${att.id}`, action: 'raffle.checkout_started', entityType: 'purchase', entityId: p.id, after: { qty, publicId }, ipHash: ctx.ipHash });
  await track('checkout_started', { visitorHash: ctx.visitorHash, refCode: rel?.code || null });
  return { url: session.url, purchaseId: publicId };
}

async function findPurchaseForSession(session) {
  if (typeof session?.id === 'string') {
    const p = await one('SELECT * FROM raffle_purchases WHERE stripe_session_id = ?', session.id);
    if (p) return p;
  }
  if (typeof session?.metadata?.purchase_id === 'string') return one('SELECT * FROM raffle_purchases WHERE public_id = ?', session.metadata.purchase_id);
  return undefined;
}

const DONE = ['paid', 'refunded', 'partially_refunded', 'disputed'];

async function fulfill(session, source) {
  const p = await findPurchaseForSession(session);
  if (!p) return 'unknown_purchase';
  if (DONE.includes(p.status)) return 'already_fulfilled';
  if (session.payment_status !== 'paid') return 'not_paid';
  const t = now();

  if (session.amount_total !== p.amount_cents || String(session.currency).toLowerCase() !== 'usd') {
    await batch([
      [`UPDATE raffle_purchases SET status = 'review', review_reason = ?, stripe_payment_intent = ?, updated_at = ? WHERE id = ? AND status IN ('pending','failed','expired')`,
        `Amount mismatch: Stripe ${session.amount_total} ${session.currency}, expected ${p.amount_cents} usd`, session.payment_intent || null, t, p.id],
      auditStmt({ actor: source, action: 'raffle.amount_mismatch', entityType: 'purchase', entityId: p.id, after: { stripe: session.amount_total, expected: p.amount_cents } }),
    ]);
    return 'amount_mismatch';
  }
  if (p.status === 'review') return 'under_review';

  // Referral eligibility (read-only checks before the atomic write).
  const s = getSettings();
  let reward = null;
  let skip = null;
  const rel = await one('SELECT * FROM referral_relationships WHERE referred_id = ?', p.attendee_id);
  let referrer = null;
  if (rel && rel.status !== 'invalid') {
    const windowEnds = new Date(new Date(rel.attributed_at).getTime() + s.referral.window_days * 86400_000);
    referrer = await one(`SELECT a.*, r.status AS rsvp_status FROM attendees a JOIN rsvps r ON r.attendee_id = a.id WHERE a.id = ?`, rel.referrer_id);
    const prior = (await one(`SELECT COUNT(*) AS n FROM referral_rewards WHERE referred_id = ? AND status IN ('awarded','pending_review')`, p.attendee_id)).n;
    if (new Date(t) > windowEnds) skip = 'outside_attribution_window';
    else if (referrer.rsvp_status !== 'confirmed') skip = 'referrer_cancelled';
    else if (prior > 0 && !s.referral.repeat_purchase_rewards) skip = 'repeat_purchase_not_eligible';
    else reward = { status: rel.status === 'suspicious' ? 'pending_review' : 'awarded', entries: s.referral.bonus_entries };
  }

  const claim = randomToken(12);
  const won = [`EXISTS (SELECT 1 FROM raffle_purchases WHERE id = ? AND claim_token = ?)`, p.id, claim];
  const stmts = [
    // 1. Claim: only one caller can move this purchase to "paid".
    [`UPDATE raffle_purchases SET status = 'paid', claim_token = ?, stripe_session_id = ?, stripe_payment_intent = ?, paid_at = ?, updated_at = ? WHERE id = ? AND status IN ('pending','failed','expired')`,
      claim, session.id, session.payment_intent || null, t, t, p.id],
    // 2. Paid entries, only if this caller's claim won.
    [`INSERT INTO raffle_ledger (attendee_id, kind, entries, purchase_id, note, created_by, created_at) SELECT ?, 'paid', ?, ?, ?, ?, ? WHERE ${won[0]}`,
      p.attendee_id, p.quantity, p.id, `Verified payment ${p.public_id}`, source, t, won[1], won[2]],
  ];
  if (reward) {
    stmts.push([
      `INSERT INTO referral_rewards (referrer_id, referred_id, relationship_id, purchase_id, entries, status, status_reason, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${won[0]}`,
      rel.referrer_id, p.attendee_id, rel.id, p.id, reward.entries, reward.status, reward.status === 'pending_review' ? `Flags: ${rel.flags}` : null, t, t, won[1], won[2],
    ]);
    if (reward.status === 'awarded') {
      stmts.push([
        `INSERT INTO raffle_ledger (attendee_id, kind, entries, purchase_id, reward_id, note, created_by, created_at)
         SELECT ?, 'referral_bonus', ?, ?, (SELECT id FROM referral_rewards WHERE purchase_id = ?), ?, 'system', ? WHERE ${won[0]}`,
        rel.referrer_id, reward.entries, p.id, p.id, `Referral bonus for ${p.public_id}`, t, won[1], won[2],
      ]);
    }
  }
  let res;
  try {
    res = await batch(stmts);
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return 'already_fulfilled';
    throw e;
  }
  if (!res[0].changes) return 'already_fulfilled';

  const auditRows = [auditStmt({ actor: source, action: 'raffle.payment_verified', entityType: 'purchase', entityId: p.id, after: { entries: p.quantity, amount_cents: p.amount_cents } })];
  if (skip) auditRows.push(auditStmt({ actor: 'system', action: 'referral.bonus_not_awarded', entityType: 'purchase', entityId: p.id, note: skip }));
  if (reward) auditRows.push(auditStmt({ actor: 'system', action: `referral.bonus_${reward.status}`, entityType: 'purchase', entityId: p.id, after: { referrer: rel.referrer_id, purchase: p.public_id, entries: reward.entries } }));
  await batch(auditRows);
  await track('checkout_completed', { refCode: p.referral_code });

  const buyer = await one('SELECT * FROM attendees WHERE id = ?', p.attendee_id);
  const paid = await one('SELECT * FROM raffle_purchases WHERE id = ?', p.id);
  defer(() => sendPurchaseConfirmation(buyer, paid));
  if (reward?.status === 'awarded') defer(() => sendReferralBonus(referrer, reward.entries, buyer.first_name));
  return 'fulfilled';
}

export async function approveReward(rewardId, actor, note) {
  const rw = await one('SELECT * FROM referral_rewards WHERE id = ?', rewardId);
  if (!rw || rw.status !== 'pending_review') throw new HttpError(409, 'Only rewards pending review can be approved.');
  const p = await one('SELECT status FROM raffle_purchases WHERE id = ?', rw.purchase_id);
  if (!['paid', 'partially_refunded'].includes(p.status)) throw new HttpError(409, 'The qualifying purchase is no longer paid.');
  const claim = randomToken(12);
  const res = await batch([
    [`UPDATE referral_rewards SET status = 'awarded', claim_token = ?, status_reason = ?, updated_at = ? WHERE id = ? AND status = 'pending_review'`, claim, note || 'Approved after review', now(), rw.id],
    [`INSERT INTO raffle_ledger (attendee_id, kind, entries, purchase_id, reward_id, note, created_by, created_at) SELECT ?, 'referral_bonus', ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM referral_rewards WHERE id = ? AND claim_token = ?)`,
      rw.referrer_id, rw.entries, rw.purchase_id, rw.id, `Approved: ${note || 'review passed'}`, actor, now(), rw.id, claim],
    auditStmt({ actor, action: 'referral.bonus_approved', entityType: 'referral_reward', entityId: rw.id, note }),
  ]);
  if (!res[0].changes) throw new HttpError(409, 'This reward was already handled.');
}

function reversalStmts(rw, actor, reason) {
  if (rw.status === 'awarded') {
    const claim = randomToken(12);
    return [
      [`UPDATE referral_rewards SET status = 'reversed', claim_token = ?, status_reason = ?, updated_at = ? WHERE id = ? AND status = 'awarded'`, claim, reason, now(), rw.id],
      [`INSERT INTO raffle_ledger (attendee_id, kind, entries, purchase_id, reward_id, note, created_by, created_at) SELECT ?, 'referral_bonus_reversal', ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM referral_rewards WHERE id = ? AND claim_token = ?)`,
        rw.referrer_id, -rw.entries, rw.purchase_id, rw.id, reason, actor, now(), rw.id, claim],
      auditStmt({ actor, action: 'referral.bonus_reversed', entityType: 'referral_reward', entityId: rw.id, before: { status: rw.status }, note: reason }),
    ];
  }
  if (rw.status === 'pending_review') {
    return [
      [`UPDATE referral_rewards SET status = 'denied', status_reason = ?, updated_at = ? WHERE id = ? AND status = 'pending_review'`, reason, now(), rw.id],
      auditStmt({ actor, action: 'referral.bonus_denied', entityType: 'referral_reward', entityId: rw.id, note: reason }),
    ];
  }
  return [];
}

export async function reverseReward(rewardId, actor, reason) {
  const rw = await one('SELECT * FROM referral_rewards WHERE id = ?', rewardId);
  if (!rw) throw new HttpError(404, 'Reward not found');
  const stmts = reversalStmts(rw, actor, reason);
  if (!stmts.length) throw new HttpError(409, `This reward is already ${rw.status}.`);
  const res = await batch(stmts);
  if (!res[0].changes) throw new HttpError(409, 'This reward was already handled.');
}

async function reverseRewardsForPurchase(purchaseId, reason) {
  for (const rw of await all(`SELECT * FROM referral_rewards WHERE purchase_id = ? AND status IN ('awarded','pending_review')`, purchaseId)) {
    await batch(reversalStmts(rw, 'system', reason));
  }
}

async function paidEntriesRemaining(p) {
  return (await one(`SELECT COALESCE(SUM(entries), 0) AS n FROM raffle_ledger WHERE purchase_id = ? AND kind IN ('paid','paid_reversal','adjustment')`, p.id)).n;
}

async function refund(charge) {
  const p = typeof charge.payment_intent === 'string' ? await one('SELECT * FROM raffle_purchases WHERE stripe_payment_intent = ?', charge.payment_intent) : null;
  if (!p) return 'unknown_purchase';
  const refunded = Math.min(Number(charge.amount_refunded) || 0, p.amount_cents);
  if (refunded <= p.amount_refunded_cents) return 'no_change';
  const full = refunded >= p.amount_cents;
  const targetRemaining = full ? 0 : p.quantity - Math.min(p.quantity, Math.ceil(refunded / PRICE_PER_ENTRY_CENTS));
  const remaining = await paidEntriesRemaining(p);
  const t = now();
  const claim = randomToken(12);
  const stmts = [
    // Claim this refund amount (optimistic lock on the previous refunded total).
    [`UPDATE raffle_purchases SET status = CASE WHEN status = 'disputed' THEN 'disputed' ELSE ? END, claim_token = ?, amount_refunded_cents = ?, updated_at = ? WHERE id = ? AND amount_refunded_cents = ?`,
      full ? 'refunded' : 'partially_refunded', claim, refunded, t, p.id, p.amount_refunded_cents],
  ];
  if (remaining > targetRemaining) {
    stmts.push([`INSERT INTO raffle_ledger (attendee_id, kind, entries, purchase_id, note, created_by, created_at) SELECT ?, 'paid_reversal', ?, ?, ?, 'stripe-webhook', ? WHERE EXISTS (SELECT 1 FROM raffle_purchases WHERE id = ? AND claim_token = ?)`,
      p.attendee_id, targetRemaining - remaining, p.id, `Refund of $${(refunded / 100).toFixed(2)}`, t, p.id, claim]);
  }
  stmts.push(auditStmt({ actor: 'stripe', action: full ? 'raffle.refunded' : 'raffle.partially_refunded', entityType: 'purchase', entityId: p.id, after: { refunded_cents: refunded } }));
  const res = await batch(stmts);
  if (!res[0].changes) return 'no_change';
  if (full && getSettings().referral.reverse_on_full_refund) await reverseRewardsForPurchase(p.id, 'Qualifying purchase was refunded');
  return full ? 'refunded' : 'partially_refunded';
}

async function dispute(d, closed) {
  const p = typeof d.payment_intent === 'string' ? await one('SELECT * FROM raffle_purchases WHERE stripe_payment_intent = ?', d.payment_intent) : null;
  if (!p) return 'unknown_purchase';
  const t = now();
  if (!closed) {
    if (p.status === 'disputed') return 'no_change';
    const remaining = await paidEntriesRemaining(p);
    const claim = randomToken(12);
    const res = await batch([
      [`UPDATE raffle_purchases SET status = 'disputed', claim_token = ?, updated_at = ? WHERE id = ? AND status <> 'disputed'`, claim, t, p.id],
      [`INSERT INTO raffle_ledger (attendee_id, kind, entries, purchase_id, note, created_by, created_at) SELECT ?, 'paid_reversal', ?, ?, 'Held: payment disputed', 'stripe-webhook', ? WHERE ? > 0 AND EXISTS (SELECT 1 FROM raffle_purchases WHERE id = ? AND claim_token = ?)`,
        p.attendee_id, -remaining, p.id, t, remaining, p.id, claim],
      auditStmt({ actor: 'stripe', action: 'raffle.disputed', entityType: 'purchase', entityId: p.id, note: d.reason }),
    ]);
    if (!res[0].changes) return 'no_change';
    await reverseRewardsForPurchase(p.id, 'Qualifying purchase was disputed');
    return 'disputed';
  }
  if (d.status === 'won' && p.status === 'disputed') {
    const restore = p.quantity - Math.ceil(p.amount_refunded_cents / PRICE_PER_ENTRY_CENTS) - (await paidEntriesRemaining(p));
    const claim = randomToken(12);
    const res = await batch([
      [`UPDATE raffle_purchases SET status = ?, claim_token = ?, updated_at = ? WHERE id = ? AND status = 'disputed'`, p.amount_refunded_cents > 0 ? 'partially_refunded' : 'paid', claim, t, p.id],
      [`INSERT INTO raffle_ledger (attendee_id, kind, entries, purchase_id, note, created_by, created_at) SELECT ?, 'adjustment', ?, ?, 'Dispute won: entries reinstated', 'stripe-webhook', ? WHERE ? > 0 AND EXISTS (SELECT 1 FROM raffle_purchases WHERE id = ? AND claim_token = ?)`,
        p.attendee_id, restore, p.id, t, restore, p.id, claim],
      auditStmt({ actor: 'stripe', action: 'raffle.dispute_won', entityType: 'purchase', entityId: p.id, note: 'Referral bonus stays reversed; an admin can review it.' }),
    ]);
    return res[0].changes ? 'reinstated' : 'no_change';
  }
  await audit({ actor: 'stripe', action: 'raffle.dispute_closed', entityType: 'purchase', entityId: p.id, note: d.status });
  return 'dispute_closed';
}

export async function handleStripeEvent(event) {
  if (typeof event?.id !== 'string' || typeof event?.type !== 'string') return 'malformed_event';
  // Claim the event id first: a duplicate delivery stops here.
  const claim = await run(`INSERT INTO payment_events (stripe_event_id, type, result, received_at) VALUES (?, ?, 'processing', ?) ON CONFLICT DO NOTHING`, event.id, event.type, now());
  if (!claim.changes) return 'duplicate_event';
  const obj = event.data?.object || {};
  let r = 'ignored';
  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        r = await fulfill(obj, 'stripe-webhook');
        break;
      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired': {
        const p = await findPurchaseForSession(obj);
        const status = event.type.endsWith('expired') ? 'expired' : 'failed';
        const u = p ? await run(`UPDATE raffle_purchases SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'`, status, now(), p.id) : { changes: 0 };
        r = u.changes ? status : 'no_change';
        break;
      }
      case 'charge.refunded': r = await refund(obj); break;
      case 'charge.dispute.created': r = await dispute(obj, false); break;
      case 'charge.dispute.closed': r = await dispute(obj, true); break;
    }
  } catch (e) {
    await run('DELETE FROM payment_events WHERE stripe_event_id = ?', event.id); // let Stripe retry
    throw e;
  }
  const purchase = typeof obj.metadata?.purchase_id === 'string' ? await one('SELECT id FROM raffle_purchases WHERE public_id = ?', obj.metadata.purchase_id) : null;
  await run('UPDATE payment_events SET result = ?, purchase_id = ? WHERE stripe_event_id = ?', r, purchase?.id || null, event.id);
  return r;
}

// Called from the success page: asks Stripe directly (server-to-server) and fulfills if paid. Idempotent with the webhook.
export async function verifySessionFromStripe(sessionId) {
  if (!integrations.stripe() || !/^cs_[A-Za-z0-9_]+$/.test(sessionId || '')) return null;
  const session = await stripe.retrieveCheckoutSession(sessionId);
  await fulfill(session, 'stripe-verify');
  return findPurchaseForSession(session);
}

export function raffleTotals() {
  return one(`SELECT
    COALESCE(SUM(CASE WHEN kind IN ('paid','paid_reversal') OR (kind='adjustment' AND purchase_id IS NOT NULL) THEN entries END),0) AS paid_entries,
    COALESCE(SUM(CASE WHEN kind IN ('referral_bonus','referral_bonus_reversal') THEN entries END),0) AS bonus_entries,
    COALESCE(SUM(CASE WHEN kind IN ('free_entry','free_entry_reversal') OR (kind='adjustment' AND purchase_id IS NULL) THEN entries END),0) AS free_entries
    FROM raffle_ledger`);
}

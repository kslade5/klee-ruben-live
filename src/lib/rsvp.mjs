// RSVP registration, attendee access links and referral attribution.
import { one, all, run, batch, now } from '../db.mjs';
import { randomToken, sha256, friendlyCode, uuid } from './security.mjs';
import { getSettings, eventTimes } from './settings.mjs';
import { auditStmt, trackStmt, audit } from './audit.mjs';
import { isDisposableEmail } from './validate.mjs';
import { HttpError } from './http.mjs';
import { sendRsvpConfirmation } from './notify.mjs';
import { defer } from './background.mjs';

const REF_CODE_RE = /^[A-Z0-9]{6,16}$/;
export const normalizeRefCode = (c) => {
  const s = String(c || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return REF_CODE_RE.test(s) ? s : null;
};

export async function findReferralCode(code) {
  const c = normalizeRefCode(code);
  if (!c) return null;
  return one(
    `SELECT rc.code, rc.attendee_id, a.first_name, a.email_norm, a.phone_norm, a.ip_hash, r.status AS rsvp_status
     FROM referral_codes rc JOIN attendees a ON a.id = rc.attendee_id JOIN rsvps r ON r.attendee_id = a.id
     WHERE rc.code = ? AND rc.active = 1`, c);
}

async function newReferralCode(firstName) {
  const stem = String(firstName).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8) || 'FRIEND';
  for (let i = 0; i < 20; i++) {
    const code = `${stem}${friendlyCode(4)}`;
    if (!(await one('SELECT 1 AS x FROM referral_codes WHERE code = ?', code))) return code;
  }
  throw new Error('Could not allocate a referral code');
}

async function newConfirmationNo() {
  for (let i = 0; i < 20; i++) {
    const c = `KR-${friendlyCode(6)}`;
    if (!(await one('SELECT 1 AS x FROM rsvps WHERE confirmation_no = ?', c))) return c;
  }
  throw new Error('Could not allocate a confirmation number');
}

const tokenStmt = (token, attendeeId) => ['INSERT INTO attendee_tokens (token_hash, attendee_id, created_at) VALUES (?, ?, ?)', sha256(token), attendeeId, now()];

export async function issueAccessToken(attendeeId) {
  const token = randomToken(24);
  await run(...tokenStmt(token, attendeeId));
  return token;
}

export async function attendeeFromToken(token) {
  if (!token || typeof token !== 'string' || token.length > 64) return null;
  return (await one(
    `SELECT a.*, r.id AS rsvp_id, r.confirmation_no, r.status AS rsvp_status, r.guests_count, r.interests, r.interests_other, r.heard_from, r.flagged
     FROM attendee_tokens t JOIN attendees a ON a.id = t.attendee_id JOIN rsvps r ON r.attendee_id = a.id
     WHERE t.token_hash = ? AND t.revoked_at IS NULL`, sha256(token))) || null;
}

const headcount = async () => (await one(`SELECT COALESCE(SUM(1 + guests_count), 0) AS n FROM rsvps WHERE status = 'confirmed'`)).n;

export async function rsvpOpenState() {
  const s = getSettings();
  const { rsvpClose } = eventTimes(s);
  if (Date.now() >= rsvpClose.getTime()) return { open: false, reason: 'RSVPs are closed.' };
  if (s.event.capacity > 0 && (await headcount()) >= s.event.capacity) return { open: false, reason: 'This event is at capacity.' };
  return { open: true };
}

export async function createRsvp(v, ctx) {
  const state = await rsvpOpenState();
  if (!state.open) throw new HttpError(409, state.reason, { code: 'closed' });
  const s = getSettings();
  if (s.event.capacity > 0) {
    const used = await headcount();
    if (used + 1 + v.guests_count > s.event.capacity) throw new HttpError(409, `Only ${Math.max(0, s.event.capacity - used)} spots are left. Reduce your guest count and try again.`, { code: 'capacity' });
  }
  if (await one('SELECT 1 AS x FROM attendees WHERE email_norm = ?', v.email_norm)) {
    throw new HttpError(409, 'This email is already registered.', { code: 'duplicate' });
  }

  const t = now();
  const publicId = uuid();
  const confirmationNo = await newConfirmationNo();
  const referralCode = await newReferralCode(v.first_name);
  const phoneDupes = (await one('SELECT COUNT(*) AS n FROM attendees WHERE phone_norm = ?', v.phone_norm)).n;

  // Referral attribution: an explicit code typed in the form wins over the link cookie.
  const typed = normalizeRefCode(v.invited_by_text);
  const ref = (typed && (await findReferralCode(typed))) || (await findReferralCode(ctx.refCookie));
  let relationship = null;
  let selfBlocked = false;
  if (ref) {
    if (ref.email_norm === v.email_norm || ref.phone_norm === v.phone_norm) selfBlocked = true;
    else {
      const flags = [];
      if (ref.ip_hash && ctx.ipHash && ref.ip_hash === ctx.ipHash) flags.push('same_network_as_referrer');
      if (isDisposableEmail(v.email)) flags.push('disposable_email');
      if (phoneDupes) flags.push('phone_matches_other_registration');
      const burst = (await one(
        `SELECT COUNT(*) AS n FROM referral_relationships rr JOIN attendees x ON x.id = rr.referred_id
         WHERE rr.referrer_id = ? AND x.ip_hash = ? AND rr.attributed_at > ?`,
        ref.attendee_id, ctx.ipHash, new Date(Date.now() - 86400_000).toISOString())).n;
      if (burst >= 2) flags.push('many_referrals_from_one_network');
      if (ref.rsvp_status !== 'confirmed') flags.push('referrer_registration_cancelled');
      const firstVisit = ctx.visitorHash
        ? (await one('SELECT MIN(created_at) AS t FROM referral_visits WHERE code = ? AND visitor_hash = ?', ref.code, ctx.visitorHash))?.t
        : null;
      relationship = { flags, firstVisit };
    }
  }

  const accessToken = randomToken(24);
  const A = `(SELECT id FROM attendees WHERE public_id = '${publicId}')`; // publicId is a UUID we generated
  const stmts = [
    [`INSERT INTO attendees (public_id, first_name, last_name, email, email_norm, phone, phone_norm, state, instagram, age_group, display_name,
       marketing_email_opt_in, sms_opt_in, unsubscribe_token, ip_hash, user_agent, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      publicId, v.first_name, v.last_name, v.email, v.email_norm, v.phone, v.phone_norm, v.state, v.instagram, v.age_group,
      v.display_name || `${v.first_name} ${v.last_name.charAt(0)}.`,
      v.marketing_email_opt_in, v.sms_opt_in, randomToken(18), ctx.ipHash, (ctx.userAgent || '').slice(0, 300), t, t],
    [`INSERT INTO rsvps (attendee_id, confirmation_no, guests_count, heard_from, invited_by_text, interests, interests_other,
       understands_in_person, privacy_agreed, flagged, flag_reason, utm_source, utm_medium, utm_campaign, created_at, updated_at)
      VALUES (${A}, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?)`,
      confirmationNo, v.guests_count, v.heard_from, v.invited_by_text, JSON.stringify(v.interests), v.interests_other,
      phoneDupes ? 1 : 0, phoneDupes ? 'Phone number matches another registration' : null,
      ctx.utm?.source || null, ctx.utm?.medium || null, ctx.utm?.campaign || null, t, t],
    [`INSERT INTO referral_codes (code, attendee_id, created_at) VALUES (?, ${A}, ?)`, referralCode, t],
    [`INSERT INTO attendee_tokens (token_hash, attendee_id, created_at) VALUES (?, ${A}, ?)`, sha256(accessToken), t],
  ];
  if (relationship) {
    stmts.push([`INSERT INTO referral_relationships (referrer_id, referred_id, code, first_visit_at, attributed_at, status, flags) VALUES (?, ${A}, ?, ?, ?, ?, ?)`,
      ref.attendee_id, ref.code, relationship.firstVisit, t, relationship.flags.length ? 'suspicious' : 'valid', JSON.stringify(relationship.flags)]);
  }
  stmts.push(trackStmt('rsvp_completed', { visitorHash: ctx.visitorHash, refCode: relationship ? ref.code : null, utm: ctx.utm }));

  try {
    await batch(stmts); // all-or-nothing
  } catch (e) {
    if (/UNIQUE/i.test(e.message) && /email_norm/i.test(e.message)) throw new HttpError(409, 'This email is already registered.', { code: 'duplicate' });
    throw e;
  }

  const attendee = await one('SELECT * FROM attendees WHERE public_id = ?', publicId);
  const rsvp = await one('SELECT * FROM rsvps WHERE attendee_id = ?', attendee.id);
  await batch([
    auditStmt({ actor: `attendee:${attendee.id}`, action: 'rsvp.created', entityType: 'rsvp', entityId: rsvp.id, after: { confirmationNo, referralFrom: relationship ? ref.code : null }, ipHash: ctx.ipHash }),
    ...(selfBlocked ? [auditStmt({ actor: 'system', action: 'referral.self_referral_blocked', entityType: 'attendee', entityId: attendee.id, note: `code ${ref.code}` })] : []),
  ]);
  defer(() => sendRsvpConfirmation(attendee, rsvp, { accessToken, referralCode }));
  return { attendee, rsvp, accessToken, referralCode, referredBy: relationship ? ref.first_name : null };
}

export async function updateAttendeeSelf(att, v, ipHash) {
  const before = await one('SELECT first_name, last_name, phone, state, instagram, age_group, display_name, leaderboard_opt_in, marketing_email_opt_in, sms_opt_in, reminders_opt_out FROM attendees WHERE id = ?', att.id);
  const beforeRsvp = await one('SELECT guests_count, interests, interests_other FROM rsvps WHERE attendee_id = ?', att.id);
  const s = getSettings();
  if (s.event.capacity > 0 && v.guests_count > beforeRsvp.guests_count) {
    if ((await headcount()) + (v.guests_count - beforeRsvp.guests_count) > s.event.capacity) throw new HttpError(409, 'Not enough spots left for more guests.');
  }
  await batch([
    [`UPDATE attendees SET first_name = ?, last_name = ?, phone = ?, phone_norm = ?, state = ?, instagram = ?, age_group = ?, display_name = ?,
       leaderboard_opt_in = ?, marketing_email_opt_in = ?, sms_opt_in = ?, reminders_opt_out = ?, updated_at = ? WHERE id = ?`,
      v.first_name, v.last_name, v.phone, v.phone_norm, v.state, v.instagram, v.age_group, v.display_name || before.display_name,
      v.leaderboard_opt_in, v.marketing_email_opt_in, v.sms_opt_in, v.reminders_opt_out, now(), att.id],
    [`UPDATE rsvps SET guests_count = ?, interests = ?, interests_other = ?, updated_at = ? WHERE attendee_id = ?`,
      v.guests_count, JSON.stringify(v.interests), v.interests_other, now(), att.id],
    auditStmt({ actor: `attendee:${att.id}`, action: 'attendee.self_update', entityType: 'attendee', entityId: att.id, before: { ...before, ...beforeRsvp }, after: v, ipHash }),
  ]);
}

export async function referralStats(attendeeId) {
  const code = (await one('SELECT code FROM referral_codes WHERE attendee_id = ?', attendeeId))?.code;
  const visits = code ? (await one('SELECT COUNT(*) AS n FROM referral_visits WHERE code = ?', code)).n : 0;
  const shares = (await one('SELECT COUNT(*) AS n FROM share_clicks WHERE attendee_id = ?', attendeeId)).n;
  const referred = await all(
    `SELECT rr.id, rr.status, rr.attributed_at, a.first_name, substr(a.last_name, 1, 1) AS last_initial, r.status AS rsvp_status,
       (SELECT rw.status FROM referral_rewards rw WHERE rw.relationship_id = rr.id ORDER BY rw.id LIMIT 1) AS reward_status,
       (SELECT COUNT(*) FROM raffle_purchases p WHERE p.attendee_id = rr.referred_id AND p.status IN ('paid','partially_refunded')) AS paid_purchases
     FROM referral_relationships rr JOIN attendees a ON a.id = rr.referred_id JOIN rsvps r ON r.attendee_id = a.id
     WHERE rr.referrer_id = ? ORDER BY rr.attributed_at DESC`, attendeeId);
  const bonus = (await one(`SELECT COALESCE(SUM(entries), 0) AS n FROM raffle_ledger WHERE attendee_id = ? AND kind IN ('referral_bonus','referral_bonus_reversal')`, attendeeId)).n;
  const qualifying = (await one(`SELECT COUNT(*) AS n FROM referral_rewards WHERE referrer_id = ? AND status = 'awarded'`, attendeeId)).n;
  const pendingReview = (await one(`SELECT COUNT(*) AS n FROM referral_rewards WHERE referrer_id = ? AND status = 'pending_review'`, attendeeId)).n;
  return { code, visits, shares, referred, rsvps: referred.length, bonus, qualifying, pendingReview };
}

export async function entryTotals(attendeeId) {
  const r = await one(
    `SELECT
       COALESCE(SUM(CASE WHEN kind IN ('paid','paid_reversal') OR (kind = 'adjustment' AND purchase_id IS NOT NULL) THEN entries END), 0) AS paid,
       COALESCE(SUM(CASE WHEN kind IN ('referral_bonus','referral_bonus_reversal') THEN entries END), 0) AS bonus,
       COALESCE(SUM(CASE WHEN kind IN ('free_entry','free_entry_reversal') OR (kind = 'adjustment' AND purchase_id IS NULL) THEN entries END), 0) AS free
     FROM raffle_ledger WHERE attendee_id = ?`, attendeeId);
  return { ...r, total: r.paid + r.bonus + r.free };
}

export { audit };

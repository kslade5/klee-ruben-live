import { run, now } from '../db.mjs';

export function auditStmt({ actor, action, entityType = null, entityId = null, before = null, after = null, note = null, ipHash = null }) {
  return [
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, before_json, after_json, note, ip_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    actor, action, entityType, entityId == null ? null : String(entityId),
    before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), note, ipHash, now(),
  ];
}
export const audit = (e) => run(...auditStmt(e));

const ANALYTICS_EVENTS = new Set(['page_view', 'rsvp_started', 'rsvp_completed', 'raffle_viewed', 'checkout_started', 'checkout_completed', 'share_clicked', 'referral_landing']);

// No personal data: only an event name, a salted visitor hash and campaign tags.
export function trackStmt(name, { visitorHash = null, refCode = null, utm = {} } = {}) {
  return [
    `INSERT INTO analytics_events (name, visitor_hash, ref_code, utm_source, utm_medium, utm_campaign, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    name, visitorHash, refCode, utm.source?.slice(0, 60) || null, utm.medium?.slice(0, 60) || null, utm.campaign?.slice(0, 80) || null, now(),
  ];
}
export async function track(name, opts) {
  if (!ANALYTICS_EVENTS.has(name)) return;
  await run(...trackStmt(name, opts));
}
export { ANALYTICS_EVENTS };

-- Klee & Ruben Live — initial schema (SQLite)
-- Money is stored in integer cents. Timestamps are ISO-8601 UTC strings.

CREATE TABLE admins (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','admin','viewer')),
  password_hash TEXT NOT NULL,
  disabled      INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  last_login_at TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE admin_sessions (
  token_hash  TEXT PRIMARY KEY,
  admin_id    INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_token  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  ip_hash     TEXT,
  user_agent  TEXT
);

-- A person who registered.
CREATE TABLE attendees (
  id                   INTEGER PRIMARY KEY,
  public_id            TEXT NOT NULL UNIQUE,
  first_name           TEXT NOT NULL,
  last_name            TEXT NOT NULL,
  email                TEXT NOT NULL,
  email_norm           TEXT NOT NULL UNIQUE,      -- lower-cased, gmail dots/plus removed: blocks duplicates & alias abuse
  phone                TEXT NOT NULL,
  phone_norm           TEXT NOT NULL,
  state                TEXT NOT NULL,
  instagram            TEXT,
  age_group            TEXT,
  display_name         TEXT,                      -- attendee-chosen name for any opt-in public leaderboard
  leaderboard_opt_in   INTEGER NOT NULL DEFAULT 0,
  marketing_email_opt_in INTEGER NOT NULL DEFAULT 0,
  sms_opt_in           INTEGER NOT NULL DEFAULT 0,
  reminders_opt_out    INTEGER NOT NULL DEFAULT 0,
  unsubscribe_token    TEXT NOT NULL UNIQUE,
  ip_hash              TEXT,
  user_agent           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX idx_attendees_phone ON attendees(phone_norm);

-- Private dashboard links (/me/<token>). Only a SHA-256 of each token is stored.
CREATE TABLE attendee_tokens (
  token_hash   TEXT PRIMARY KEY,
  attendee_id  INTEGER NOT NULL REFERENCES attendees(id),
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);

-- The registration for this event.
CREATE TABLE rsvps (
  id               INTEGER PRIMARY KEY,
  attendee_id      INTEGER NOT NULL UNIQUE REFERENCES attendees(id),
  confirmation_no  TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
  guests_count     INTEGER NOT NULL DEFAULT 0 CHECK (guests_count BETWEEN 0 AND 10),
  heard_from       TEXT,
  invited_by_text  TEXT,
  interests        TEXT NOT NULL DEFAULT '[]',    -- JSON array of topic keys
  interests_other  TEXT,
  understands_in_person INTEGER NOT NULL,
  privacy_agreed   INTEGER NOT NULL,
  flagged          INTEGER NOT NULL DEFAULT 0,
  flag_reason      TEXT,
  utm_source       TEXT,
  utm_medium       TEXT,
  utm_campaign     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_rsvps_created ON rsvps(created_at);

CREATE TABLE event_guests (
  id          INTEGER PRIMARY KEY,
  rsvp_id     INTEGER NOT NULL REFERENCES rsvps(id),
  name        TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE referral_codes (
  code         TEXT PRIMARY KEY,
  attendee_id  INTEGER NOT NULL UNIQUE REFERENCES attendees(id),
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);

CREATE TABLE referral_visits (
  id           INTEGER PRIMARY KEY,
  code         TEXT NOT NULL REFERENCES referral_codes(code),
  visitor_hash TEXT NOT NULL,
  day          TEXT NOT NULL,
  utm_source   TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (code, visitor_hash, day)
);

-- Tracked taps on share buttons. Real posts on social apps cannot be counted.
CREATE TABLE share_clicks (
  id           INTEGER PRIMARY KEY,
  attendee_id  INTEGER NOT NULL REFERENCES attendees(id),
  channel      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE referral_relationships (
  id              INTEGER PRIMARY KEY,
  referrer_id     INTEGER NOT NULL REFERENCES attendees(id),
  referred_id     INTEGER NOT NULL UNIQUE REFERENCES attendees(id),
  code            TEXT NOT NULL,
  first_visit_at  TEXT,
  attributed_at   TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('valid','suspicious','invalid')),
  flags           TEXT NOT NULL DEFAULT '[]',
  CHECK (referrer_id <> referred_id)
);
CREATE INDEX idx_refrel_referrer ON referral_relationships(referrer_id);

CREATE TABLE raffle_purchases (
  id                   INTEGER PRIMARY KEY,
  public_id            TEXT NOT NULL UNIQUE,
  attendee_id          INTEGER NOT NULL REFERENCES attendees(id),
  quantity             INTEGER NOT NULL CHECK (quantity >= 5 AND quantity % 5 = 0),
  amount_cents         INTEGER NOT NULL CHECK (amount_cents = quantity * 100),
  currency             TEXT NOT NULL DEFAULT 'usd',
  status               TEXT NOT NULL CHECK (status IN ('pending','paid','failed','expired','refunded','partially_refunded','disputed','review')),
  stripe_session_id    TEXT UNIQUE,
  stripe_payment_intent TEXT,
  amount_refunded_cents INTEGER NOT NULL DEFAULT 0,
  referral_code        TEXT,
  review_reason        TEXT,
  created_at           TEXT NOT NULL,
  paid_at              TEXT,
  updated_at           TEXT NOT NULL
);
CREATE INDEX idx_purchases_attendee ON raffle_purchases(attendee_id);
CREATE INDEX idx_purchases_pi ON raffle_purchases(stripe_payment_intent);

-- Every Stripe webhook event processed exactly once.
CREATE TABLE payment_events (
  stripe_event_id TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  purchase_id     INTEGER REFERENCES raffle_purchases(id),
  result          TEXT NOT NULL,
  received_at     TEXT NOT NULL
);

CREATE TABLE referral_rewards (
  id            INTEGER PRIMARY KEY,
  referrer_id   INTEGER NOT NULL REFERENCES attendees(id),
  referred_id   INTEGER NOT NULL REFERENCES attendees(id),
  relationship_id INTEGER NOT NULL REFERENCES referral_relationships(id),
  purchase_id   INTEGER NOT NULL UNIQUE REFERENCES raffle_purchases(id), -- one reward per qualifying transaction
  entries       INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('awarded','pending_review','reversed','denied')),
  status_reason TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Append-only ledger. Paid and promotional entries are separate kinds; corrections are new rows.
CREATE TABLE raffle_ledger (
  id           INTEGER PRIMARY KEY,
  attendee_id  INTEGER NOT NULL REFERENCES attendees(id),
  kind         TEXT NOT NULL CHECK (kind IN ('paid','paid_reversal','referral_bonus','referral_bonus_reversal','free_entry','free_entry_reversal','adjustment')),
  entries      INTEGER NOT NULL,
  purchase_id  INTEGER REFERENCES raffle_purchases(id),
  reward_id    INTEGER REFERENCES referral_rewards(id),
  note         TEXT,
  created_by   TEXT NOT NULL,          -- 'stripe-webhook', 'stripe-verify', 'admin:<id>', 'system'
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_ledger_attendee ON raffle_ledger(attendee_id);
CREATE UNIQUE INDEX uq_ledger_paid_once ON raffle_ledger(purchase_id) WHERE kind = 'paid';
CREATE UNIQUE INDEX uq_ledger_bonus_once ON raffle_ledger(reward_id) WHERE kind = 'referral_bonus';

CREATE TRIGGER ledger_no_update BEFORE UPDATE ON raffle_ledger
BEGIN SELECT RAISE(ABORT, 'raffle_ledger is append-only'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON raffle_ledger
BEGIN SELECT RAISE(ABORT, 'raffle_ledger is append-only'); END;

CREATE TABLE prizes (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  image_url     TEXT,
  eligibility   TEXT,
  restrictions  TEXT,
  sponsor       TEXT,
  confirmation  TEXT NOT NULL DEFAULT 'pending' CHECK (confirmation IN ('pending','confirmed')),
  winner_status TEXT NOT NULL DEFAULT 'not_drawn' CHECK (winner_status IN ('not_drawn','drawn','announced')),
  winner_display TEXT,
  published     INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE faqs (
  id          INTEGER PRIMARY KEY,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  published   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT
);

CREATE TABLE notifications (
  id           INTEGER PRIMARY KEY,
  attendee_id  INTEGER REFERENCES attendees(id),
  channel      TEXT NOT NULL CHECK (channel IN ('email','sms')),
  template     TEXT NOT NULL,
  to_addr      TEXT NOT NULL,
  subject      TEXT,
  body_text    TEXT NOT NULL,
  body_html    TEXT,
  status       TEXT NOT NULL CHECK (status IN ('queued','sending','sent','failed','not_configured','skipped')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  provider_id  TEXT,
  error        TEXT,
  dedupe_key   TEXT UNIQUE,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_notifications_status ON notifications(status);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  actor       TEXT NOT NULL,          -- 'admin:<id>', 'attendee:<id>', 'system', 'stripe'
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  before_json TEXT,
  after_json  TEXT,
  note        TEXT,
  ip_hash     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- Privacy-conscious first-party analytics: no names, emails, phones or IPs.
CREATE TABLE analytics_events (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  visitor_hash TEXT,
  ref_code     TEXT,
  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_analytics_name ON analytics_events(name, created_at);

// Server-side validation. The browser validates too, but only this counts.

export const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico', OT: 'Outside the U.S.',
};

export const INTERESTS = {
  day_trading: 'Day trading',
  crypto: 'Cryptocurrency',
  strategies: 'Trading strategies',
  risk: 'Risk management',
  credit_education: 'Credit education',
  credit_reports: 'Understanding credit reports',
  credit_improvement: 'Credit improvement',
  financial_literacy: 'Financial literacy',
  networking: 'Networking',
  performances: 'Live performances',
  food_games: 'Food and games',
  prizes: 'Prizes and giveaways',
  other: 'Other',
};

export const AGE_GROUPS = { under_13: '8–12', teen: '13–17', '18_24': '18–24', '25_34': '25–34', '35_44': '35–44', '45_54': '45–54', '55_plus': '55+' };
export const HEARD_FROM = { instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook', friend: 'A friend or family member', flyer: 'Flyer', text: 'Text message', other: 'Other' };

const clean = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);

export function normalizeEmail(email) {
  const e = String(email).trim().toLowerCase();
  const [local, domain] = e.split('@');
  if (!domain) return e;
  if (domain === 'gmail.com' || domain === 'googlemail.com') return `${local.split('+')[0].replace(/\./g, '')}@gmail.com`;
  return `${local.split('+')[0]}@${domain}`;
}

export function normalizePhone(phone) {
  let d = String(phone).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d;
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com', 'temp-mail.org', 'dispostable.com']);
export const isDisposableEmail = (e) => DISPOSABLE.has(String(e).split('@')[1]?.toLowerCase());

export function validateRsvp(input) {
  const errors = {};
  const v = {
    first_name: clean(input.first_name, 60),
    last_name: clean(input.last_name, 60),
    email: clean(input.email, 254).toLowerCase(),
    phone: clean(input.phone, 30),
    state: clean(input.state, 2).toUpperCase(),
    understands_in_person: input.understands_in_person === true || input.understands_in_person === 'on' || input.understands_in_person === '1',
    privacy_agreed: input.privacy_agreed === true || input.privacy_agreed === 'on' || input.privacy_agreed === '1',
    instagram: clean(input.instagram, 31).replace(/^@+/, '') || null,
    age_group: clean(input.age_group, 20) || null,
    guests_count: input.guests_count === '' || input.guests_count === undefined ? 0 : Number(input.guests_count),
    heard_from: clean(input.heard_from, 20) || null,
    invited_by_text: clean(input.invited_by_text, 80) || null,
    interests: Array.isArray(input.interests) ? [...new Set(input.interests.map((x) => clean(x, 30)))] : [],
    interests_other: clean(input.interests_other, 200) || null,
    marketing_email_opt_in: input.marketing_email_opt_in === true || input.marketing_email_opt_in === 'on',
    sms_opt_in: input.sms_opt_in === true || input.sms_opt_in === 'on',
    display_name: clean(input.display_name, 40) || null,
  };

  if (!v.first_name) errors.first_name = 'Enter your first name.';
  if (!v.last_name) errors.last_name = 'Enter your last name.';
  if (!EMAIL_RE.test(v.email)) errors.email = 'Enter a valid email address, like name@example.com.';
  const pn = normalizePhone(v.phone);
  if (pn.length !== 10 || /^[01]/.test(pn)) errors.phone = 'Enter a 10-digit U.S. phone number.';
  if (!US_STATES[v.state]) errors.state = 'Choose your state.';
  if (!v.understands_in_person) errors.understands_in_person = 'Confirm you understand this is an in-person event in Maryland.';
  if (!v.privacy_agreed) errors.privacy_agreed = 'Agree to the privacy policy to register.';
  if (v.instagram && !/^[A-Za-z0-9._]{1,30}$/.test(v.instagram)) errors.instagram = 'Instagram usernames use letters, numbers, periods and underscores.';
  if (v.age_group && !AGE_GROUPS[v.age_group]) errors.age_group = 'Choose an age group from the list.';
  if (!Number.isInteger(v.guests_count) || v.guests_count < 0 || v.guests_count > 10) errors.guests_count = 'Additional guests must be between 0 and 10.';
  if (v.heard_from && !HEARD_FROM[v.heard_from]) errors.heard_from = 'Choose an option from the list.';
  if (v.interests.some((i) => !INTERESTS[i])) errors.interests = 'Choose topics from the list.';
  if (v.sms_opt_in && !(input.sms_opt_in)) v.sms_opt_in = false;

  v.phone_norm = pn;
  v.email_norm = normalizeEmail(v.email);
  return { ok: Object.keys(errors).length === 0, errors, value: v };
}

export function validateQuantity(q, max) {
  const n = Number(q);
  if (!Number.isInteger(n)) return 'Choose a whole number of entries.';
  if (n < 5) return 'The minimum purchase is 5 entries ($5).';
  if (n % 5 !== 0) return 'Entries are sold in bundles of 5. Choose 5, 10, 15, and so on.';
  if (n > max) return `The most you can buy in one purchase is ${max} entries.`;
  return null;
}

export { clean };

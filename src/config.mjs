// Runtime configuration. Filled from environment variables / Cloudflare bindings by initConfig().
// Secrets only ever come from the environment (or, for APP_SECRET, a generated per-install value
// stored in the database when none is provided).

export const config = {
  port: 3000,
  baseUrl: '',
  baseUrlFixed: false,
  isProd: false,
  hashSalt: '',
  trustProxy: true,
  assetVersion: '3',
  setupCode: '',
  adminEmail: '',
  adminPassword: '',
  stripe: { secretKey: '', webhookSecret: '', apiBase: 'https://api.stripe.com' },
  email: { resendKey: '', from: '', replyTo: '', apiBase: 'https://api.resend.com' },
  sms: { twilioSid: '', twilioToken: '', from: '', apiBase: 'https://api.twilio.com' },
  turnstile: { siteKey: '', secretKey: '' },
  plausibleDomain: '',
  cronSecret: '',
};

export function initConfig(env = {}) {
  const e = (k, d = '') => String(env[k] ?? d).trim();
  const base = e('BASE_URL').replace(/\/$/, '');
  Object.assign(config, {
    port: Number(e('PORT', '3000')),
    baseUrl: base || config.baseUrl,
    baseUrlFixed: Boolean(base),
    isProd: e('NODE_ENV', 'production') === 'production',
    hashSalt: e('APP_SECRET') || config.hashSalt,
    trustProxy: e('TRUST_PROXY', '1') === '1',
    assetVersion: e('ASSET_VERSION', config.assetVersion),
    setupCode: e('SETUP_CODE'),
    adminEmail: e('ADMIN_EMAIL').toLowerCase(),
    adminPassword: e('ADMIN_PASSWORD'),
    stripe: { secretKey: e('STRIPE_SECRET_KEY'), webhookSecret: e('STRIPE_WEBHOOK_SECRET'), apiBase: e('STRIPE_API_BASE', 'https://api.stripe.com') },
    email: { resendKey: e('RESEND_API_KEY'), from: e('EMAIL_FROM'), replyTo: e('EMAIL_REPLY_TO'), apiBase: e('RESEND_API_BASE', 'https://api.resend.com') },
    sms: { twilioSid: e('TWILIO_ACCOUNT_SID'), twilioToken: e('TWILIO_AUTH_TOKEN'), from: e('TWILIO_FROM_NUMBER'), apiBase: e('TWILIO_API_BASE', 'https://api.twilio.com') },
    turnstile: { siteKey: e('TURNSTILE_SITE_KEY'), secretKey: e('TURNSTILE_SECRET_KEY') },
    plausibleDomain: e('PLAUSIBLE_DOMAIN'),
    cronSecret: e('CRON_SECRET'),
  });
}

// When BASE_URL isn't set (e.g. a fresh *.workers.dev deploy), use the address the site was reached at.
export function useRequestOrigin(origin) {
  if (!config.baseUrlFixed && origin) config.baseUrl = origin;
}

export const integrations = {
  stripe: () => Boolean(config.stripe.secretKey && config.stripe.webhookSecret),
  stripeLive: () => config.stripe.secretKey.startsWith('sk_live_'),
  email: () => Boolean(config.email.resendKey && config.email.from),
  sms: () => Boolean(config.sms.twilioSid && config.sms.twilioToken && config.sms.from),
  turnstile: () => Boolean(config.turnstile.siteKey && config.turnstile.secretKey),
};

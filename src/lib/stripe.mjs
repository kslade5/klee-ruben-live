// Stripe via its REST API (no SDK needed). Secret key stays on the server.
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { config } from '../config.mjs';

function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripeRequest(method, path, params, idempotencyKey) {
  const headers = { Authorization: `Bearer ${config.stripe.secretKey}`, 'Stripe-Version': '2024-06-20' };
  let body;
  if (params && method !== 'GET') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = formEncode(params).toString();
  }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`${config.stripe.apiBase}/v1${path}`, { method, headers, body, signal: AbortSignal.timeout(20000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.error?.message || `Stripe error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

export const stripe = {
  createCheckoutSession: (params, idempotencyKey) => stripeRequest('POST', '/checkout/sessions', params, idempotencyKey),
  retrieveCheckoutSession: (id) => stripeRequest('GET', `/checkout/sessions/${encodeURIComponent(id)}`),
};

// Verifies the Stripe-Signature header against the raw request body (HMAC-SHA256, 5-minute tolerance).
export function verifyWebhook(rawBody, header, secret = config.stripe.webhookSecret, toleranceSec = 300) {
  if (!header || !secret) return null;
  const parts = Object.create(null);
  const v1 = [];
  for (const kv of String(header).split(',')) {
    const [k, v] = kv.split('=');
    if (k === 'v1') v1.push(v);
    else parts[k] = v;
  }
  const t = Number(parts.t);
  if (!t || !v1.length) return null;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return null;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody.toString('utf8')}`).digest('hex');
  const ok = v1.some((sig) => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
  if (!ok) return null;
  try { return JSON.parse(rawBody.toString('utf8')); } catch { return null; }
}

// Used by the test suite to produce correctly signed events.
export function signPayload(payload, secret, t = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

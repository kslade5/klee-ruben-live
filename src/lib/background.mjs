// Work that should finish after the response is sent (emails, texts).
// On Cloudflare this uses ctx.waitUntil so the work isn't cut off; on Node it just runs.
import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage();
export const withRequestContext = (ctx, fn) => store.run(ctx || {}, fn);

export function defer(fn) {
  const p = Promise.resolve().then(fn).catch((e) => console.error('[background]', e));
  const ctx = store.getStore();
  if (ctx?.waitUntil) ctx.waitUntil(p);
  return p;
}

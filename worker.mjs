// Cloudflare Workers entry point. Static files in /public are served by Cloudflare directly
// (see [assets] in wrangler.toml); everything else comes here.
import { handle, scheduled } from './src/app.mjs';

export default {
  fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil(scheduled(env, ctx));
  },
};

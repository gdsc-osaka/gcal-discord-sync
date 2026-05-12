// Cloudflare Worker that relays HTTPS requests from Google Apps Script to the
// Discord REST API. GAS's UrlFetchApp cannot override the User-Agent header,
// and the default (Mozilla/5.0 (compatible; Google-Apps-Script; ...)) is
// rejected by Discord's Cloudflare WAF with HTTP 403 / code 40333. This worker
// rewrites the User-Agent to the Discord-mandated 'DiscordBot (<URL>, <ver>)'
// format and forwards everything else (method, path, body, Authorization) on.

const TARGET_ORIGIN = 'https://discord.com';
const DISCORD_BOT_UA =
  'DiscordBot (https://github.com/gdsc-osaka/gcal-discord-sync, 0.1.0)';

// Headers that should not be forwarded back to Discord — they're meaningful
// only on the GAS→Worker hop and would either confuse Discord or leak Worker
// internals.
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'cf-worker',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-real-ip',
  'x-proxy-secret',
]);

export default {
  /**
   * @param {Request} request
   * @param {{ PROXY_SECRET?: string }} env
   */
  async fetch(request, env) {
    if (env.PROXY_SECRET) {
      const provided = request.headers.get('x-proxy-secret');
      if (provided !== env.PROXY_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    const incoming = new URL(request.url);
    if (!incoming.pathname.startsWith('/api/')) {
      return new Response('Only /api/* paths are proxied.', { status: 404 });
    }

    const target = TARGET_ORIGIN + incoming.pathname + incoming.search;

    const headers = new Headers();
    for (const [name, value] of request.headers) {
      if (!STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    }
    headers.set('User-Agent', DISCORD_BOT_UA);

    const init = {
      method: request.method,
      headers,
      redirect: 'manual',
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.arrayBuffer();
    }

    const upstream = await fetch(target, init);

    // Pass the response through unchanged (status, body, headers).
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  },
};

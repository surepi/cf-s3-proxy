// Cloudflare Worker: edge-cached, read-only proxy for a private S3-compatible bucket.
import { signS3Request, encodeKey } from './sigv4.js';

const PASS_HEADERS = [
  'content-type', 'content-length', 'content-range', 'content-encoding',
  'content-disposition', 'content-language', 'accept-ranges', 'etag', 'last-modified',
];
const warming = new Set(); // per-isolate dedupe of background cache fills

export default {
  async fetch(request, env, ctx) {
    let cfg;
    try {
      cfg = loadConfig(env);
    } catch (e) {
      console.error('config error:', e.message);
      return text(500, 'Worker misconfigured');
    }
    try {
      return await handle(request, cfg, ctx);
    } catch (e) {
      console.error('unhandled:', e && e.stack);
      return text(502, 'Bad Gateway');
    }
  },
};

function loadConfig(env) {
  const need = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) throw new Error('missing ' + missing.join(', '));

  const endpoint = new URL(env.S3_ENDPOINT);
  let prefix = (env.PATH_PREFIX || '').replace(/^\/+/, '');
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
  const bool = (v, d) => (v === undefined || v === '' ? d : String(v) === 'true');

  return {
    endpoint,
    bucket: env.S3_BUCKET,
    region: env.S3_REGION || 'us-east-1',
    pathStyle: bool(env.PATH_STYLE, true),
    prefix,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    accessToken: env.ACCESS_TOKEN || '',
    signSecret: env.SIGN_SECRET || '',
    edgeTtl: num(env.CACHE_TTL, 86400),
    browserTtl: num(env.BROWSER_TTL, 3600),
    cacheMaxBytes: num(env.CACHE_MAX_BYTES, 100 * 1024 * 1024),
    warmOnRange: bool(env.WARM_ON_RANGE, true),
    corsOrigins: (env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
    debug: bool(env.DEBUG, false),
  };
}

async function handle(request, cfg, ctx) {
  const url = new URL(request.url);
  const cors = corsHeaders(request, cfg);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Max-Age': '86400' } });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text(405, 'Method Not Allowed', { Allow: 'GET, HEAD, OPTIONS', ...cors });
  }

  if (!(await isAuthorized(request, url, cfg))) return text(403, 'Forbidden', cors);

  // Map URL path -> object key.
  let key;
  try {
    key = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return text(400, 'Bad Request', cors);
  }
  // No listing, and no "." / ".." segments (they'd be normalized away and could escape the bucket/prefix).
  if (!key || key.endsWith('/') || key.split('/').some((s) => s === '.' || s === '..')) {
    return text(404, 'Not Found', cors);
  }
  key = cfg.prefix + key;

  const range = request.headers.get('Range');
  const cacheOn = cfg.edgeTtl > 0;
  const cache = caches.default;
  const cacheUrl = url.origin + url.pathname; // auth query params stripped -> shared cache entry

  // 1) Edge cache (Cache API answers Range / If-None-Match / If-Modified-Since itself).
  if (cacheOn) {
    const lookup = new Request(cacheUrl, { headers: pickHeaders(request.headers, ['Range', 'If-None-Match', 'If-Modified-Since']) });
    const hit = await cache.match(lookup);
    if (hit) return finalize(hit, request.method, cors, cfg, 'HIT');
  }

  // 2) Origin.
  const origin = await fetchOrigin(cfg, key, request.method, range);

  if (!origin.ok) {
    if (cfg.debug) console.log('origin', origin.status, await origin.clone().text());
    if (origin.status === 416) return finalize(origin, request.method, cors, cfg, 'MISS');
    // S3 returns 403 for missing keys when ListBucket isn't granted; don't leak details.
    const status = origin.status === 403 || origin.status === 404 ? 404 : 502;
    return text(status, status === 404 ? 'Not Found' : 'Bad Gateway', cors);
  }

  if (cacheOn && request.method === 'GET') {
    if (origin.status === 200) {
      const len = Number(origin.headers.get('content-length') || 0);
      if (len > 0 && len <= cfg.cacheMaxBytes) {
        ctx.waitUntil(cache.put(cacheUrl, toCacheable(origin.clone(), cfg)).catch((e) => console.error('cache.put', e)));
      }
    } else if (origin.status === 206 && cfg.warmOnRange) {
      // Video/large-file clients only send Range requests; fill the cache with the whole object in the background.
      const total = totalFromContentRange(origin.headers.get('content-range'));
      if (total > 0 && total <= cfg.cacheMaxBytes && !warming.has(cacheUrl)) {
        warming.add(cacheUrl);
        ctx.waitUntil(
          (async () => {
            const full = await fetchOrigin(cfg, key, 'GET', null);
            if (full.status === 200) await cache.put(cacheUrl, toCacheable(full, cfg));
            else await full.body?.cancel();
          })()
            .catch((e) => console.error('warm', e))
            .finally(() => warming.delete(cacheUrl)),
        );
      }
    }
  }

  return finalize(origin, request.method, cors, cfg, cacheOn ? 'MISS' : 'BYPASS');
}

async function fetchOrigin(cfg, key, method, range) {
  const ep = cfg.endpoint;
  const basePath = ep.pathname.replace(/\/+$/, '');
  let host, path;
  if (cfg.pathStyle) {
    host = ep.host;
    path = `${basePath}/${encodeKey(cfg.bucket)}/${encodeKey(key)}`;
  } else {
    host = `${cfg.bucket}.${ep.host}`;
    path = `${basePath}/${encodeKey(key)}`;
  }
  const headers = new Headers();
  if (range) headers.set('range', range);
  await signS3Request({
    method, host, path, headers,
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  });
  return fetch(`${ep.protocol}//${host}${path}`, { method, headers, redirect: 'manual' });
}

/** Copy of the origin response suitable for cache.put (only safe headers, explicit TTL). */
function toCacheable(resp, cfg) {
  const h = new Headers();
  for (const k of PASS_HEADERS) {
    const v = resp.headers.get(k);
    if (v && k !== 'content-range') h.set(k, v);
  }
  h.set('cache-control', `public, max-age=${cfg.edgeTtl}`);
  return new Response(resp.body, { status: 200, headers: h });
}

function finalize(resp, method, cors, cfg, cacheStatus) {
  const h = new Headers();
  for (const k of PASS_HEADERS) {
    const v = resp.headers.get(k);
    if (v) h.set(k, v);
  }
  if (!h.has('accept-ranges')) h.set('accept-ranges', 'bytes');
  h.set('cache-control', cfg.browserTtl > 0 ? `public, max-age=${cfg.browserTtl}` : 'no-store');
  h.set('x-cache', cacheStatus);
  for (const [k, v] of Object.entries(cors)) h.set(k, v);
  if (method === 'HEAD') {
    resp.body?.cancel();
    return new Response(null, { status: resp.status, headers: h });
  }
  return new Response(resp.body, { status: resp.status, headers: h });
}

// ---------- auth ----------

async function isAuthorized(request, url, cfg) {
  if (!cfg.accessToken && !cfg.signSecret) return true; // public mode

  if (cfg.accessToken) {
    const auth = request.headers.get('Authorization') || '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('token');
    if (given && (await safeEqual(given, cfg.accessToken))) return true;
  }

  if (cfg.signSecret) {
    // ?expires=<unix seconds>&sig=<base64url HMAC-SHA256(secret, pathname + "\n" + expires)>
    const expires = url.searchParams.get('expires');
    const sig = url.searchParams.get('sig');
    if (expires && sig && /^\d+$/.test(expires) && Number(expires) >= Date.now() / 1000) {
      const sigBytes = b64urlDecode(sig);
      if (sigBytes) {
        const k = await crypto.subtle.importKey(
          'raw', new TextEncoder().encode(cfg.signSecret),
          { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
        );
        const ok = await crypto.subtle.verify(
          'HMAC', k, sigBytes, new TextEncoder().encode(`${url.pathname}\n${expires}`),
        );
        if (ok) return true;
      }
    }
  }
  return false;
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function b64urlDecode(s) {
  try {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

// ---------- helpers ----------

function corsHeaders(request, cfg) {
  const origin = request.headers.get('Origin');
  if (!origin || !cfg.corsOrigins.length) return {};
  const allow = cfg.corsOrigins.includes('*') ? '*' : cfg.corsOrigins.includes(origin) ? origin : null;
  if (!allow) return {};
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Authorization, If-None-Match, If-Modified-Since',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, ETag, Last-Modified, Accept-Ranges, X-Cache',
    ...(allow !== '*' ? { Vary: 'Origin' } : {}),
  };
}

function pickHeaders(src, names) {
  const h = new Headers();
  for (const n of names) {
    const v = src.get(n);
    if (v) h.set(n, v);
  }
  return h;
}

function totalFromContentRange(v) {
  const m = v && /\/(\d+)\s*$/.exec(v);
  return m ? Number(m[1]) : 0;
}

function text(status, body, headers = {}) {
  return new Response(body + '\n', {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

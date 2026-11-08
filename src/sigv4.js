// Minimal AWS Signature V4 signer for S3 GET/HEAD requests (WebCrypto, no deps).

export const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const enc = new TextEncoder();
const signingKeyCache = new Map(); // `${secret}|${date}|${region}` -> CryptoKey bytes

const toHex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(str) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(str)));
}

async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return crypto.subtle.sign('HMAC', key, enc.encode(data));
}

async function getSigningKey(secret, date, region) {
  const id = `${secret}|${date}|${region}`;
  let k = signingKeyCache.get(id);
  if (!k) {
    const kDate = await hmac(enc.encode('AWS4' + secret), date);
    const kRegion = await hmac(kDate, region);
    const kService = await hmac(kRegion, 's3');
    k = await hmac(kService, 'aws4_request');
    if (signingKeyCache.size > 8) signingKeyCache.clear();
    signingKeyCache.set(id, k);
  }
  return k;
}

/** Percent-encode an S3 object key per SigV4 rules ("/" kept, everything else RFC 3986). */
export function encodeKey(key) {
  return key
    .split('/')
    .map((s) =>
      encodeURIComponent(s).replace(
        /[!'()*]/g,
        (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
      ),
    )
    .join('/');
}

/**
 * Sign a GET/HEAD request without query string or body.
 * @param {object} p
 * @param {string} p.method
 * @param {string} p.host      Host header value (with port if non-default)
 * @param {string} p.path      Already-encoded absolute path, e.g. "/bucket/a%20b.txt"
 * @param {Headers} p.headers  Extra headers; "range" is signed if present. Mutated in place.
 * @param {string} p.region
 * @param {string} p.accessKeyId
 * @param {string} p.secretAccessKey
 * @param {Date}   [p.now]
 */
export async function signS3Request(p) {
  const now = p.now || new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const date = amzDate.slice(0, 8);

  p.headers.set('x-amz-date', amzDate);
  p.headers.set('x-amz-content-sha256', EMPTY_SHA256);

  const signed = [['host', p.host]];
  const range = p.headers.get('range');
  if (range) signed.push(['range', range.trim()]);
  signed.push(['x-amz-content-sha256', EMPTY_SHA256], ['x-amz-date', amzDate]);

  const signedHeaders = signed.map(([k]) => k).join(';');
  const canonicalHeaders = signed.map(([k, v]) => `${k}:${v}\n`).join('');
  const canonicalRequest = [
    p.method, p.path, '', canonicalHeaders, signedHeaders, EMPTY_SHA256,
  ].join('\n');

  const scope = `${date}/${p.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest),
  ].join('\n');

  const key = await getSigningKey(p.secretAccessKey, date, p.region);
  const signature = toHex(await hmac(key, stringToSign));

  p.headers.set(
    'authorization',
    `AWS4-HMAC-SHA256 Credential=${p.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  );
  return p.headers;
}

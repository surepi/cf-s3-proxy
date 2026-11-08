// 本地逻辑测试：模拟 S3 源站（校验 SigV4）+ 模拟 caches.default + Cloudflare 专有 API
import assert from 'node:assert/strict';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

// --- Cloudflare 运行时 polyfill ---
crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));
const store = new Map();
globalThis.caches = { default: {
  async match(req) {
    const r = store.get(typeof req === 'string' ? req : req.url);
    if (!r) return undefined;
    const body = new Uint8Array(await r.clone().arrayBuffer());
    const range = typeof req === 'string' ? null : req.headers.get('range');
    if (range) {
      const [, s, e] = /bytes=(\d+)-(\d*)/.exec(range);
      const end = e ? Number(e) : body.length - 1;
      const h = new Headers(r.headers);
      h.set('content-range', `bytes ${s}-${end}/${body.length}`); h.set('content-length', String(end - s + 1));
      return new Response(body.slice(Number(s), end + 1), { status: 206, headers: h });
    }
    return new Response(body, { status: 200, headers: r.headers });
  },
  async put(url, resp) { assert.equal(resp.status, 200); const b = await resp.arrayBuffer(); store.set(url, new Response(b, { headers: resp.headers })); },
}};

// --- 假 S3 源站 ---
const AK = 'testak', SK = 'testsecret', REGION = 'us-east-1';
const objects = { 'bkt/dir/a b(1).txt': 'hello world\n', 'bkt/dir/big.bin': 'x'.repeat(5000), 'bkt/中文/文件.txt': '你好' };
let originCalls = 0;
const hmac = (k, d) => createHmac('sha256', k).update(d).digest();
globalThis.fetch = async (url, init) => {
  originCalls++;
  const u = new URL(url), h = init.headers;
  // 独立重算签名
  const auth = h.get('authorization');
  const signedHeaders = /SignedHeaders=([^,]+)/.exec(auth)[1].split(';');
  const canon = [init.method, u.pathname, '', signedHeaders.map((k) => `${k}:${k === 'host' ? u.host : h.get(k)}\n`).join(''),
    signedHeaders.join(';'), h.get('x-amz-content-sha256')].join('\n');
  const amz = h.get('x-amz-date'), date = amz.slice(0, 8), scope = `${date}/${REGION}/s3/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amz, scope, createHash('sha256').update(canon).digest('hex')].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + SK, date), REGION), 's3'), 'aws4_request');
  if (!auth.includes(`Credential=${AK}/${scope}`) || /Signature=(\w+)/.exec(auth)[1] !== hmac(key, sts).toString('hex'))
    return new Response('<Error>SignatureDoesNotMatch</Error>', { status: 403 });
  const obj = objects[decodeURIComponent(u.pathname.slice(1))];
  if (obj === undefined) return new Response('<Error><Code>AccessDenied</Code><Message>Access Denied.</Message></Error>', { status: 403 });
  const body = new TextEncoder().encode(obj);
  const base = { 'content-type': 'application/octet-stream', etag: '"abc"', 'x-amz-request-id': 'SECRET' };
  const range = h.get('range');
  if (range) {
    const [, s, e] = /bytes=(\d+)-(\d*)/.exec(range); const end = e ? Number(e) : body.length - 1;
    return new Response(init.method === 'HEAD' ? null : body.slice(Number(s), end + 1), { status: 206,
      headers: { ...base, 'content-range': `bytes ${s}-${end}/${body.length}`, 'content-length': String(end - s + 1) } });
  }
  return new Response(init.method === 'HEAD' ? null : body, { status: 200, headers: { ...base, 'content-length': String(body.length) } });
};

const worker = (await import('../src/worker.js')).default;
const baseEnv = { S3_ENDPOINT: 'https://s3.example.com', S3_BUCKET: 'bkt', S3_ACCESS_KEY_ID: AK, S3_SECRET_ACCESS_KEY: SK };
async function call(path, { env = {}, headers = {}, method = 'GET' } = {}) {
  const waits = [];
  const res = await worker.fetch(new Request('https://cdn.test' + path, { method, headers }), { ...baseEnv, ...env }, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return res;
}
let n = 0; const ok = (name) => console.log(`ok ${++n} - ${name}`);

let r = await call('/dir/a%20b(1).txt');
assert.equal(r.status, 200); assert.equal(await r.text(), 'hello world\n'); assert.equal(r.headers.get('x-cache'), 'MISS');
assert.equal(r.headers.get('x-amz-request-id'), null); ok('签名通过 + 空格括号文件名 + 去掉 S3 内部头');
const before = originCalls;
r = await call('/dir/a%20b(1).txt'); assert.equal(r.headers.get('x-cache'), 'HIT'); assert.equal(await r.text(), 'hello world\n');
assert.equal(originCalls, before); ok('第二次命中缓存，不回源');
r = await call('/%E4%B8%AD%E6%96%87/%E6%96%87%E4%BB%B6.txt'); assert.equal(await r.text(), '你好'); ok('中文路径');
r = await call('/dir/big.bin', { headers: { Range: 'bytes=0-99' } });
assert.equal(r.status, 206); assert.equal((await r.text()).length, 100); assert.equal(r.headers.get('x-cache'), 'MISS'); ok('Range 回源返回 206');
r = await call('/dir/big.bin', { headers: { Range: 'bytes=100-199' } });
assert.equal(r.status, 206); assert.equal(r.headers.get('x-cache'), 'HIT'); ok('Range 未命中后台拉全文件，下一段命中缓存');
r = await call('/dir/big.bin', { method: 'HEAD' }); assert.equal(r.status, 200); assert.equal(r.body, null); ok('HEAD');
r = await call('/nope.txt'); assert.equal(r.status, 404); assert.ok(!(await r.text()).includes('Error')); ok('不存在 -> 404，不泄露 XML');
r = await call('/dir/../x'); assert.equal(r.status, 404);
r = await call('/dir/%2e%2e/%2e%2e/other/x'); assert.equal(r.status, 404); ok('拒绝 .. 越出桶');
r = await call('/dir/'); assert.equal(r.status, 404); ok('不允许列目录');
r = await call('/dir/a%20b(1).txt', { method: 'POST' }); assert.equal(r.status, 405); ok('只读');
r = await call('/dir/a%20b(1).txt', { env: { S3_SECRET_ACCESS_KEY: 'wrong', CACHE_TTL: '0' } }); assert.equal(r.status, 404); ok('密钥错误被源站拒绝');

store.clear();
const tokEnv = { env: { ACCESS_TOKEN: 'tok123' } };
assert.equal((await call('/dir/a%20b(1).txt', tokEnv)).status, 403);
assert.equal((await call('/dir/a%20b(1).txt?token=bad', tokEnv)).status, 403);
assert.equal((await call('/dir/a%20b(1).txt?token=tok123', tokEnv)).status, 200);
assert.equal((await call('/dir/a%20b(1).txt', { ...tokEnv, headers: { Authorization: 'Bearer tok123' } })).status, 200); ok('ACCESS_TOKEN');

const sEnv = { env: { SIGN_SECRET: 's3cr3t' } };
const signUrl = (p, exp) => `${p}?expires=${exp}&sig=${createHmac('sha256', 's3cr3t').update(`${new URL(p, 'https://x').pathname}\n${exp}`).digest('base64url')}`;
const future = Math.floor(Date.now() / 1000) + 600;
assert.equal((await call(signUrl('/dir/big.bin', future), sEnv)).status, 200);
assert.equal((await call(signUrl('/dir/big.bin', 1000), sEnv)).status, 403);
assert.equal((await call(signUrl('/dir/big.bin', future).replace('big', 'a%20b(1)'), sEnv)).status, 403); ok('签名链接：有效/过期/换路径');

r = await call('/dir/big.bin', { headers: { Origin: 'https://a.com' }, env: { CORS_ORIGINS: 'https://b.com' } });
assert.equal(r.headers.get('access-control-allow-origin'), null);
r = await call('/dir/big.bin', { headers: { Origin: 'https://b.com' }, env: { CORS_ORIGINS: 'https://b.com' } });
assert.equal(r.headers.get('access-control-allow-origin'), 'https://b.com'); ok('CORS 白名单');

r = await call('/x', { env: { S3_BUCKET: '' } }); assert.equal(r.status, 500); ok('缺配置 -> 500');
store.clear();
r = await call('/dir/a%20b(1).txt', { env: { S3_ACCESS_KEY_ID: ' testak\n', S3_SECRET_ACCESS_KEY: 'testsecret \n' } });
assert.equal(r.status, 200); ok('变量首尾空格/换行自动去掉');
r = await call('/nope.txt', { env: { DEBUG: 'true' } }); const dbg = await r.text();
assert.equal(r.status, 404); assert.ok(dbg.includes('[debug] origin 403 AccessDenied') && !dbg.includes(SK)); ok('DEBUG 显示源站错误码且不含密钥');
console.log('ALL PASS');

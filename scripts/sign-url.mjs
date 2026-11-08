// 生成限时签名链接：SIGN_SECRET=xxx node scripts/sign-url.mjs https://cdn.example.com /path/file.mp4 3600
import { createHmac } from 'node:crypto';

const [, , base, path, ttl = '3600'] = process.argv;
const secret = process.env.SIGN_SECRET;
if (!base || !path || !secret) {
  console.error('usage: SIGN_SECRET=xxx node sign-url.mjs <base-url> <path> [ttl-seconds]');
  process.exit(1);
}
const u = new URL(path, base);
const expires = Math.floor(Date.now() / 1000) + Number(ttl);
const sig = createHmac('sha256', secret).update(`${u.pathname}\n${expires}`).digest('base64url');
console.log(`${u.origin}${u.pathname}?expires=${expires}&sig=${sig}`);

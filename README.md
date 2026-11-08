# cf-s3-proxy

用 Cloudflare Worker 给私有 S3 兼容存储（MinIO、AWS S3、R2、各家对象存储）做只读加速。
Worker 用 SigV4 签名回源，桶保持私有；文件缓存在 Cloudflare 边缘节点。

## 部署

```bash
npm i -g wrangler && wrangler login
# 1. 编辑 wrangler.toml：S3_ENDPOINT / S3_BUCKET / S3_REGION / PATH_STYLE，并打开 routes 绑定自定义域名
# 2. 设置密钥
wrangler secret put S3_ACCESS_KEY_ID
wrangler secret put S3_SECRET_ACCESS_KEY
# 3. 可选：访问控制（都不设 = 公开）
wrangler secret put ACCESS_TOKEN   # 访问时带 ?token=xxx 或 Authorization: Bearer xxx
wrangler secret put SIGN_SECRET    # 限时链接，用 scripts/sign-url.mjs 生成
# 4. 发布
wrangler deploy
```

访问：`https://cdn.example.com/<对象key>`，响应头 `X-Cache: HIT/MISS` 表示是否命中缓存。

生成限时链接：
```bash
SIGN_SECRET=xxx node scripts/sign-url.mjs https://cdn.example.com /videos/a.mp4 3600
```

## 注意

- **必须用自定义域名**（域名托管在 Cloudflare）。`*.workers.dev` 上 Cache API 不生效。
- `S3_ENDPOINT` 必须是域名，Workers 不能直连 IP。建议用 443 端口；MinIO 默认 9000 端口可能被 Workers 限制，最好前面套一层 Nginx 反代到 443。
- 缓存按 Cloudflare 节点分别存储，每个节点第一次访问都会回源。
- 后台写缓存受 `waitUntil` 约 30 秒时限，源站慢时大文件可能来不及缓存；可调小 `CACHE_MAX_BYTES`。
- 改了源站文件后：在 Cloudflare 面板 Caching → Purge Cache 清缓存，或者给文件换个名字。
- 只支持 GET/HEAD，不提供上传和列目录。

## 测试

```bash
node test/sigv4.test.mjs    # AWS 官方签名向量
node test/worker.test.mjs   # 模拟 S3 + 缓存的逻辑测试
```

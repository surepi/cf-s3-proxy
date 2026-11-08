# cf-s3-proxy

用 Cloudflare Worker 给私有 S3 兼容存储（MinIO、AWS S3、R2、各家对象存储）做只读加速。
Worker 用 SigV4 签名回源，桶保持私有；文件缓存在 Cloudflare 边缘节点。

## 部署

```bash
npm i -g wrangler && wrangler login
wrangler deploy
```

也可以不装 wrangler：在 Cloudflare 面板 Workers & Pages → Create → Import a repository，连接这个 GitHub 仓库，以后每次 push 自动部署。

部署后在面板 **Workers & Pages → s3-proxy → Settings** 里配置：

1. **Variables and Secrets** 添加变量（完整列表和默认值见 `wrangler.toml` 注释）：

   | 变量 | 类型 | 说明 |
   |---|---|---|
   | `S3_ENDPOINT` | Text | S3 接口地址，如 `https://s3.example.com` |
   | `S3_BUCKET` | Text | 桶名 |
   | `S3_ACCESS_KEY_ID` | Secret | 访问密钥 ID |
   | `S3_SECRET_ACCESS_KEY` | Secret | 访问密钥 |
   | `S3_REGION` | Text | 可选，默认 `us-east-1`，R2 填 `auto` |
   | `ACCESS_TOKEN` | Secret | 可选，访问口令 |
   | `SIGN_SECRET` | Secret | 可选，限时签名链接密钥 |

   密钥类一定选 **Secret**（加密保存，保存后面板里看不到明文）。
2. **Domains & Routes** 绑定自定义域名。

`wrangler.toml` 里设了 `keep_vars = true`，重新部署不会覆盖面板里的变量。

访问：`https://cdn.example.com/<对象key>`，响应头 `X-Cache: HIT/MISS` 表示是否命中缓存。

生成限时链接：
```bash
SIGN_SECRET=xxx node scripts/sign-url.mjs https://cdn.example.com /videos/a.mp4 3600
```

## 注意

- 建议绑定自定义域名（托管在 Cloudflare）。`*.workers.dev` 实测也能缓存，但该域名在部分地区访问不稳定。
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

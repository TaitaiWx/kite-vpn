# Kite Backend

> 零知识账户服务 + 跨设备同步 + 公网邀请 + 跨 Mesh 互联

## 这个服务做什么

| 功能 | 状态 | 路径 |
|---|---|---|
| **D. CA 私钥找回** | ✅ v0.1 | `/api/backup/ca-key` |
| 订阅 / 设置同步 | ✅ v0.1 | `/api/backup/subscriptions` `/api/backup/settings` |
| 账户体系（magic link 登录） | ✅ v0.1 | `/api/auth/*` |
| **F. 公网邀请链接** | ⏳ schema 就绪，UI 留 v0.2 | `/api/invites` |
| **G. 跨 Mesh 互联** | ⏳ schema 占位，v0.3 | `/api/bridges` |

## 零知识架构（重要）

```
客户端 Kite (Mac/iPhone):
  passphrase  →  Argon2id(passphrase, salt, m=64MB, t=3, p=4)  →  key (32B)
  CA 私钥     →  AES-256-GCM(key, plaintext)                    →  ciphertext
                                                                       ↓ HTTPS
                                                              ┌──────────────┐
                                                              │ kite-backend │
                                                              │              │
                                                              │  数据库只看  │
                                                              │  到 cipher   │
                                                              │  text + salt │
                                                              │  从来不见明文│
                                                              └──────────────┘

恢复流程（新设备）:
  登录 → 下载 ciphertext + salt → 用户输入 passphrase →
  Argon2id(passphrase, salt) → key → AES-GCM 解密 → CA 私钥
```

**关键安全保证**:
- 数据库被偷 = 攻击者拿到一堆 ciphertext，没有 passphrase 无法解
- 服务端工程师恶意 = 同上
- 暴破单个 blob 的成本（Argon2id m=64MB）≈ 1 万美元/blob
- 用户必须自己记住 / 安全保管 passphrase —— 这是设计权衡（无法 reset）

## 技术栈

- **Rust 2021** + axum 0.7 + tokio 1
- **SQLite** via sqlx 0.8（runtime queries 避免编译期 DB 依赖）
- **Argon2id** 用于 session token 和 magic link token 防 DB 泄漏
- **lettre** SMTP 邮件，dev 模式 stdout
- 单二进制部署（跟 lighthouse 一致）

## 本地运行

```bash
cd apps/backend
cargo run

# 服务跑在 http://127.0.0.1:8787
# magic link 在 stderr 输出（不实际发邮件）
```

测试 magic link 流程:

```bash
# 1. 请求登录
curl -X POST http://127.0.0.1:8787/api/auth/request-login \
  -H 'content-type: application/json' \
  -d '{"email":"me@example.com"}'

# 控制台会看到:
#   📧 Magic link for me@example.com →
#      http://127.0.0.1:8787/auth/verify?token=xxxxx

# 2. 浏览器打开那个链接（或 curl -i）
curl -i 'http://127.0.0.1:8787/auth/verify?token=xxxxx'
# 拿到 Set-Cookie: kite_session=...

# 3. 用 cookie 列备份
curl -i http://127.0.0.1:8787/api/backup \
  -H 'cookie: kite_session=...'
```

## API

### Auth

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/request-login` | `{ email }` → 发 magic link |
| GET  | `/auth/verify?token=...` | 浏览器点链接 → 颁发 session + redirect |
| POST | `/api/auth/logout` | 当前 user 所有 session 失效 |

### 备份（zero-knowledge）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/backup` | 列当前 user 所有 backup |
| PUT | `/api/backup/:kind` | 上传 / 覆盖 backup |
| GET | `/api/backup/:kind` | 下载 backup |
| DELETE | `/api/backup/:kind` | 删除 |

`kind` 必须是 `ca-key` / `subscriptions` / `settings` 之一。

PUT body 格式:
```json
{
  "ciphertext_b64": "...",                                    // base64
  "kdf_salt_b64": "...",                                      // base64, 16 字节
  "kdf_algorithm": "argon2id-v19-m65536-t3-p4",
  "version": 1
}
```

GET 返回同样格式，由客户端解密。

### 健康检查

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 返回 `ok` |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `KITE_DATABASE_URL` | `sqlite:./kite.db` | SQLite 路径 |
| `KITE_BIND` | `127.0.0.1:8787` | HTTP 监听 |
| `KITE_PUBLIC_URL` | `http://localhost:8787` | 拼 magic link 用的公网 URL |
| `KITE_FRONTEND_REDIRECT_URL` | `http://localhost:1420` | magic link 验证后跳哪 |
| `KITE_COOKIE_SECURE` | `false` | HTTPS 部署设 `true` |
| `KITE_MAILER` | `stdout` | `stdout` / `smtp` |
| `KITE_SMTP_HOST` | — | SMTP host |
| `KITE_SMTP_PORT` | `587` | SMTP STARTTLS port |
| `KITE_SMTP_USER` | — | SMTP 用户名 |
| `KITE_SMTP_PASS` | — | SMTP 密码 |
| `KITE_SMTP_FROM_EMAIL` | — | 发件人邮箱 |
| `KITE_SMTP_FROM_NAME` | `Kite` | 发件人名称 |

## 部署 (docker-compose)

**一台 VPS，一个 compose 文件，一个进程托管 backend + nebula lighthouse。**

```bash
# 在 VPS 上
git clone https://github.com/TaitaiWx/kite-vpn.git
cd kite-vpn/apps/backend

# 1. 准备 .env（域名、SMTP、Nebula 端口）
cp .env.example .env
$EDITOR .env

# 2. 生成 Nebula CA 和 lighthouse 证书（一次性）
mkdir -p pki && cd pki
docker run --rm -v "$PWD:/work" -w /work \
  ghcr.io/taitaiwx/kite-backend:latest \
  nebula-cert ca -name "kite-mesh"
docker run --rm -v "$PWD:/work" -w /work \
  ghcr.io/taitaiwx/kite-backend:latest \
  nebula-cert sign -name "lighthouse" -ip "100.64.0.1/24"
cd ..

# 3. 渲染 nebula 配置
mkdir -p config
envsubst < templates/nebula.yaml.template > config/nebula.yaml

# 4. 拿 TLS 证书（先把 80 暴露给 certbot bootstrap）
docker run --rm -p 80:80 \
  -v "$PWD/certbot/conf:/etc/letsencrypt" \
  -v "$PWD/certbot/www:/var/www/acme" \
  certbot/certbot certonly --standalone \
  -d "$KITE_DOMAIN" --email you@example.com --agree-tos -n

# 5. 起服务
docker compose up -d

# 6. 看日志
docker compose logs -f kite-backend
```

升级：
```bash
docker compose pull && docker compose up -d
```

数据备份：`docker compose exec kite-backend sqlite3 /var/lib/kite/kite.db .dump > backup.sql`

### 不用 Docker 想跑裸进程？

OK，提供了 systemd 模板，但需要你手动放二进制：

```bash
cargo build --release --bin kite-backend
sudo cp target/release/kite-backend /usr/local/bin/
sudo install -m 0644 templates/kite-backend.service /etc/systemd/system/
sudo install -m 0640 templates/env.template /etc/kite/env  # 改值
sudo systemctl daemon-reload && sudo systemctl enable --now kite-backend
```

Nebula 二进制自己下：https://github.com/slackhq/nebula/releases —— 放到 `/usr/local/bin/nebula` 即可，
kite-backend 启动时根据 `KITE_NEBULA_BIN` 自动 spawn。

## 测试

```bash
cargo test
# 19/19 passing：10 unit + 9 integration
```

集成测试覆盖：
- ✅ Magic link 单次使用
- ✅ 过期 token 拒绝
- ✅ 未登录访问 backup 401
- ✅ 跨用户备份隔离（user A 看不到 user B）
- ✅ 上传 / 下载 round-trip
- ✅ 非法 backup kind 拒绝
- ✅ 邮箱格式校验
- ✅ Health endpoint

## 路线图

### v0.1 (现在)
- Magic link 登录
- 零知识 CA / 订阅 / 设置备份
- Session 管理

### v0.2 (下个迭代)
- 公网邀请链接（F 功能）
  - Owner 客户端生成 → POST `/api/invites`
  - 公网 URL 例：`https://kite.example.com/invite/abc123`
  - 收件人点链接 → 登录 → 加密 payload 自动下载到 Kite 客户端
- 部署脚本 `deploy.sh`
- Rate limit middleware（防滥发 magic link）

### v0.3
- 跨 Mesh 互联（G 功能）
  - Owner A 授权 owner B 的某个 peer 接入自己网络
  - 双方 backend 通过 webhook 协商证书桥接
  - 数据流量仍走 P2P（lighthouse 协助 NAT 穿透）

### v0.4+
- Device 列表 / 设备管理
- Audit log（哪个设备何时签过哪张证书）
- 多 Mesh 网络（一个 Kite 加入多个）
- 团队订阅（owner 创建 mesh，加 N 个 viewer 角色）

## 安全注意事项

1. **永远不要在服务端日志或错误信息里 echo ciphertext 或 salt** —— 当前实现没有，但要 review 任何新加的 logging
2. **prod 必须 HTTPS + KITE_COOKIE_SECURE=true** —— magic link / session cookie 都是 bearer token
3. **数据库备份要单独加密** —— 即使 ciphertext 是零知识的，metadata（email、登录时间）还是泄漏隐私
4. **CSP / CORS 应该收紧** —— 当前 v0.1 用了 `CorsLayer::permissive()` 方便开发，prod 必须改

## 跟 desktop 客户端的契约

客户端的加密流程在 `apps/desktop/src-tauri/src/commands/mesh.rs` —— 同款 aes-gcm + sha2 crate，复用零成本。

| 客户端步骤 | 服务端 |
|---|---|
| Argon2id KDF | 不参与（不知道 passphrase） |
| AES-GCM 加密 | 不参与 |
| base64 编码 | 仅做 base64 校验 |
| HTTPS PUT/GET | 路由 + DB 持久化 |
| 解密 | 不参与 |

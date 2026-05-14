# Kite Backend

> 账户 + Mesh + 跨设备同步 —— 零知识、自托管、单容器。

## 一句话能力

一个 Pod 同时跑 `axum` 后端和 `nebula` lighthouse 子进程，对客户端提供：
- 账户体系（magic link 登录，无密码）
- 零知识备份（CA 私钥 / 订阅 / 设置）
- 公网邀请链接（F 功能 ✅）
- 跨 Mesh 互联（G 功能 ✅）
- 自动更新 endpoint（双 endpoint + ed25519 强签名）

## 技术栈

- **Rust 2021** + axum 0.7 + tokio
- **SQLite** + sqlx 0.8 (WAL 模式，单文件)
- **Argon2id** session / magic-link token hashing
- **ed25519-dalek** update endpoint 签名
- **lettre** SMTP（dev 模式 stdout）
- **Nebula** lighthouse 子进程（由 backend 进程托管）

## 路由表

### Auth
| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/auth/request-login` | 无 | `{ email }` → 发 magic link |
| GET  | `/auth/verify?token=...`  | 无 | 浏览器点链接 → 颁发 session + redirect |
| POST | `/api/auth/logout`        | session | 当前用户所有 session 失效 |

### 备份（零知识）
| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/backup` | session | 列当前用户所有 backup |
| PUT | `/api/backup/:kind` | session | 上传 / 覆盖（kind ∈ `ca-key` / `subscriptions` / `settings`） |
| GET | `/api/backup/:kind` | session | 下载 ciphertext |
| DELETE | `/api/backup/:kind` | session | 删除 |

### 公网邀请 (F)
| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/invites` | session | 创建邀请（含加密 payload）→ 返回 slug + public_url |
| GET  | `/api/invites` | session | 列当前 owner 所有邀请 |
| DELETE | `/api/invites/:slug` | session | 撤销未消费的邀请 |
| GET  | `/invite/:slug` | 无 | 公网落地页元信息（不返回密文） |
| GET  | `/api/invites/:slug/payload` | 可选 | 拿密文（单次消费） |

### 跨 Mesh 互联 (G)
| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/bridges/invites` | session | Owner A 创建 bridge invite → 返回 redeem_url |
| POST | `/api/bridges/redeem`  | session | Owner B 用 redeem_url 调本地 backend，由本地 backend 自动跟对方 backend 协调 |
| POST | `/api/bridges/accept`  | bridge_token | Backend-to-backend webhook（不要直接调） |
| GET  | `/api/bridges` | session | 列当前用户所有 bridge |
| DELETE | `/api/bridges/:id` | session | 撤销 bridge |

### 自动更新
| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/updates/latest.json` | 无 | 透传 GitHub Releases latest.json + 5min 内存缓存。响应附 `X-Kite-Signature: <ed25519 sig>` header |
| GET | `/api/updates/pubkey` | 无 | 获取 backend ed25519 公钥（base64） |

### 健康
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `ok` |

## 零知识架构（备份）

```
客户端 Kite:
  passphrase  ─→  Argon2id(passphrase, salt, m=64MB, t=3, p=4)  ─→  key (32B)
  CA 私钥     ─→  AES-256-GCM(key, plaintext)                    ─→  ciphertext
                                                                      ↓ HTTPS
                                                             ┌──────────────┐
                                                             │ kite-backend │
                                                             │              │
                                                             │ DB 只看到    │
                                                             │ ciphertext   │
                                                             │ + salt       │
                                                             └──────────────┘

恢复（新设备）:
  登录 → 下载 ciphertext + salt → passphrase →
  Argon2id(passphrase, salt) → key → AES-GCM 解 → CA 私钥
```

服务端被偷 = 攻击者只拿到 ciphertext，没 passphrase 解不出来。
暴破单个 blob（Argon2id m=64MB）≈ 1 万美元 / blob。

## 部署 (Kubernetes)

```bash
# 1. 准备 manifests
cd apps/backend/k8s
cp secret.example.yaml secret.yaml
$EDITOR secret.yaml                # 改域名 / SMTP 密码 / admin 邮箱

# 2. 生成 Nebula PKI（一次性）
mkdir -p pki && cd pki
docker run --rm -v "$PWD:/work" -w /work \
  ghcr.io/taitaiwx/kite-backend:latest \
  nebula-cert ca -name "kite-mesh"
docker run --rm -v "$PWD:/work" -w /work \
  ghcr.io/taitaiwx/kite-backend:latest \
  nebula-cert sign -name "lighthouse" -ip "100.64.0.1/24"
cd ..

# 3. 创建 secrets
kubectl create namespace kite
kubectl apply -f secret.yaml
kubectl create secret generic kite-nebula-pki \
  --from-file=pki/ca.crt \
  --from-file=pki/lighthouse.crt \
  --from-file=pki/lighthouse.key \
  --namespace=kite

# 4. 一键 apply 全部资源
kubectl apply -k apps/backend/k8s/

# 5. 看状态
kubectl -n kite get pods
kubectl -n kite logs -l app.kubernetes.io/name=kite-backend -f
```

升级：
```bash
kubectl -n kite rollout restart deployment/kite-backend
```

**前置条件**（集群侧一次性配置）：
- ingress-nginx 已装（任意 k8s 发行版都行：k3s 自带）
- cert-manager + ClusterIssuer `letsencrypt-prod`（cert-manager.io 官方一键 manifest）
- 域名 A/AAAA 指向集群 ingress IP
- UDP 30042（NodePort）防火墙放通（Nebula peer 直连入口）

## 初始管理员

启动时 backend 读 `KITE_ADMIN_EMAIL` —— 如果该邮箱：
- 不存在 → 创建用户并 `is_admin=1`
- 已存在 → 提升为 `is_admin=1`
- 未设 ENV → 跳过 seed（普通模式）

Admin 跟普通用户一样走 magic link 登录，特权是未来扩展 admin-only 路由的能力。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `KITE_DATABASE_URL` | `sqlite:./kite.db` | SQLite 路径 |
| `KITE_BIND` | `127.0.0.1:8787` | HTTP 监听 |
| `KITE_PUBLIC_URL` | `http://localhost:8787` | 拼 magic link / invite URL 用 |
| `KITE_FRONTEND_REDIRECT_URL` | `http://localhost:1420` | magic link 验证后跳哪 |
| `KITE_COOKIE_SECURE` | `false` | HTTPS 部署设 `true` |
| `KITE_ADMIN_EMAIL` | (未设) | 启动时种 admin |
| `KITE_NEBULA_BIN` | (未设) | nebula 二进制路径，设了就拉起子进程 |
| `KITE_NEBULA_CONFIG` | (未设) | nebula.yaml 路径 |
| `KITE_MAILER` | `stdout` | `stdout` / `smtp` |
| `KITE_SMTP_HOST/PORT/USER/PASS/FROM_EMAIL/FROM_NAME` | — | SMTP 配置 |
| `KITE_UPDATE_SOURCE_URL` | GitHub Releases | 上游 latest.json |
| `KITE_UPDATE_CACHE_SECS` | `300` | 缓存时长 |

## 本地开发

```bash
cd apps/backend
cargo run

# 服务 :8787，magic link 在 stderr 出明文
curl -X POST http://127.0.0.1:8787/api/auth/request-login \
  -H 'content-type: application/json' \
  -d '{"email":"me@example.com"}'
```

## 测试

```bash
cargo test
# 29 lib + 9 integration = 38 passing
```

## 路线图

### v0.1 ✅
- Magic link 登录
- 零知识 CA / 订阅 / 设置备份
- Session 管理

### v0.2 ✅ (本版本)
- 公网邀请链接 (F)
- 跨 Mesh 互联 (G)
- ed25519 update endpoint 强签名
- 初始管理员 seed
- K8s 部署清单
- GHCR 镜像推送 CI

### v0.3 (下个迭代)
- Device 列表 / 设备管理
- Audit log（哪个设备何时签过哪张证书）
- Admin-only 路由（删用户、强制注销、列所有 session）

### v0.4
- 多 Mesh 网络（一个 Kite 加入多个）
- 团队订阅（owner 创建 mesh，加 N 个 viewer）

-- Kite Backend v0.1 — initial schema
--
-- 设计原则:
-- - 零知识: encrypted_blob 列存 ciphertext，服务端无法解密
-- - 不存密码: magic link 一次性 token，过期作废
-- - 不存 CA 私钥明文: 客户端 AES-GCM 加密后才上传

CREATE TABLE users (
    id              TEXT PRIMARY KEY NOT NULL,    -- UUID v4
    email           TEXT NOT NULL UNIQUE,
    created_at      INTEGER NOT NULL,             -- unix ms
    updated_at      INTEGER NOT NULL,
    settings_json   TEXT NOT NULL DEFAULT '{}'    -- 同步配置（明文，因为不敏感）
);

CREATE INDEX idx_users_email ON users(email);

-- Magic link 登录 token —— 10 分钟有效，单次使用
CREATE TABLE magic_links (
    token_hash      TEXT PRIMARY KEY NOT NULL,    -- Argon2 hash 防计时攻击
    email           TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    used_at         INTEGER                       -- NULL = 未使用，非空 = 已 burnt
);

CREATE INDEX idx_magic_links_expires ON magic_links(expires_at);

-- HTTP session
CREATE TABLE sessions (
    token_hash      TEXT PRIMARY KEY NOT NULL,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,             -- 30 天，到期需要重新登录
    user_agent      TEXT NOT NULL DEFAULT '',
    last_seen_at    INTEGER NOT NULL              -- 每次请求更新
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- 加密备份 —— 服务端只看 ciphertext
-- kind: 'ca-key' = CA 私钥, 'subscriptions' = 订阅列表, 'settings' = 设置
CREATE TABLE backups (
    id              TEXT PRIMARY KEY NOT NULL,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,                -- 见上
    ciphertext      BLOB NOT NULL,                -- AES-GCM ciphertext（已含 nonce）
    -- 客户端 KDF 参数（每个 user / kind 独立 salt，passphrase 同源不同盐）
    kdf_salt        BLOB NOT NULL,                -- 16 字节
    kdf_algorithm   TEXT NOT NULL DEFAULT 'argon2id-v19-m65536-t3-p4',
    version         INTEGER NOT NULL DEFAULT 1,   -- 客户端 schema 版本
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    UNIQUE(user_id, kind)                          -- 每个 user 每种 backup 只一份（覆盖更新）
);

CREATE INDEX idx_backups_user ON backups(user_id);

-- 公网邀请链接（F 功能）—— v1 schema 先建好，UI 留 v1.1
-- invite_token 在客户端生成（AES-GCM 加密 enrollment payload），后端只做中转 + 过期清理
CREATE TABLE public_invites (
    token           TEXT PRIMARY KEY NOT NULL,    -- 客户端生成的短 token（不存 payload）
    owner_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    network_id      TEXT NOT NULL,                -- owner 网络的 CA fingerprint
    encrypted_payload BLOB NOT NULL,              -- 客户端加密的完整 enrollment 包
    peer_name_hint  TEXT NOT NULL DEFAULT '',     -- 仅 hint，UI 显示用
    expires_at      INTEGER NOT NULL,             -- 默认 7 天
    consumed_at     INTEGER,                      -- NULL = 未消费
    consumer_email  TEXT,                         -- 消费后记录是谁拿走的（审计用）
    created_at      INTEGER NOT NULL
);

CREATE INDEX idx_public_invites_expires ON public_invites(expires_at);

-- 跨 Mesh 互联（G 功能）—— schema 占位，v2 实现
-- 用户授权另一个 Mesh 的 owner 访问自己的特定 peer
CREATE TABLE cross_mesh_bridges (
    id              TEXT PRIMARY KEY NOT NULL,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    peer_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    local_peer_id   TEXT NOT NULL,                -- 自己网络里哪个 peer 暴露
    remote_peer_id  TEXT NOT NULL,                -- 对方网络里哪个 peer 可访问
    direction       TEXT NOT NULL,                -- 'in' / 'out' / 'both'
    status          TEXT NOT NULL DEFAULT 'pending', -- pending / active / revoked
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

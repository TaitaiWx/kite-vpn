-- 003 — audit log + TOTP + backup version history + meshes 占位

-- ── Audit log ──────────────────────────────────────────────────────────────
-- 每个敏感操作（登录 / 撤销 session / 创建 invite / 建 bridge / 备份 / 删用户）
-- 都写一条。用 actor_user_id NULL 表示系统事件（admin seed / cache invalidation）。
CREATE TABLE audit_log (
    id              TEXT PRIMARY KEY NOT NULL,
    actor_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor_email     TEXT NOT NULL DEFAULT '',
    actor_ip        TEXT NOT NULL DEFAULT '',
    event_type      TEXT NOT NULL,                 -- e.g. 'auth.login' / 'invite.create' / 'bridge.revoke'
    target_kind     TEXT NOT NULL DEFAULT '',      -- 'user' / 'invite' / 'bridge' / 'session' / 'backup'
    target_id       TEXT NOT NULL DEFAULT '',
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL
);
CREATE INDEX idx_audit_log_actor   ON audit_log(actor_user_id);
CREATE INDEX idx_audit_log_event   ON audit_log(event_type);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);

-- ── TOTP 凭证（user 可选开二次验证）────────────────────────────────────────
-- secret 是 raw bytes（base32 编码后展示），跟 1Password / Authy 同款 TOTP 协议。
-- backend 启用前要先验 6 位码一次，避免抄错。
CREATE TABLE totp_credentials (
    user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret          BLOB NOT NULL,                -- 20 字节 sha1 / 32 字节 sha256
    digits          INTEGER NOT NULL DEFAULT 6,
    period_seconds  INTEGER NOT NULL DEFAULT 30,
    algorithm       TEXT NOT NULL DEFAULT 'SHA1', -- Google Authenticator 默认
    verified_at     INTEGER,                       -- NULL = 待验证，非空 = 已激活
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

-- ── Backup version history ────────────────────────────────────────────────
-- backups 表保留"当前最新"行；版本历史落这里。每次 PUT 写一条 + 保留最近 N 条。
CREATE TABLE backup_versions (
    id              TEXT PRIMARY KEY NOT NULL,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,
    ciphertext      BLOB NOT NULL,
    kdf_salt        BLOB NOT NULL,
    kdf_algorithm   TEXT NOT NULL,
    version         INTEGER NOT NULL,
    bytes           INTEGER NOT NULL,
    created_at      INTEGER NOT NULL
);
CREATE INDEX idx_backup_versions_user_kind ON backup_versions(user_id, kind, created_at);

-- ── Meshes scaffold（多 Mesh schema 预留）─────────────────────────────────
-- v0.2 还是"一个 user 一个 mesh"，但 schema 留好 mesh_id 让 v0.3 平滑切换。
CREATE TABLE meshes (
    id              TEXT PRIMARY KEY NOT NULL,
    owner_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    ca_fingerprint  TEXT NOT NULL DEFAULT '',
    cidr            TEXT NOT NULL DEFAULT '100.64.0.0/10',
    lighthouse_endpoint TEXT NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_meshes_owner ON meshes(owner_user_id);

-- 在 invites / bridges 表预留 mesh_id 列（默认空，v0.3 backfill）
ALTER TABLE public_invites      ADD COLUMN mesh_id TEXT NOT NULL DEFAULT '';
ALTER TABLE cross_mesh_bridges  ADD COLUMN mesh_id TEXT NOT NULL DEFAULT '';

-- 002 — admin 标记 + 完善 invites/bridges schema
--
-- 设计原则:
-- - is_admin 是布尔，默认 0；admin 仅控制能否调 admin-only 路由（未来：删用户、看 audit log）
-- - public_invites 加 slug 用作公网 URL（短易传），保留 token 用作内部主键
-- - cross_mesh_bridges 加 webhook_url / bridge_token 用作两 backend 之间协调

ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- ── Public invites (F) ──────────────────────────────────────────────────────
-- 重建表加 slug（短公网 URL 用，例 /invite/abc123）
ALTER TABLE public_invites ADD COLUMN slug TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX idx_public_invites_slug ON public_invites(slug) WHERE slug != '';

-- ── Cross-mesh bridges (G) ──────────────────────────────────────────────────
-- 加协调字段，让两个 backend 用 webhook 互相确认
ALTER TABLE cross_mesh_bridges ADD COLUMN bridge_token TEXT NOT NULL DEFAULT '';
ALTER TABLE cross_mesh_bridges ADD COLUMN remote_backend_url TEXT NOT NULL DEFAULT '';
ALTER TABLE cross_mesh_bridges ADD COLUMN remote_ca_fingerprint TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX idx_cross_mesh_bridges_token ON cross_mesh_bridges(bridge_token) WHERE bridge_token != '';

-- ── Update endpoint 签名密钥（持久化在 DB，避免每次重启重新生成）─────────
CREATE TABLE update_signing_key (
    id              INTEGER PRIMARY KEY CHECK (id = 1),  -- 单行
    public_key      BLOB NOT NULL,                       -- ed25519 32B
    private_key     BLOB NOT NULL,                       -- ed25519 32B seed
    created_at      INTEGER NOT NULL
);

//! Lib 入口 — 重导出所有模块，让 integration tests 能 `use kite_backend::*`。

pub mod admin;
pub mod admin_routes;
pub mod audit;
pub mod auth;
pub mod backup;
pub mod bridges;
pub mod db;
pub mod error;
pub mod invites;
pub mod mailer;
pub mod metrics;
pub mod nebula;
pub mod ratelimit;
pub mod sessions;
pub mod state;
pub mod totp;
pub mod updates;
pub mod webhooks;

use axum::{
    http::{header, HeaderValue, Method},
    routing::{delete, get, post, put},
    Router,
};
use tower_http::{cors::CorsLayer, limit::RequestBodyLimitLayer, trace::TraceLayer};

use crate::state::AppState;

/// 最大请求体（2MB）—— backup 上限 1MB，给点余量；其他路由远小于此。
const MAX_REQUEST_BODY: usize = 2 * 1024 * 1024;

/// 构建主 Router，main.rs 和 integration tests 共用。
pub fn build_router(state: AppState) -> Router {
    let cors = build_cors_layer();

    Router::new()
        // Auth
        .route("/api/auth/request-login", post(auth::request_login))
        .route("/auth/verify", get(auth::verify_login))
        .route("/api/auth/logout", post(auth::logout))
        // Backup
        .route("/api/backup", get(backup::list_backups))
        .route("/api/backup/:kind", put(backup::upload_backup))
        .route("/api/backup/:kind", get(backup::download_backup))
        .route("/api/backup/:kind", delete(backup::delete_backup))
        .route("/api/backup/:kind/versions", get(backup::list_versions))
        .route(
            "/api/backup/:kind/restore/:version_id",
            post(backup::restore_version),
        )
        // Sessions (device management)
        .route("/api/sessions", get(sessions::list_sessions))
        .route("/api/sessions/:id", delete(sessions::revoke_session))
        // Public invites (F)
        .route("/api/invites", post(invites::create_invite))
        .route("/api/invites", get(invites::list_invites))
        .route("/api/invites/:slug/payload", get(invites::consume_invite))
        .route("/api/invites/:slug", delete(invites::revoke_invite))
        .route("/invite/:slug", get(invites::get_invite_meta))
        // Cross-mesh bridges (G)
        .route("/api/bridges", get(bridges::list_bridges))
        .route("/api/bridges/invites", post(bridges::create_bridge_invite))
        .route("/api/bridges/redeem", post(bridges::redeem_bridge))
        .route("/api/bridges/accept", post(bridges::accept_bridge))
        .route("/api/bridges/:id", delete(bridges::revoke_bridge))
        // TOTP
        .route("/api/totp/setup", post(totp::setup))
        .route("/api/totp/verify", post(totp::verify))
        .route("/api/totp", delete(totp::disable))
        .route("/api/totp/status", get(totp::status))
        // Updates
        .route("/api/updates/latest.json", get(updates::latest_json))
        .route("/api/updates/pubkey", get(updates::pubkey))
        // Webhooks
        .route("/api/webhooks/github", post(webhooks::github))
        // Admin (require_admin 中间件由路由 handler 内部调)
        .route("/api/admin/users", get(admin_routes::list_users))
        .route(
            "/api/admin/users/:id/revoke-all-sessions",
            post(admin_routes::revoke_all_sessions),
        )
        .route("/api/admin/users/:id", delete(admin_routes::delete_user))
        .route("/api/admin/audit", get(admin_routes::list_audit))
        // Observability
        .route("/metrics", get(metrics::metrics))
        .route("/health", get(|| async { "ok" }))
        // Middleware (注意顺序：里面的先执行)
        .layer(RequestBodyLimitLayer::new(MAX_REQUEST_BODY))
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state)
}

/// 构造 CORS layer —— prod 收紧到 KITE_ALLOWED_ORIGINS 配置的列表。
/// 未配置（dev）保留 permissive；配置后只放白名单 origin。
fn build_cors_layer() -> CorsLayer {
    let origins_env = std::env::var("KITE_ALLOWED_ORIGINS").unwrap_or_default();
    if origins_env.trim().is_empty() {
        // Dev 默认：放行所有（方便本地调）
        return CorsLayer::permissive();
    }

    let origins: Vec<HeaderValue> = origins_env
        .split(',')
        .filter_map(|s| s.trim().parse::<HeaderValue>().ok())
        .collect();

    if origins.is_empty() {
        tracing::warn!("KITE_ALLOWED_ORIGINS 设了但无合法 origin —— fallback 到 permissive");
        return CorsLayer::permissive();
    }

    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            header::COOKIE,
            header::ACCEPT,
        ])
        .allow_credentials(true)
        .max_age(std::time::Duration::from_secs(3600))
}

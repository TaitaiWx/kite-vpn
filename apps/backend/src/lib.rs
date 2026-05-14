//! Lib 入口 — 重导出所有模块，让 integration tests 能 `use kite_backend::*`。

pub mod admin;
pub mod auth;
pub mod backup;
pub mod bridges;
pub mod db;
pub mod error;
pub mod invites;
pub mod mailer;
pub mod nebula;
pub mod state;
pub mod updates;

use axum::{
    routing::{delete, get, post, put},
    Router,
};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use crate::state::AppState;

/// 构建主 Router，main.rs 和 integration tests 共用。
pub fn build_router(state: AppState) -> Router {
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
        // Updates (Tauri auto-updater 主 endpoint，副 endpoint 是 GitHub Releases)
        .route("/api/updates/latest.json", get(updates::latest_json))
        .route("/api/updates/pubkey", get(updates::pubkey))
        // Health
        .route("/health", get(|| async { "ok" }))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state)
}

//! Lib 入口 — 重导出所有模块，让 integration tests 能 `use kite_backend::*`。

pub mod auth;
pub mod backup;
pub mod db;
pub mod error;
pub mod mailer;
pub mod state;

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
        // Health
        .route("/health", get(|| async { "ok" }))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state)
}

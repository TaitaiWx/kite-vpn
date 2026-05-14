//! Prometheus /metrics endpoint —— 文本格式手写（不依赖 prometheus crate）。
//!
//! 暴露关键运维指标：
//!   kite_users_total                 累计用户数
//!   kite_users_admin_total           admin 数
//!   kite_sessions_active             当前有效 session 数
//!   kite_backups_total{kind="..."}   每种 backup 数量
//!   kite_invites_total{state="..."}  invite 数（active / consumed / expired）
//!   kite_bridges_total{status="..."} bridge 数（pending / active / revoked）
//!   kite_audit_events_total          audit log 累计行数
//!
//! 注意：这是同步快照（每次拉一次跑 SELECT count）。低 QPS 自托管够用了。
//! 高 QPS 场景应该走 OpenTelemetry / exemplar histogram。

use axum::{
    extract::State,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::Utc;
use sqlx::Row;

use crate::state::AppState;

pub async fn metrics(State(state): State<AppState>) -> Response {
    let now = Utc::now().timestamp_millis();
    let mut out = String::with_capacity(1024);

    let users: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);
    let admins: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE is_admin = 1")
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions WHERE expires_at > ?")
        .bind(now)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);
    let audit_total: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log")
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);

    writeln!(&mut out, "# HELP kite_users_total total registered users").ok();
    writeln!(&mut out, "# TYPE kite_users_total gauge").ok();
    writeln!(&mut out, "kite_users_total {}", users).ok();

    writeln!(&mut out, "# HELP kite_users_admin_total admin users").ok();
    writeln!(&mut out, "# TYPE kite_users_admin_total gauge").ok();
    writeln!(&mut out, "kite_users_admin_total {}", admins).ok();

    writeln!(&mut out, "# HELP kite_sessions_active currently active sessions").ok();
    writeln!(&mut out, "# TYPE kite_sessions_active gauge").ok();
    writeln!(&mut out, "kite_sessions_active {}", sessions).ok();

    // Backups by kind
    writeln!(&mut out, "# HELP kite_backups_total backups per kind").ok();
    writeln!(&mut out, "# TYPE kite_backups_total gauge").ok();
    if let Ok(rows) = sqlx::query("SELECT kind, count(*) AS c FROM backups GROUP BY kind")
        .fetch_all(&state.db)
        .await
    {
        for row in rows {
            let kind: String = row.get("kind");
            let count: i64 = row.get("c");
            writeln!(&mut out, "kite_backups_total{{kind=\"{}\"}} {}", kind, count).ok();
        }
    }

    // Invites by state
    writeln!(&mut out, "# HELP kite_invites_total invites by state").ok();
    writeln!(&mut out, "# TYPE kite_invites_total gauge").ok();
    let active_invites: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM public_invites WHERE consumed_at IS NULL AND expires_at > ?",
    )
    .bind(now)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);
    let consumed_invites: i64 =
        sqlx::query_scalar("SELECT count(*) FROM public_invites WHERE consumed_at IS NOT NULL")
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);
    let expired_invites: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM public_invites WHERE consumed_at IS NULL AND expires_at <= ?",
    )
    .bind(now)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);
    writeln!(&mut out, "kite_invites_total{{state=\"active\"}} {}", active_invites).ok();
    writeln!(&mut out, "kite_invites_total{{state=\"consumed\"}} {}", consumed_invites).ok();
    writeln!(&mut out, "kite_invites_total{{state=\"expired\"}} {}", expired_invites).ok();

    // Bridges by status
    writeln!(&mut out, "# HELP kite_bridges_total bridges by status").ok();
    writeln!(&mut out, "# TYPE kite_bridges_total gauge").ok();
    if let Ok(rows) =
        sqlx::query("SELECT status, count(*) AS c FROM cross_mesh_bridges GROUP BY status")
            .fetch_all(&state.db)
            .await
    {
        for row in rows {
            let status: String = row.get("status");
            let count: i64 = row.get("c");
            writeln!(&mut out, "kite_bridges_total{{status=\"{}\"}} {}", status, count).ok();
        }
    }

    writeln!(&mut out, "# HELP kite_audit_events_total cumulative audit log rows").ok();
    writeln!(&mut out, "# TYPE kite_audit_events_total counter").ok();
    writeln!(&mut out, "kite_audit_events_total {}", audit_total).ok();

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        out,
    )
        .into_response()
}

// helper macro
use std::fmt::Write;

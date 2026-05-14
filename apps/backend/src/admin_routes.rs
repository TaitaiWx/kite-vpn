//! Admin-only 路由 —— 列用户 / 强制注销某用户 / 查 audit log。
//!
//! 都先过 require_admin 中间件。普通用户 403。

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::{
    admin::require_admin,
    audit,
    auth::extract_user,
    error::{AppError, AppResult},
    state::AppState,
};

// ─── GET /api/admin/users ───────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct AdminUserRow {
    pub id: String,
    pub email: String,
    pub is_admin: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub active_sessions: i64,
    pub has_ca_backup: bool,
}

pub async fn list_users(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Vec<AdminUserRow>>> {
    let user = extract_user(&state, &headers).await?;
    require_admin(&state, &user).await?;

    let now = Utc::now().timestamp_millis();
    let rows = sqlx::query(
        r#"
        SELECT
          u.id,
          u.email,
          u.is_admin,
          u.created_at,
          u.updated_at,
          (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS active_sessions,
          (SELECT count(*) FROM backups b WHERE b.user_id = u.id AND b.kind = 'ca-key') AS has_ca_backup
        FROM users u
        ORDER BY u.created_at DESC
        "#,
    )
    .bind(now)
    .fetch_all(&state.db)
    .await?;

    let out: Vec<AdminUserRow> = rows
        .into_iter()
        .map(|r| AdminUserRow {
            id: r.get("id"),
            email: r.get("email"),
            is_admin: r.get::<i64, _>("is_admin") != 0,
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
            active_sessions: r.get("active_sessions"),
            has_ca_backup: r.get::<i64, _>("has_ca_backup") != 0,
        })
        .collect();
    Ok(Json(out))
}

// ─── POST /api/admin/users/:id/revoke-all-sessions ──────────────────────────

pub async fn revoke_all_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(target_user_id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let user = extract_user(&state, &headers).await?;
    require_admin(&state, &user).await?;

    let now = Utc::now().timestamp_millis();
    let result = sqlx::query("UPDATE sessions SET expires_at = ? WHERE user_id = ?")
        .bind(now - 1)
        .bind(&target_user_id)
        .execute(&state.db)
        .await?;

    audit::record_with_metadata(
        &state.db,
        audit::AuditEvent {
            actor_user_id: Some(&user.user_id),
            actor_email: &user.email,
            actor_ip: "",
            event_type: "admin.revoke_all_sessions",
            target_kind: "user",
            target_id: &target_user_id,
        },
        serde_json::json!({"affected": result.rows_affected()}),
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

// ─── DELETE /api/admin/users/:id ────────────────────────────────────────────
// 删用户 = 级联删 sessions / backups / invites / bridges（外键 ON DELETE CASCADE）。

pub async fn delete_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(target_user_id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let user = extract_user(&state, &headers).await?;
    require_admin(&state, &user).await?;

    if target_user_id == user.user_id {
        return Err(AppError::BadRequest("admin 不能删自己".into()));
    }

    // 拿 target email 写 audit
    let target: Option<(String,)> = sqlx::query_as("SELECT email FROM users WHERE id = ?")
        .bind(&target_user_id)
        .fetch_optional(&state.db)
        .await?;
    let target_email = target.map(|t| t.0).unwrap_or_default();

    let result = sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(&target_user_id)
        .execute(&state.db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }

    audit::record_with_metadata(
        &state.db,
        audit::AuditEvent {
            actor_user_id: Some(&user.user_id),
            actor_email: &user.email,
            actor_ip: "",
            event_type: "admin.delete_user",
            target_kind: "user",
            target_id: &target_user_id,
        },
        serde_json::json!({"deleted_email": target_email}),
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

// ─── GET /api/admin/audit?limit=100&event=... ───────────────────────────────

#[derive(Debug, Deserialize)]
pub struct AuditQuery {
    pub limit: Option<i64>,
    pub event: Option<String>,
    pub actor_user_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AuditRow {
    pub id: String,
    pub actor_user_id: Option<String>,
    pub actor_email: String,
    pub actor_ip: String,
    pub event_type: String,
    pub target_kind: String,
    pub target_id: String,
    pub metadata_json: String,
    pub created_at: i64,
}

pub async fn list_audit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AuditQuery>,
) -> AppResult<Json<Vec<AuditRow>>> {
    let user = extract_user(&state, &headers).await?;
    require_admin(&state, &user).await?;

    let limit = q.limit.unwrap_or(100).clamp(1, 1000);
    let event_filter = q.event.unwrap_or_default();
    let actor_filter = q.actor_user_id.unwrap_or_default();

    let rows = sqlx::query(
        r#"
        SELECT id, actor_user_id, actor_email, actor_ip, event_type,
               target_kind, target_id, metadata_json, created_at
        FROM audit_log
        WHERE (?1 = '' OR event_type = ?1)
          AND (?2 = '' OR actor_user_id = ?2)
        ORDER BY created_at DESC
        LIMIT ?3
        "#,
    )
    .bind(&event_filter)
    .bind(&actor_filter)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    let out = rows
        .into_iter()
        .map(|r| AuditRow {
            id: r.get("id"),
            actor_user_id: r.get("actor_user_id"),
            actor_email: r.get("actor_email"),
            actor_ip: r.get("actor_ip"),
            event_type: r.get("event_type"),
            target_kind: r.get("target_kind"),
            target_id: r.get("target_id"),
            metadata_json: r.get("metadata_json"),
            created_at: r.get("created_at"),
        })
        .collect();
    Ok(Json(out))
}

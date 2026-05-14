//! Device 管理 —— 看自己 active session + 单点登出。
//!
//! /api/sessions 列当前用户所有未过期 session（每条 = 一台设备 / 一次登录）。
//! DELETE /api/sessions/:id 杀掉指定 session（其他设备马上失效）。

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use serde::Serialize;
use sqlx::Row;

use crate::{
    audit,
    auth::extract_user,
    error::{AppError, AppResult},
    state::AppState,
};

#[derive(Debug, Serialize)]
pub struct SessionRow {
    pub id: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub last_seen_at: i64,
    pub user_agent: String,
    pub is_current: bool,
}

pub async fn list_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Vec<SessionRow>>> {
    let user = extract_user(&state, &headers).await?;
    let now = Utc::now().timestamp_millis();

    // 我们没存 session id 给客户端（cookie 是 raw token），所以 hash 不能反查。
    // 仅展示元数据，并标记"当前会话"=最近 1 秒内 last_seen_at 更新的那条。
    let rows = sqlx::query(
        r#"
        SELECT token_hash, created_at, expires_at, last_seen_at, user_agent
        FROM sessions WHERE user_id = ? AND expires_at > ?
        ORDER BY last_seen_at DESC
        "#,
    )
    .bind(&user.user_id)
    .bind(now)
    .fetch_all(&state.db)
    .await?;

    let out: Vec<SessionRow> = rows
        .into_iter()
        .map(|r| {
            let token_hash: String = r.get("token_hash");
            // 用 hash 前缀做 id（不暴露完整 hash 给客户端，避免某天被滥用比对）
            let id = token_hash
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .take(12)
                .collect::<String>();
            let last_seen: i64 = r.get("last_seen_at");
            SessionRow {
                id,
                created_at: r.get("created_at"),
                expires_at: r.get("expires_at"),
                last_seen_at: last_seen,
                user_agent: r.get("user_agent"),
                is_current: now - last_seen < 1000,
            }
        })
        .collect();
    Ok(Json(out))
}

pub async fn revoke_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let user = extract_user(&state, &headers).await?;
    if session_id.trim().is_empty() {
        return Err(AppError::BadRequest("session_id 不能为空".into()));
    }
    let now = Utc::now().timestamp_millis();

    // 用 hash 前缀（必须是 token_hash 的 ascii 数字字母前 12 字符）找
    let pattern = format!("{}%", session_id);
    let result = sqlx::query(
        r#"
        UPDATE sessions
        SET expires_at = ?
        WHERE user_id = ? AND token_hash LIKE ?
        "#,
    )
    .bind(now - 1)
    .bind(&user.user_id)
    .bind(&pattern)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }

    audit::record(
        &state.db,
        audit::AuditEvent {
            actor_user_id: Some(&user.user_id),
            actor_email: &user.email,
            actor_ip: "",
            event_type: "session.revoke",
            target_kind: "session",
            target_id: &session_id,
        },
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

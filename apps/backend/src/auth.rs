//! 无密码登录：magic link + session cookie。
//!
//! 流程:
//!   POST /auth/request-login  { email }
//!     ↓
//!   后端: 生成 32 字节随机 token，邮件发 https://kite.app/auth/verify?token=<token>
//!     ↓
//!   用户点链接 → GET /auth/verify?token=<token>
//!     ↓
//!   后端: 验证 token + 创建 user（若首次）+ 颁发 session cookie + redirect to /
//!
//! 安全:
//! - magic link token: 32B 随机 + Argon2id hash 后存 DB（防止 DB 泄漏 = 拿到现成 token）
//! - session token: 32B 随机 + Argon2id hash 后存 DB
//! - 用 constant-time 比较防计时攻击
//! - 单次使用：token used_at 一旦写入再次验证失败

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Json,
};
use chrono::Utc;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    state::AppState,
};

// ─── Magic link token 生成 / 哈希 ────────────────────────────────────────

const MAGIC_LINK_TTL_SECS: i64 = 10 * 60;          // 10 分钟
const SESSION_TTL_SECS: i64 = 30 * 24 * 3600;      // 30 天
const TOKEN_BYTES: usize = 32;

/// 生成随机 token + 其 Argon2id hash。token 给用户，hash 存 DB。
fn generate_token_with_hash() -> AppResult<(String, String)> {
    use argon2::{Argon2, PasswordHasher};
    use argon2::password_hash::{SaltString, rand_core::OsRng};

    let mut raw = [0u8; TOKEN_BYTES];
    rand::rngs::OsRng.try_fill_bytes(&mut raw)
        .map_err(|e| AppError::Internal(format!("rand: {}", e)))?;
    let token = base64_url(&raw);

    // 用 Argon2id 哈希 token 本身（不是密码，但能防 DB 泄漏 → 现成 token）
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(token.as_bytes(), &salt)
        .map_err(|e| AppError::Internal(format!("argon2: {}", e)))?
        .to_string();

    Ok((token, hash))
}

fn verify_token_against_hash(token: &str, stored_hash: &str) -> bool {
    use argon2::{Argon2, PasswordHash, PasswordVerifier};

    let parsed = match PasswordHash::new(stored_hash) {
        Ok(p) => p,
        Err(_) => return false,
    };
    Argon2::default()
        .verify_password(token.as_bytes(), &parsed)
        .is_ok()
}

/// URL-safe base64 编码（无 padding）。
fn base64_url(bytes: &[u8]) -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    URL_SAFE_NO_PAD.encode(bytes)
}

// ─── 路由：请求 magic link ──────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct RequestLoginPayload {
    pub email: String,
}

#[derive(Debug, Serialize)]
pub struct RequestLoginResponse {
    /// 始终 true —— 不暴露 "email 不存在" 的差异（防止枚举攻击）
    pub sent: bool,
}

pub async fn request_login(
    State(state): State<AppState>,
    Json(payload): Json<RequestLoginPayload>,
) -> AppResult<Json<RequestLoginResponse>> {
    let email = payload.email.trim().to_lowercase();
    if email.is_empty() || !email.contains('@') {
        return Err(AppError::BadRequest("非法邮箱".into()));
    }

    let (token, hash) = generate_token_with_hash()?;
    let now = Utc::now().timestamp_millis();
    let expires = now + MAGIC_LINK_TTL_SECS * 1000;

    sqlx::query(
        "INSERT INTO magic_links (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)"
    )
    .bind(&hash)
    .bind(&email)
    .bind(now)
    .bind(expires)
    .execute(&state.db)
    .await?;

    let link = format!("{}/auth/verify?token={}", state.config.public_url, token);
    state.mailer.send_magic_link(&email, &link).await?;

    // 一次性清理过期 token（懒清理，避免单独 cron）
    let _ = sqlx::query("DELETE FROM magic_links WHERE expires_at < ?")
        .bind(now)
        .execute(&state.db)
        .await;

    Ok(Json(RequestLoginResponse { sent: true }))
}

// ─── 路由：验证 magic link → 颁发 session ────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct VerifyQuery {
    pub token: String,
}

pub async fn verify_login(
    State(state): State<AppState>,
    Query(q): Query<VerifyQuery>,
) -> AppResult<Response> {
    let token = q.token.trim().to_string();
    if token.is_empty() {
        return Err(AppError::InvalidMagicLink);
    }
    let now = Utc::now().timestamp_millis();

    // 注意: 我们不能直接 WHERE token_hash = ?（Argon2 每次 hash 都不同），
    // 必须把活跃 token 都拉出来 verify。10 分钟 TTL + 单次使用 = 活跃数极少。
    let candidates = sqlx::query(
        "SELECT token_hash, email, expires_at, used_at FROM magic_links WHERE expires_at > ? AND used_at IS NULL"
    )
    .bind(now)
    .fetch_all(&state.db)
    .await?;

    let mut matched_email: Option<String> = None;
    let mut matched_hash: Option<String> = None;
    for row in &candidates {
        let stored_hash: String = row.get("token_hash");
        if verify_token_against_hash(&token, &stored_hash) {
            matched_email = Some(row.get("email"));
            matched_hash = Some(stored_hash);
            break;
        }
    }

    let Some(email) = matched_email else {
        return Err(AppError::InvalidMagicLink);
    };
    let stored_hash = matched_hash.expect("matched email implies matched hash");

    // Burn token（标记已用）
    sqlx::query("UPDATE magic_links SET used_at = ? WHERE token_hash = ?")
        .bind(now)
        .bind(&stored_hash)
        .execute(&state.db)
        .await?;

    // Upsert user
    let user_id = upsert_user_by_email(&state.db, &email, now).await?;

    // 颁发 session
    let (session_token, session_hash) = generate_token_with_hash()?;
    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(&session_hash)
    .bind(&user_id)
    .bind(now)
    .bind(now + SESSION_TTL_SECS * 1000)
    .bind("")
    .bind(now)
    .execute(&state.db)
    .await?;

    // 设置 HttpOnly Secure Cookie
    let cookie = format!(
        "kite_session={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{}",
        session_token,
        SESSION_TTL_SECS,
        if state.config.cookie_secure { "; Secure" } else { "" },
    );

    let mut response: Response = Redirect::to(&state.config.frontend_redirect_url).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        cookie.parse().map_err(|e| AppError::Internal(format!("cookie: {}", e)))?,
    );

    Ok(response)
}

async fn upsert_user_by_email(db: &crate::db::Db, email: &str, now: i64) -> AppResult<String> {
    let existing: Option<(String,)> =
        sqlx::query_as("SELECT id FROM users WHERE email = ?")
            .bind(email)
            .fetch_optional(db)
            .await?;
    if let Some((id,)) = existing {
        sqlx::query("UPDATE users SET updated_at = ? WHERE id = ?")
            .bind(now)
            .bind(&id)
            .execute(db)
            .await?;
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(email)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    Ok(id)
}

// ─── Session 中间件 ─────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: String,
    pub email: String,
}

/// 从请求 header 提取 session cookie，验证并返回 user。
pub async fn extract_user(state: &AppState, headers: &HeaderMap) -> AppResult<AuthUser> {
    let cookie_header = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::Unauthorized)?;

    let token = cookie_header
        .split(';')
        .map(|p| p.trim())
        .find_map(|p| p.strip_prefix("kite_session="))
        .ok_or(AppError::Unauthorized)?;

    let now = Utc::now().timestamp_millis();

    // 同 magic link 验证逻辑：必须把活跃 session 都拉出来比对（Argon2 hash 非确定性）
    let candidates = sqlx::query(
        "SELECT s.token_hash, s.user_id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.expires_at > ?"
    )
    .bind(now)
    .fetch_all(&state.db)
    .await?;

    for row in &candidates {
        let stored_hash: String = row.get("token_hash");
        if verify_token_against_hash(token, &stored_hash) {
            let user_id: String = row.get("user_id");
            let email: String = row.get("email");
            // 更新 last_seen_at（best effort）
            let _ = sqlx::query("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
                .bind(now)
                .bind(&stored_hash)
                .execute(&state.db)
                .await;
            return Ok(AuthUser { user_id, email });
        }
    }

    Err(AppError::Unauthorized)
}

// ─── 路由：登出 ────────────────────────────────────────────────────────

pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<impl IntoResponse> {
    if let Ok(user) = extract_user(&state, &headers).await {
        let now = Utc::now().timestamp_millis();
        // 标记当前 user 所有 session 过期。简单粗暴，但 magic link 流程让登录极便宜。
        sqlx::query("UPDATE sessions SET expires_at = ? WHERE user_id = ?")
            .bind(now - 1)
            .bind(&user.user_id)
            .execute(&state.db)
            .await?;
    }

    let cookie = format!(
        "kite_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}",
        if state.config.cookie_secure { "; Secure" } else { "" },
    );
    let mut response: Response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        cookie.parse().map_err(|e| AppError::Internal(format!("cookie: {}", e)))?,
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_generation_is_unique() {
        let (t1, _) = generate_token_with_hash().unwrap();
        let (t2, _) = generate_token_with_hash().unwrap();
        assert_ne!(t1, t2);
        assert!(t1.len() >= 32);
    }

    #[test]
    fn token_verifies_against_own_hash() {
        let (token, hash) = generate_token_with_hash().unwrap();
        assert!(verify_token_against_hash(&token, &hash));
    }

    #[test]
    fn token_does_not_verify_against_other_hash() {
        let (_t1, hash1) = generate_token_with_hash().unwrap();
        let (t2, _) = generate_token_with_hash().unwrap();
        assert!(!verify_token_against_hash(&t2, &hash1));
    }

    #[test]
    fn token_does_not_verify_against_garbage_hash() {
        let (token, _) = generate_token_with_hash().unwrap();
        assert!(!verify_token_against_hash(&token, "not a real hash"));
    }
}

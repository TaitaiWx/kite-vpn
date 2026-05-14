//! TOTP 二次验证（Google Authenticator / 1Password / Authy 兼容）。
//!
//! 流程：
//!   1. POST /api/totp/setup  → 生成 secret + otpauth URI（含 QR 数据）
//!      DB: 写入待验证记录（verified_at = NULL）
//!   2. POST /api/totp/verify { code }  → 验当前 6 位码
//!      首次成功 → 把 verified_at 写上，TOTP 激活
//!      之后调 verify 仅供敏感操作前的 step-up
//!   3. DELETE /api/totp  → 关闭 2FA（需要先 verify 一次防误删）
//!
//! 实际"何时强制要求 TOTP"留给上层路由决定（v1 仅暴露 setup/verify/disable，
//! 不强制注入到任何路径；v0.3 用 `require_totp_verified` middleware 给特定
//! 敏感操作加二次验证）。

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::{
    audit,
    auth::extract_user,
    error::{AppError, AppResult},
    state::AppState,
};

const TOTP_DIGITS: usize = 6;
const TOTP_PERIOD: u64 = 30;
#[cfg(test)]
const TOTP_SECRET_BYTES: usize = 20; // SHA1, Google Authenticator 默认

// ─── POST /api/totp/setup ──────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct TotpSetupResponse {
    pub secret_base32: String,
    /// otpauth://totp/Kite:user@example.com?secret=...&issuer=Kite
    pub otpauth_uri: String,
    pub algorithm: String,
    pub digits: usize,
    pub period_seconds: u64,
}

pub async fn setup(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<TotpSetupResponse>> {
    let user = extract_user(&state, &headers).await?;

    // 已激活 → 拒绝重新 setup（先 disable）
    let existing: Option<(Option<i64>,)> =
        sqlx::query_as("SELECT verified_at FROM totp_credentials WHERE user_id = ?")
            .bind(&user.user_id)
            .fetch_optional(&state.db)
            .await?;
    if let Some((Some(_),)) = existing {
        return Err(AppError::BadRequest(
            "TOTP 已激活 —— 先 DELETE /api/totp 关闭后再 setup".into(),
        ));
    }

    // 生成 20 字节随机 secret
    let secret_bytes = totp_rs::Secret::generate_secret().to_bytes().map_err(|e| {
        AppError::Internal(format!("生成 TOTP secret 失败: {}", e))
    })?;

    // upsert: pending（未验证）
    let now = Utc::now().timestamp_millis();
    sqlx::query(
        r#"
        INSERT INTO totp_credentials
            (user_id, secret, digits, period_seconds, algorithm, verified_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'SHA1', NULL, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            secret = excluded.secret,
            verified_at = NULL,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(&user.user_id)
    .bind(&secret_bytes)
    .bind(TOTP_DIGITS as i64)
    .bind(TOTP_PERIOD as i64)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;

    let totp = build_totp(&secret_bytes, &user.email)?;
    let otpauth_uri = totp.get_url();
    let secret_base32 = totp.get_secret_base32();

    Ok(Json(TotpSetupResponse {
        secret_base32,
        otpauth_uri,
        algorithm: "SHA1".into(),
        digits: TOTP_DIGITS,
        period_seconds: TOTP_PERIOD,
    }))
}

// ─── POST /api/totp/verify ─────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct VerifyRequest {
    pub code: String,
}

#[derive(Debug, Serialize)]
pub struct VerifyResponse {
    pub verified: bool,
    pub activated_now: bool,
}

pub async fn verify(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<VerifyRequest>,
) -> AppResult<Json<VerifyResponse>> {
    let user = extract_user(&state, &headers).await?;
    let code = req.code.trim().to_string();
    if code.is_empty() {
        return Err(AppError::BadRequest("code 不能为空".into()));
    }

    let row = sqlx::query("SELECT secret, verified_at FROM totp_credentials WHERE user_id = ?")
        .bind(&user.user_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    let secret: Vec<u8> = row.get("secret");
    let previously_verified: Option<i64> = row.get("verified_at");

    let totp = build_totp(&secret, &user.email)?;
    let now_unix = (Utc::now().timestamp_millis() / 1000) as u64;
    let valid = totp
        .check(&code, now_unix);

    if !valid {
        return Err(AppError::Unauthorized);
    }

    let mut activated_now = false;
    if previously_verified.is_none() {
        let now = Utc::now().timestamp_millis();
        sqlx::query("UPDATE totp_credentials SET verified_at = ?, updated_at = ? WHERE user_id = ?")
            .bind(now)
            .bind(now)
            .bind(&user.user_id)
            .execute(&state.db)
            .await?;
        activated_now = true;
        audit::record(
            &state.db,
            audit::AuditEvent {
                actor_user_id: Some(&user.user_id),
                actor_email: &user.email,
                actor_ip: "",
                event_type: "totp.activated",
                target_kind: "user",
                target_id: &user.user_id,
            },
        )
        .await;
    }

    Ok(Json(VerifyResponse {
        verified: true,
        activated_now,
    }))
}

// ─── DELETE /api/totp ─────────────────────────────────────────────────────

pub async fn disable(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<VerifyRequest>,
) -> AppResult<impl IntoResponse> {
    // 关闭前要求验证一次（防误删 / 防被攻击者借登录态删 2FA）
    let _ = verify(State(state.clone()), headers.clone(), Json(req)).await?;
    let user = extract_user(&state, &headers).await?;
    sqlx::query("DELETE FROM totp_credentials WHERE user_id = ?")
        .bind(&user.user_id)
        .execute(&state.db)
        .await?;
    audit::record(
        &state.db,
        audit::AuditEvent {
            actor_user_id: Some(&user.user_id),
            actor_email: &user.email,
            actor_ip: "",
            event_type: "totp.disabled",
            target_kind: "user",
            target_id: &user.user_id,
        },
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

// ─── GET /api/totp/status ─────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct TotpStatus {
    pub configured: bool,
    pub activated: bool,
}

pub async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<TotpStatus>> {
    let user = extract_user(&state, &headers).await?;
    let row: Option<(Option<i64>,)> =
        sqlx::query_as("SELECT verified_at FROM totp_credentials WHERE user_id = ?")
            .bind(&user.user_id)
            .fetch_optional(&state.db)
            .await?;
    let (configured, activated) = match row {
        Some((Some(_),)) => (true, true),
        Some((None,)) => (true, false),
        None => (false, false),
    };
    Ok(Json(TotpStatus {
        configured,
        activated,
    }))
}

// ─── 内部 helper ───────────────────────────────────────────────────────────

fn build_totp(secret: &[u8], email: &str) -> AppResult<totp_rs::TOTP> {
    totp_rs::TOTP::new(
        totp_rs::Algorithm::SHA1,
        TOTP_DIGITS,
        1, // skew=1 (前后各放 1 个 period 容差，覆盖时钟漂移)
        TOTP_PERIOD,
        secret.to_vec(),
        Some("Kite".to_string()),
        email.to_string(),
    )
    .map_err(|e| AppError::Internal(format!("构造 TOTP 失败: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_totp_with_valid_input_succeeds() {
        let secret = vec![0u8; TOTP_SECRET_BYTES];
        let totp = build_totp(&secret, "test@example.com").unwrap();
        let uri = totp.get_url();
        assert!(uri.starts_with("otpauth://totp/"));
        assert!(uri.contains("issuer=Kite"));
    }

    #[test]
    fn totp_with_zero_secret_generates_consistent_codes() {
        let secret = vec![0u8; TOTP_SECRET_BYTES];
        let totp = build_totp(&secret, "x@example.com").unwrap();
        // 同一时刻生成 / 验证应一致
        let now = 1_700_000_000u64;
        let code = totp.generate(now);
        assert!(totp.check(&code, now));
        // 改一位应失败
        let mut bad = code.clone();
        let chars: Vec<char> = bad.chars().collect();
        let first = chars[0];
        let new_first = if first == '0' { '1' } else { '0' };
        bad.replace_range(0..1, &new_first.to_string());
        assert!(!totp.check(&bad, now));
    }
}

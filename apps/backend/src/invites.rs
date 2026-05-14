//! 公网邀请链接 (F 功能) —— Owner 把"加入我的 Mesh"做成一个公网可访问的 URL。
//!
//! 流程：
//!   Owner 客户端: 用 passphrase + Argon2 派生 key → AES-GCM 加密 enrollment payload (Nebula cert + key)
//!                  POST /api/invites { encrypted_payload_b64, peer_name_hint, ttl_hours, network_id }
//!                  → 后端返回 { slug, public_url, expires_at }
//!   Owner: 把 public_url + passphrase 分两渠道发给受邀人（passphrase 永远不进 backend）
//!
//!   受邀人: 浏览器打开 https://kite.example.com/invite/<slug>
//!           → 看到落地页 "Open in Kite"（一个 deep link）
//!           → Kite 客户端: 自动 fetch /api/invites/<slug>/payload → 拿到 ciphertext
//!           → UI 提示输入 passphrase → 本地解密 → 装 Nebula cert → 加入网络
//!
//! 设计原则:
//! - passphrase 永远不上传（同 backup 的零知识架构）
//! - slug 短易记（6 字符 base32），URL 友好
//! - 单次消费（consumed_at 写入即烧）
//! - 默认 7 天过期，可配（最长 30 天）
//! - 后端只做中转 + 限期，看不见任何明文

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use base64::Engine;
use chrono::Utc;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    auth::extract_user,
    error::{AppError, AppResult},
    state::AppState,
};

const MAX_PAYLOAD_BYTES: usize = 64 * 1024; // 64KB 足够装一个 Nebula enrollment
const DEFAULT_TTL_HOURS: i64 = 24 * 7;
const MAX_TTL_HOURS: i64 = 24 * 30;
const SLUG_LENGTH: usize = 6;
// base32 字符表（去掉容易看错的 0/O/1/I）—— Crockford 风格
const SLUG_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTVWXYZ";

#[derive(Debug, Deserialize)]
pub struct CreateInvitePayload {
    /// base64-encoded AES-GCM ciphertext（含 nonce + tag），客户端用 passphrase 加密
    pub encrypted_payload_b64: String,
    /// 网络的 CA fingerprint —— 用于 UI 显示是哪个 mesh
    pub network_id: String,
    /// UI 显示用，便于 owner 区分发出去的多个 invite
    pub peer_name_hint: String,
    /// 有效期（小时），1..720（30 天）。可省略，默认 7 天
    pub ttl_hours: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct CreateInviteResponse {
    pub slug: String,
    pub public_url: String,
    pub expires_at: i64,
}

pub async fn create_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateInvitePayload>,
) -> AppResult<Json<CreateInviteResponse>> {
    let user = extract_user(&state, &headers).await?;

    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(payload.encrypted_payload_b64.trim())
        .map_err(|e| AppError::BadRequest(format!("encrypted_payload_b64 非合法 base64: {}", e)))?;
    if ciphertext.is_empty() {
        return Err(AppError::BadRequest("encrypted_payload 不能为空".into()));
    }
    if ciphertext.len() > MAX_PAYLOAD_BYTES {
        return Err(AppError::BadRequest(format!(
            "encrypted_payload 超限 ({} > {} 字节)",
            ciphertext.len(),
            MAX_PAYLOAD_BYTES
        )));
    }
    if payload.network_id.trim().is_empty() {
        return Err(AppError::BadRequest("network_id 不能为空".into()));
    }
    let ttl_hours = payload.ttl_hours.unwrap_or(DEFAULT_TTL_HOURS);
    if !(1..=MAX_TTL_HOURS).contains(&ttl_hours) {
        return Err(AppError::BadRequest(format!(
            "ttl_hours 必须 1..={}",
            MAX_TTL_HOURS
        )));
    }

    let now = Utc::now().timestamp_millis();
    let expires_at = now + ttl_hours * 3600 * 1000;
    let id = Uuid::new_v4().to_string();
    let token = generate_internal_token();
    let slug = generate_unique_slug(&state.db).await?;

    sqlx::query(
        r#"
        INSERT INTO public_invites
            (token, owner_user_id, network_id, encrypted_payload, peer_name_hint,
             expires_at, created_at, slug)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&token)
    .bind(&user.user_id)
    .bind(&payload.network_id)
    .bind(&ciphertext)
    .bind(&payload.peer_name_hint)
    .bind(expires_at)
    .bind(now)
    .bind(&slug)
    .execute(&state.db)
    .await?;

    let _ = id; // id 在 schema 里是 PK token，这里多保留一个 internal id 没必要

    let public_url = format!("{}/invite/{}", state.config.public_url, slug);
    Ok(Json(CreateInviteResponse {
        slug,
        public_url,
        expires_at,
    }))
}

#[derive(Debug, Serialize)]
pub struct InviteMeta {
    pub slug: String,
    pub network_id: String,
    pub peer_name_hint: String,
    pub expires_at: i64,
    pub consumed: bool,
}

/// GET /invite/:slug — 公网可访问，无需登录。返回 invite 元信息（不含密文）。
/// 用途：浏览器打开时给个落地页能看到"是谁邀请你"。
pub async fn get_invite_meta(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> AppResult<Json<InviteMeta>> {
    let now = Utc::now().timestamp_millis();
    let row = sqlx::query(
        "SELECT slug, network_id, peer_name_hint, expires_at, consumed_at FROM public_invites WHERE slug = ? AND expires_at > ?"
    )
    .bind(&slug)
    .bind(now)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    Ok(Json(InviteMeta {
        slug: row.get("slug"),
        network_id: row.get("network_id"),
        peer_name_hint: row.get("peer_name_hint"),
        expires_at: row.get("expires_at"),
        consumed: row.get::<Option<i64>, _>("consumed_at").is_some(),
    }))
}

#[derive(Debug, Serialize)]
pub struct InvitePayloadResponse {
    pub encrypted_payload_b64: String,
    pub network_id: String,
}

/// GET /api/invites/:slug/payload — 客户端拿密文准备解密。
/// 标记 consumed（一次性烧），后续请求 404。
pub async fn consume_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> AppResult<Json<InvitePayloadResponse>> {
    let now = Utc::now().timestamp_millis();
    // 记录 consumer 邮箱（如果登录了）—— 不强制登录，匿名访问也能消费
    let consumer_email = extract_user(&state, &headers)
        .await
        .ok()
        .map(|u| u.email);

    let row = sqlx::query(
        "SELECT token, encrypted_payload, network_id, consumed_at FROM public_invites WHERE slug = ? AND expires_at > ?"
    )
    .bind(&slug)
    .bind(now)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    let consumed: Option<i64> = row.get("consumed_at");
    if consumed.is_some() {
        return Err(AppError::Forbidden);
    }

    let token: String = row.get("token");
    let ciphertext: Vec<u8> = row.get("encrypted_payload");
    let network_id: String = row.get("network_id");

    sqlx::query("UPDATE public_invites SET consumed_at = ?, consumer_email = ? WHERE token = ?")
        .bind(now)
        .bind(&consumer_email.unwrap_or_default())
        .bind(&token)
        .execute(&state.db)
        .await?;

    Ok(Json(InvitePayloadResponse {
        encrypted_payload_b64: base64::engine::general_purpose::STANDARD.encode(&ciphertext),
        network_id,
    }))
}

#[derive(Debug, Serialize)]
pub struct InviteRow {
    pub slug: String,
    pub network_id: String,
    pub peer_name_hint: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub consumed_at: Option<i64>,
    pub consumer_email: Option<String>,
}

/// GET /api/invites — 当前用户所有 invite（管理面板用）。
pub async fn list_invites(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Vec<InviteRow>>> {
    let user = extract_user(&state, &headers).await?;
    let rows = sqlx::query(
        "SELECT slug, network_id, peer_name_hint, created_at, expires_at, consumed_at, consumer_email FROM public_invites WHERE owner_user_id = ? ORDER BY created_at DESC"
    )
    .bind(&user.user_id)
    .fetch_all(&state.db)
    .await?;
    let out = rows
        .into_iter()
        .map(|r| InviteRow {
            slug: r.get("slug"),
            network_id: r.get("network_id"),
            peer_name_hint: r.get("peer_name_hint"),
            created_at: r.get("created_at"),
            expires_at: r.get("expires_at"),
            consumed_at: r.get("consumed_at"),
            consumer_email: r
                .get::<Option<String>, _>("consumer_email")
                .filter(|s| !s.is_empty()),
        })
        .collect();
    Ok(Json(out))
}

/// DELETE /api/invites/:slug — owner 撤销未消费的 invite。
pub async fn revoke_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> AppResult<impl IntoResponse> {
    let user = extract_user(&state, &headers).await?;
    let result = sqlx::query("DELETE FROM public_invites WHERE slug = ? AND owner_user_id = ?")
        .bind(&slug)
        .bind(&user.user_id)
        .execute(&state.db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

// ─── 内部辅助 ───────────────────────────────────────────────────────────────

fn generate_internal_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

async fn generate_unique_slug(db: &sqlx::SqlitePool) -> AppResult<String> {
    // 最多重试 10 次（碰撞概率极低，30^6 ≈ 7.29 亿）
    for _ in 0..10 {
        let slug = random_slug();
        let exists: Option<(String,)> =
            sqlx::query_as("SELECT slug FROM public_invites WHERE slug = ?")
                .bind(&slug)
                .fetch_optional(db)
                .await?;
        if exists.is_none() {
            return Ok(slug);
        }
    }
    Err(AppError::Internal("slug 生成连续碰撞 —— 几乎不可能发生".into()))
}

fn random_slug() -> String {
    let mut rng = rand::thread_rng();
    (0..SLUG_LENGTH)
        .map(|_| {
            let idx = rng.gen_range(0..SLUG_ALPHABET.len());
            SLUG_ALPHABET[idx] as char
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_has_expected_length_and_alphabet() {
        for _ in 0..100 {
            let s = random_slug();
            assert_eq!(s.len(), SLUG_LENGTH);
            for ch in s.chars() {
                assert!(SLUG_ALPHABET.contains(&(ch as u8)));
            }
        }
    }

    #[test]
    fn slug_is_random() {
        let a = random_slug();
        let b = random_slug();
        // 6 字符 base32：碰撞概率 ≈ 1/729M，连续两次相等几乎不可能
        assert_ne!(a, b);
    }

    #[test]
    fn internal_token_is_long_enough() {
        let t = generate_internal_token();
        assert!(t.len() >= 32);
    }
}

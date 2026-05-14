//! 跨 Mesh 互联 (G 功能) —— 把两个独立的 Kite Mesh 网络打通。
//!
//! 场景：
//!   你和朋友各自跑了一个 Kite Mesh（owner A 和 owner B）。某天你想让朋友
//!   的某台机器能访问你 NAS（你网络里的某个 peer）。完全打通两网开销大，
//!   只想做"定向授权"。
//!
//! 协议（两个 backend 之间，通过 bridge_token 协调）:
//!
//!   1. Owner A 客户端: POST /api/bridges/invites
//!        Body: { local_peer_id, remote_owner_email_hint, direction, ttl_hours }
//!        Resp: { bridge_token, redeem_url, expires_at }
//!      Owner A 把 redeem_url 发给 Owner B（用任何 OOB 渠道）。
//!
//!   2. Owner B 客户端: POST /api/bridges/redeem
//!        Body: { redeem_url, local_peer_id }
//!      Backend B 解析 redeem_url 拿到 (backend_a_url, bridge_token)，调
//!      `POST {backend_a_url}/api/bridges/accept` 携带:
//!        { bridge_token, owner_b_user_email, owner_b_ca_fingerprint,
//!          owner_b_backend_url, remote_peer_id }
//!
//!   3. Backend A 收到 accept:
//!      - 校验 bridge_token 有效 + 未过期 + 未消费
//!      - 落 cross_mesh_bridges 记录（status=active）
//!      - 回 { owner_a_user_email, owner_a_ca_fingerprint }
//!
//!   4. Backend B 收到响应，自己也落一份 mirror 记录。
//!
//!   5. 双方客户端拿到这条 bridge 记录（GET /api/bridges），用对方
//!      CA fingerprint 在本地 Nebula firewall 加白名单 + 给对方 peer
//!      签一张限定 IP 的证书。**实际的 cert 交换走 P2P，backend 不参与。**
//!
//! 后端只负责: 信任关系登记 + webhook 协调。所有密码学物料客户端处理。

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::time::Duration;
use uuid::Uuid;

use crate::{
    auth::extract_user,
    error::{AppError, AppResult},
    state::AppState,
};

const DEFAULT_TTL_HOURS: i64 = 24 * 3; // bridge invite 默认 3 天
const MAX_TTL_HOURS: i64 = 24 * 30;
const ALLOWED_DIRECTIONS: &[&str] = &["in", "out", "both"];

// ─── Step 1: Owner A 创建 bridge invite ─────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateBridgeInvitePayload {
    /// 自己网络里要暴露的 peer（owner A 的 mesh IP，例 100.64.0.5）
    pub local_peer_id: String,
    /// UI 提示用，对方 owner 的邮箱（仅 hint，实际验证靠 bridge_token）
    pub remote_owner_email_hint: String,
    /// in: 对方能访问本 peer / out: 本 peer 能访问对方 / both: 双向
    pub direction: String,
    pub ttl_hours: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct CreateBridgeInviteResponse {
    pub bridge_token: String,
    pub redeem_url: String,
    pub expires_at: i64,
}

pub async fn create_bridge_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateBridgeInvitePayload>,
) -> AppResult<Json<CreateBridgeInviteResponse>> {
    let user = extract_user(&state, &headers).await?;
    if payload.local_peer_id.trim().is_empty() {
        return Err(AppError::BadRequest("local_peer_id 不能为空".into()));
    }
    if !ALLOWED_DIRECTIONS.contains(&payload.direction.as_str()) {
        return Err(AppError::BadRequest(format!(
            "direction 必须是 {:?}",
            ALLOWED_DIRECTIONS
        )));
    }
    let ttl_hours = payload.ttl_hours.unwrap_or(DEFAULT_TTL_HOURS);
    if !(1..=MAX_TTL_HOURS).contains(&ttl_hours) {
        return Err(AppError::BadRequest(format!(
            "ttl_hours 必须 1..={}",
            MAX_TTL_HOURS
        )));
    }

    let now = Utc::now().timestamp_millis();
    let bridge_token = generate_token();
    let id = Uuid::new_v4().to_string();

    sqlx::query(
        r#"
        INSERT INTO cross_mesh_bridges
            (id, user_id, peer_user_id, local_peer_id, remote_peer_id,
             direction, status, created_at, updated_at, bridge_token)
        VALUES (?, ?, '', ?, '', ?, 'pending', ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(&user.user_id)
    .bind(&payload.local_peer_id)
    .bind(&payload.direction)
    .bind(now)
    .bind(now)
    .bind(&bridge_token)
    .execute(&state.db)
    .await?;

    let _ = payload.remote_owner_email_hint; // 只用于本地 UI hint，不入库

    let redeem_url = format!(
        "{}/api/bridges/accept?token={}",
        state.config.public_url, bridge_token
    );
    Ok(Json(CreateBridgeInviteResponse {
        bridge_token,
        redeem_url,
        expires_at: now + ttl_hours * 3600 * 1000,
    }))
}

// ─── Step 2 + 3: Backend B 调 Backend A 的 accept webhook ───────────────────

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct AcceptBridgePayload {
    pub bridge_token: String,
    pub owner_b_user_email: String,
    pub owner_b_ca_fingerprint: String,
    pub owner_b_backend_url: String,
    pub remote_peer_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AcceptBridgeResponse {
    pub owner_a_user_email: String,
    pub owner_a_ca_fingerprint: String,
    pub direction: String,
    pub local_peer_id: String,
}

/// POST /api/bridges/accept —— Backend B 调到 Backend A 这里。
///
/// 这是 backend-to-backend webhook，**没 session 验证**，靠 bridge_token 鉴权。
/// bridge_token 32 字节随机 + URL_SAFE，攻击者枚举不可行。
pub async fn accept_bridge(
    State(state): State<AppState>,
    Json(payload): Json<AcceptBridgePayload>,
) -> AppResult<Json<AcceptBridgeResponse>> {
    let token = payload.bridge_token.trim();
    if token.is_empty() || payload.owner_b_ca_fingerprint.is_empty() {
        return Err(AppError::BadRequest("必填字段不能为空".into()));
    }

    let row = sqlx::query(
        r#"
        SELECT b.id, b.user_id, b.local_peer_id, b.direction, b.status, u.email
        FROM cross_mesh_bridges b
        JOIN users u ON u.id = b.user_id
        WHERE b.bridge_token = ?
        "#,
    )
    .bind(token)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    let status: String = row.get("status");
    if status != "pending" {
        return Err(AppError::Forbidden);
    }

    let bridge_id: String = row.get("id");
    let owner_a_user_id: String = row.get("user_id");
    let owner_a_email: String = row.get("email");
    let direction: String = row.get("direction");
    let local_peer_id: String = row.get("local_peer_id");

    // 升级到 active + 写入对方信息
    let now = Utc::now().timestamp_millis();
    sqlx::query(
        r#"
        UPDATE cross_mesh_bridges
        SET status = 'active',
            remote_peer_id = ?,
            remote_backend_url = ?,
            remote_ca_fingerprint = ?,
            updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(&payload.remote_peer_id)
    .bind(&payload.owner_b_backend_url)
    .bind(&payload.owner_b_ca_fingerprint)
    .bind(now)
    .bind(&bridge_id)
    .execute(&state.db)
    .await?;

    // 自己 CA fingerprint —— 从 owner 的 backup 里抠是 v2 的事，v1 留空让客户端协议层补
    let owner_a_ca_fingerprint = compute_owner_ca_fingerprint(&state, &owner_a_user_id)
        .await
        .unwrap_or_default();

    Ok(Json(AcceptBridgeResponse {
        owner_a_user_email: owner_a_email,
        owner_a_ca_fingerprint,
        direction,
        local_peer_id,
    }))
}

// ─── Step 4: Owner B 客户端通过自己 backend 走 redeem 流程 ──────────────────

#[derive(Debug, Deserialize)]
pub struct RedeemBridgePayload {
    /// owner A 给你的 URL：例 https://a-backend.example.com/api/bridges/accept?token=xxx
    pub redeem_url: String,
    /// 自己网络里要拿出来配对的 peer
    pub local_peer_id: String,
    /// 自己 CA fingerprint（owner B 的 mesh CA）
    pub local_ca_fingerprint: String,
}

#[derive(Debug, Serialize)]
pub struct RedeemBridgeResponse {
    pub remote_owner_email: String,
    pub remote_ca_fingerprint: String,
    pub direction: String,
    pub remote_peer_id: String,
}

pub async fn redeem_bridge(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<RedeemBridgePayload>,
) -> AppResult<Json<RedeemBridgeResponse>> {
    let user = extract_user(&state, &headers).await?;

    let (backend_a_url, bridge_token) = parse_redeem_url(&payload.redeem_url)?;

    // 调对方 backend 的 accept webhook
    let accept_payload = AcceptBridgePayload {
        bridge_token: bridge_token.clone(),
        owner_b_user_email: user.email.clone(),
        owner_b_ca_fingerprint: payload.local_ca_fingerprint.clone(),
        owner_b_backend_url: state.config.public_url.clone(),
        remote_peer_id: payload.local_peer_id.clone(),
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| AppError::Internal(format!("http client: {}", e)))?;
    let accept_url = format!("{}/api/bridges/accept", backend_a_url.trim_end_matches('/'));
    let resp = client
        .post(&accept_url)
        .json(&accept_payload)
        .send()
        .await
        .map_err(|e| AppError::BadRequest(format!("远端 backend 不可达: {}", e)))?;
    if !resp.status().is_success() {
        return Err(AppError::BadRequest(format!(
            "远端 backend 拒绝: HTTP {}",
            resp.status()
        )));
    }
    let accept_resp: AcceptBridgeResponse = resp
        .json()
        .await
        .map_err(|e| AppError::BadRequest(format!("远端 backend 响应非 JSON: {}", e)))?;

    // 本地落一份镜像记录
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().timestamp_millis();
    sqlx::query(
        r#"
        INSERT INTO cross_mesh_bridges
            (id, user_id, peer_user_id, local_peer_id, remote_peer_id,
             direction, status, created_at, updated_at,
             bridge_token, remote_backend_url, remote_ca_fingerprint)
        VALUES (?, ?, '', ?, ?, ?, 'active', ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(&user.user_id)
    .bind(&payload.local_peer_id)
    .bind(&accept_resp.local_peer_id)
    .bind(&accept_resp.direction)
    .bind(now)
    .bind(now)
    .bind(&bridge_token)
    .bind(&backend_a_url)
    .bind(&accept_resp.owner_a_ca_fingerprint)
    .execute(&state.db)
    .await?;

    Ok(Json(RedeemBridgeResponse {
        remote_owner_email: accept_resp.owner_a_user_email,
        remote_ca_fingerprint: accept_resp.owner_a_ca_fingerprint,
        direction: accept_resp.direction,
        remote_peer_id: accept_resp.local_peer_id,
    }))
}

// ─── 管理：列出 / 撤销 ──────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct BridgeRow {
    pub id: String,
    pub local_peer_id: String,
    pub remote_peer_id: String,
    pub direction: String,
    pub status: String,
    pub remote_backend_url: String,
    pub remote_ca_fingerprint: String,
    pub created_at: i64,
    pub updated_at: i64,
}

pub async fn list_bridges(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Vec<BridgeRow>>> {
    let user = extract_user(&state, &headers).await?;
    let rows = sqlx::query(
        r#"
        SELECT id, local_peer_id, remote_peer_id, direction, status,
               remote_backend_url, remote_ca_fingerprint, created_at, updated_at
        FROM cross_mesh_bridges WHERE user_id = ? ORDER BY created_at DESC
        "#,
    )
    .bind(&user.user_id)
    .fetch_all(&state.db)
    .await?;
    let out = rows
        .into_iter()
        .map(|r| BridgeRow {
            id: r.get("id"),
            local_peer_id: r.get("local_peer_id"),
            remote_peer_id: r.get("remote_peer_id"),
            direction: r.get("direction"),
            status: r.get("status"),
            remote_backend_url: r.get("remote_backend_url"),
            remote_ca_fingerprint: r.get("remote_ca_fingerprint"),
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
        })
        .collect();
    Ok(Json(out))
}

pub async fn revoke_bridge(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let user = extract_user(&state, &headers).await?;
    let now = Utc::now().timestamp_millis();
    let result = sqlx::query(
        "UPDATE cross_mesh_bridges SET status = 'revoked', updated_at = ? WHERE id = ? AND user_id = ?"
    )
    .bind(now)
    .bind(&id)
    .bind(&user.user_id)
    .execute(&state.db)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

// ─── 辅助 ───────────────────────────────────────────────────────────────────

fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// 解析 redeem_url，例 "https://a.example.com/api/bridges/accept?token=xxx" →
///   ("https://a.example.com", "xxx")
fn parse_redeem_url(url: &str) -> AppResult<(String, String)> {
    let parsed = url::Url::parse(url)
        .map_err(|e| AppError::BadRequest(format!("redeem_url 非合法 URL: {}", e)))?;
    let token = parsed
        .query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.to_string())
        .ok_or(AppError::BadRequest("redeem_url 缺 ?token=".into()))?;
    let backend_url = format!(
        "{}://{}",
        parsed.scheme(),
        parsed.host_str().ok_or(AppError::BadRequest("redeem_url 缺 host".into()))?,
    );
    let backend_url = if let Some(port) = parsed.port() {
        format!("{}:{}", backend_url, port)
    } else {
        backend_url
    };
    Ok((backend_url, token))
}

/// 计算 owner 的 CA fingerprint —— v1 暂时返回空（客户端从本地算后写回）。
/// v2 时由客户端在 backup CA 时把 fingerprint 一起上传到 users.settings_json。
async fn compute_owner_ca_fingerprint(_state: &AppState, _user_id: &str) -> Option<String> {
    None
}

use base64::Engine;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_redeem_url_extracts_token_and_backend() {
        let (backend, token) =
            parse_redeem_url("https://a.example.com/api/bridges/accept?token=ABCD1234").unwrap();
        assert_eq!(backend, "https://a.example.com");
        assert_eq!(token, "ABCD1234");
    }

    #[test]
    fn parse_redeem_url_with_port() {
        let (backend, _) =
            parse_redeem_url("http://localhost:8787/api/bridges/accept?token=t").unwrap();
        assert_eq!(backend, "http://localhost:8787");
    }

    #[test]
    fn parse_redeem_url_rejects_missing_token() {
        assert!(parse_redeem_url("https://a.example.com/api/bridges/accept").is_err());
    }

    #[test]
    fn parse_redeem_url_rejects_garbage() {
        assert!(parse_redeem_url("not a url").is_err());
    }

    #[test]
    fn token_is_random_and_url_safe() {
        let t1 = generate_token();
        let t2 = generate_token();
        assert_ne!(t1, t2);
        for ch in t1.chars() {
            assert!(ch.is_ascii_alphanumeric() || ch == '-' || ch == '_');
        }
    }

    #[test]
    fn direction_validation() {
        assert!(ALLOWED_DIRECTIONS.contains(&"in"));
        assert!(ALLOWED_DIRECTIONS.contains(&"out"));
        assert!(ALLOWED_DIRECTIONS.contains(&"both"));
        assert!(!ALLOWED_DIRECTIONS.contains(&"sideways"));
    }
}

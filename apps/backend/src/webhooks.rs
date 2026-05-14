//! Webhooks —— GitHub Release 推送时主动赋刷 latest.json cache。
//!
//! 配置：
//!   1. Backend ENV: KITE_GITHUB_WEBHOOK_SECRET=<random secret>
//!   2. GitHub repo settings → Webhooks → Add webhook
//!      Payload URL:  https://kite.example.com/api/webhooks/github
//!      Content type: application/json
//!      Secret:       同上
//!      Events:       Releases only
//!
//! 触发时 GitHub POST 这个 endpoint，header `X-Hub-Signature-256` 含 HMAC-SHA256(secret, body)。
//! 我们验签 → 如果事件是 `release.published` → 调 updates::invalidate_cache() 强制下次客户端
//! 拉时 fresh fetch（而不是等 5min TTL 过期）。

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::Value;
use sha2::Sha256;

use crate::{
    audit,
    error::{AppError, AppResult},
    state::AppState,
    updates,
};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Deserialize)]
pub struct GithubReleaseEvent {
    pub action: String,
    pub release: Option<Value>,
}

pub async fn github(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> AppResult<impl IntoResponse> {
    let secret = std::env::var("KITE_GITHUB_WEBHOOK_SECRET").unwrap_or_default();
    if secret.is_empty() {
        return Err(AppError::Forbidden);
    }
    let signature = headers
        .get("x-hub-signature-256")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !verify_signature(secret.as_bytes(), body.as_bytes(), signature) {
        return Err(AppError::Unauthorized);
    }

    let event: GithubReleaseEvent = serde_json::from_str(&body)
        .map_err(|e| AppError::BadRequest(format!("非法 GitHub event 载荷: {}", e)))?;

    let tag = event
        .release
        .as_ref()
        .and_then(|r| r.get("tag_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if event.action == "published" {
        updates::invalidate_cache().await;
        tracing::info!(tag = %tag, "GitHub release.published → 已 invalidate update cache");
        audit::record_with_metadata(
            &state.db,
            audit::AuditEvent {
                actor_user_id: None,
                actor_email: "github-webhook",
                actor_ip: "",
                event_type: "update.cache_invalidated",
                target_kind: "release",
                target_id: &tag,
            },
            serde_json::json!({"action": event.action}),
        )
        .await;
    }

    Ok(StatusCode::NO_CONTENT)
}

/// 校验 GitHub HMAC-SHA256 签名（X-Hub-Signature-256: sha256=<hex>）。
fn verify_signature(secret: &[u8], body: &[u8], signature_header: &str) -> bool {
    let Some(hex_sig) = signature_header.strip_prefix("sha256=") else {
        return false;
    };
    let Ok(sig_bytes) = hex::decode(hex_sig) else {
        return false;
    };
    let Ok(mut mac) = HmacSha256::new_from_slice(secret) else {
        return false;
    };
    mac.update(body);
    mac.verify_slice(&sig_bytes).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_signature_passes_for_correct_hmac() {
        let secret = b"my-webhook-secret";
        let body = br#"{"action":"published"}"#;
        let mut mac = HmacSha256::new_from_slice(secret).unwrap();
        mac.update(body);
        let expected = mac.finalize().into_bytes();
        let sig_header = format!("sha256={}", hex::encode(expected));
        assert!(verify_signature(secret, body, &sig_header));
    }

    #[test]
    fn verify_signature_fails_for_wrong_secret() {
        let body = br#"{"action":"published"}"#;
        let mut mac = HmacSha256::new_from_slice(b"wrong").unwrap();
        mac.update(body);
        let bad = mac.finalize().into_bytes();
        let sig_header = format!("sha256={}", hex::encode(bad));
        assert!(!verify_signature(b"real-secret", body, &sig_header));
    }

    #[test]
    fn verify_signature_fails_for_tampered_body() {
        let secret = b"s";
        let body = br#"{"a":1}"#;
        let mut mac = HmacSha256::new_from_slice(secret).unwrap();
        mac.update(body);
        let expected = mac.finalize().into_bytes();
        let sig_header = format!("sha256={}", hex::encode(expected));
        assert!(!verify_signature(secret, br#"{"a":2}"#, &sig_header));
    }

    #[test]
    fn verify_signature_rejects_malformed_header() {
        assert!(!verify_signature(b"s", b"body", "garbage"));
        assert!(!verify_signature(b"s", b"body", ""));
        assert!(!verify_signature(b"s", b"body", "sha256=not-hex"));
    }
}

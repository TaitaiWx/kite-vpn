//! Tauri 自动更新 endpoint —— 双 endpoint + ed25519 强签名。
//!
//! Tauri 客户端 `tauri.conf.json` 里 updater.endpoints 是数组，按顺序尝试。
//! 主：你自己的 backend（这个 handler）→ 缓存 / 私有分发 / 紧急 hotfix；
//! 副：GitHub Releases latest.json → 兜底，万一你 backend 挂了用户也能升级。
//!
//! 强签名（防 backend cache 被篡改 / 中间人攻击）:
//! - 启动时从 DB 加载或生成 ed25519 密钥对（update_signing_key 表，单行 PK=1）
//! - 每次响应 latest.json 都用私钥签 body，把 base64 签名放到响应 header
//!   `X-Kite-Signature` 里
//! - 客户端（Phase 6 集成）拿响应 + header，用预置 pubkey 验签
//! - 注意：这是 backend 的 "transport key"，跟 Tauri 内置的 minisign release key
//!   是两套独立的密钥 —— 防御纵深。Minisign 验的是 .tar.gz 二进制本身，我们这
//!   把验的是 latest.json 元数据没被改。
//!
//! ENV:
//!   KITE_UPDATE_SOURCE_URL  上游 latest.json 地址
//!                           默认: https://github.com/TaitaiWx/kite-vpn/releases/latest/download/latest.json
//!   KITE_UPDATE_CACHE_SECS  缓存秒数（默认 300）

use axum::{
    extract::State,
    http::{header, HeaderName, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::Serialize;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use crate::{db::Db, error::{AppError, AppResult}, state::AppState};

const DEFAULT_SOURCE: &str =
    "https://github.com/TaitaiWx/kite-vpn/releases/latest/download/latest.json";
const DEFAULT_CACHE_SECS: u64 = 300;

struct CacheEntry {
    body: String,
    fetched_at: Instant,
}

static CACHE: OnceLock<Mutex<Option<CacheEntry>>> = OnceLock::new();

fn cache() -> &'static Mutex<Option<CacheEntry>> {
    CACHE.get_or_init(|| Mutex::new(None))
}

/// 强制清空 cache —— 由 GitHub webhook 在 release.published 时调用，
/// 保证客户端下次请求拉到最新版（不用等 5min TTL）。
pub async fn invalidate_cache() {
    let mut guard = cache().lock().await;
    *guard = None;
}

/// GET /api/updates/latest.json
///
/// Tauri 期望的 schema (官方文档):
/// {
///   "version": "1.0.2",
///   "notes": "...",
///   "pub_date": "ISO8601",
///   "platforms": {
///     "darwin-x86_64": { "signature": "...", "url": "..." },
///     ...
///   }
/// }
///
/// 我们不解析它，纯透传 —— upstream 是 GitHub 生成的，schema 已经对。
/// 响应附加 X-Kite-Signature header（ed25519 签名 body 的 base64）。
pub async fn latest_json(State(state): State<AppState>) -> Response {
    let source = std::env::var("KITE_UPDATE_SOURCE_URL").unwrap_or_else(|_| DEFAULT_SOURCE.into());
    let cache_secs = std::env::var("KITE_UPDATE_CACHE_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_CACHE_SECS);

    // 先看缓存
    {
        let guard = cache().lock().await;
        if let Some(entry) = guard.as_ref() {
            if entry.fetched_at.elapsed() < Duration::from_secs(cache_secs) {
                return signed_json_response(&state, &entry.body, true).await;
            }
        }
    }

    // miss → 拉源
    let body = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(client) => match client.get(&source).send().await {
            Ok(resp) if resp.status().is_success() => match resp.text().await {
                Ok(text) => text,
                Err(e) => {
                    tracing::warn!(error = %e, "读取 update upstream body 失败");
                    return error_response(StatusCode::BAD_GATEWAY, "upstream read failed");
                }
            },
            Ok(resp) => {
                let status = resp.status();
                tracing::warn!(status = %status, source = %source, "update upstream 非 200");
                return error_response(StatusCode::BAD_GATEWAY, "upstream non-200");
            }
            Err(e) => {
                tracing::warn!(error = %e, source = %source, "请求 update upstream 失败");
                // 回落到旧缓存（哪怕过期），强过让客户端完全升不了
                let guard = cache().lock().await;
                if let Some(entry) = guard.as_ref() {
                    tracing::info!("upstream 失败 —— 回落到过期缓存");
                    return signed_json_response(&state, &entry.body, true).await;
                }
                return error_response(StatusCode::BAD_GATEWAY, "upstream request failed");
            }
        },
        Err(e) => {
            tracing::error!(error = %e, "构造 HTTP client 失败");
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, "client build failed");
        }
    };

    // 写缓存
    {
        let mut guard = cache().lock().await;
        *guard = Some(CacheEntry {
            body: body.clone(),
            fetched_at: Instant::now(),
        });
    }

    signed_json_response(&state, &body, false).await
}

#[derive(Debug, Serialize)]
pub struct PubkeyResponse {
    /// 32 字节 ed25519 公钥 base64
    pub pubkey_b64: String,
    /// 算法（固定 "ed25519"，留扩展位）
    pub algorithm: String,
}

/// GET /api/updates/pubkey —— 客户端首次 bootstrap 拿 transport pubkey。
/// 用 TLS 拿一次，缓存到本地，后续验证 X-Kite-Signature 用。
pub async fn pubkey(State(state): State<AppState>) -> AppResult<Json<PubkeyResponse>> {
    let key = load_or_create_signing_key(&state.db).await?;
    Ok(Json(PubkeyResponse {
        pubkey_b64: base64::engine::general_purpose::STANDARD.encode(key.verifying_key().to_bytes()),
        algorithm: "ed25519".into(),
    }))
}

async fn signed_json_response(state: &AppState, body: &str, from_cache: bool) -> Response {
    let cache_header = if from_cache { "HIT" } else { "MISS" };
    let x_cache: HeaderName = HeaderName::from_static("x-cache");
    let x_sig: HeaderName = HeaderName::from_static("x-kite-signature");

    let signature_b64 = match load_or_create_signing_key(&state.db).await {
        Ok(key) => {
            let sig = key.sign(body.as_bytes());
            base64::engine::general_purpose::STANDARD.encode(sig.to_bytes())
        }
        Err(e) => {
            // 签名失败不阻断更新流程（客户端可选回落到无签名 + GitHub fallback）
            tracing::error!(error = ?e, "签名 latest.json 失败");
            String::new()
        }
    };

    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json"),
            (x_cache, cache_header),
            (x_sig, signature_b64.as_str()),
        ],
        body.to_string(),
    )
        .into_response()
}

// ─── ed25519 密钥持久化 ────────────────────────────────────────────────────

static SIGNING_KEY: OnceLock<Mutex<Option<SigningKey>>> = OnceLock::new();

fn signing_key_cache() -> &'static Mutex<Option<SigningKey>> {
    SIGNING_KEY.get_or_init(|| Mutex::new(None))
}

/// 从 DB 加载 ed25519 密钥；不存在则生成并落盘。**进程内缓存**避免每次 sign 都查 DB。
pub async fn load_or_create_signing_key(db: &Db) -> AppResult<SigningKey> {
    {
        let guard = signing_key_cache().lock().await;
        if let Some(key) = guard.as_ref() {
            return Ok(key.clone());
        }
    }
    let key = load_or_create_uncached(db).await?;
    {
        let mut guard = signing_key_cache().lock().await;
        *guard = Some(key.clone());
    }
    Ok(key)
}

/// 纯 DB 操作版（不走进程缓存）—— 测试用。生产代码请用 `load_or_create_signing_key`。
async fn load_or_create_uncached(db: &Db) -> AppResult<SigningKey> {
    let row: Option<(Vec<u8>, Vec<u8>)> =
        sqlx::query_as("SELECT public_key, private_key FROM update_signing_key WHERE id = 1")
            .fetch_optional(db)
            .await?;

    let key = match row {
        Some((_pub, priv_seed)) => {
            let seed: [u8; 32] = priv_seed
                .try_into()
                .map_err(|_| AppError::Internal("DB 里的 private_key 不是 32 字节".into()))?;
            SigningKey::from_bytes(&seed)
        }
        None => {
            let mut seed = [0u8; 32];
            OsRng.fill_bytes(&mut seed);
            let new_key = SigningKey::from_bytes(&seed);
            let verifying: VerifyingKey = new_key.verifying_key();
            let now = chrono::Utc::now().timestamp_millis();
            sqlx::query(
                "INSERT INTO update_signing_key (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)"
            )
            .bind(verifying.to_bytes().as_slice())
            .bind(seed.as_slice())
            .bind(now)
            .execute(db)
            .await?;
            tracing::info!("生成 ed25519 update signing key 并持久化");
            new_key
        }
    };
    Ok(key)
}

fn error_response(status: StatusCode, msg: &str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        format!(r#"{{"error":"{}"}}"#, msg),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Verifier;

    #[tokio::test]
    async fn cache_starts_empty() {
        let guard = cache().lock().await;
        let _ = guard.as_ref();
    }

    #[tokio::test]
    async fn signing_key_persists_across_loads() {
        let db = crate::db::connect("sqlite::memory:").await.unwrap();
        // 直接走 uncached 路径，避开 process-wide 缓存导致的 test 互相干扰
        let k1 = load_or_create_uncached(&db).await.unwrap();
        let k2 = load_or_create_uncached(&db).await.unwrap();
        assert_eq!(k1.verifying_key().to_bytes(), k2.verifying_key().to_bytes());
    }

    #[tokio::test]
    async fn different_databases_get_different_keys() {
        let db1 = crate::db::connect("sqlite::memory:").await.unwrap();
        let db2 = crate::db::connect("sqlite::memory:").await.unwrap();
        let k1 = load_or_create_uncached(&db1).await.unwrap();
        let k2 = load_or_create_uncached(&db2).await.unwrap();
        assert_ne!(k1.verifying_key().to_bytes(), k2.verifying_key().to_bytes());
    }

    #[tokio::test]
    async fn signed_body_verifies_with_pubkey() {
        let db = crate::db::connect("sqlite::memory:").await.unwrap();
        let key = load_or_create_uncached(&db).await.unwrap();
        let body = r#"{"version":"1.0.2"}"#;
        let sig = key.sign(body.as_bytes());
        assert!(key.verifying_key().verify(body.as_bytes(), &sig).is_ok());
        let tampered = r#"{"version":"1.0.3"}"#;
        assert!(key.verifying_key().verify(tampered.as_bytes(), &sig).is_err());
    }
}

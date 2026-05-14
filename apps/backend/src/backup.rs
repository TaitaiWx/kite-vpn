//! 加密备份 routes —— 服务端只看 ciphertext，永远不能解密。
//!
//! 三种 backup kind:
//!   - ca-key       Owner 的 CA 私钥（最敏感）
//!   - subscriptions  订阅列表（含机场 token，敏感）
//!   - settings     UI / 引擎配置（不敏感，但便于跨设备同步）
//!
//! 客户端职责:
//!   1. 用户输入 passphrase（推荐 ≥ 12 字符 + 高熵）
//!   2. Argon2id(passphrase, salt, m=64MB, t=3, p=4) → 32B key
//!   3. AES-256-GCM(key, plaintext) → nonce(12B) || ciphertext
//!   4. PUT 上传到本服务，附带 salt（让其他设备能 KDF 出同一个 key）
//!
//! 服务端职责:
//!   1. 验证 session
//!   2. 落盘 ciphertext + salt + 元数据
//!   3. GET 时原样返回（用户再用 passphrase 解）

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use base64::Engine;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    auth::extract_user,
    error::{AppError, AppResult},
    state::AppState,
};

const ALLOWED_KINDS: &[&str] = &["ca-key", "subscriptions", "settings"];
const MAX_CIPHERTEXT_BYTES: usize = 1024 * 1024; // 1 MB
const KDF_SALT_BYTES: usize = 16;
/// 每种 backup 保留最近 N 个版本（够回滚误改 / 误删；旧的自动 GC）
const KEEP_VERSIONS: i64 = 10;

// ─── 上传 ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct UploadPayload {
    /// base64-encoded ciphertext (含 12B nonce + tag)
    pub ciphertext_b64: String,
    /// base64-encoded KDF salt (16 字节)
    pub kdf_salt_b64: String,
    /// KDF 算法描述，例: argon2id-v19-m65536-t3-p4
    pub kdf_algorithm: String,
    /// 客户端 schema 版本，用于将来 migration
    pub version: i64,
}

#[derive(Debug, Serialize)]
pub struct BackupSummary {
    pub kind: String,
    pub version: i64,
    pub bytes: i64,
    pub kdf_algorithm: String,
    pub updated_at: i64,
}

pub async fn upload_backup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(kind): Path<String>,
    Json(payload): Json<UploadPayload>,
) -> AppResult<Json<BackupSummary>> {
    let user = extract_user(&state, &headers).await?;
    validate_kind(&kind)?;

    let ciphertext = decode_b64(&payload.ciphertext_b64, "ciphertext")?;
    let salt = decode_b64(&payload.kdf_salt_b64, "kdf_salt")?;

    if ciphertext.is_empty() {
        return Err(AppError::BadRequest("ciphertext 不能为空".into()));
    }
    if ciphertext.len() > MAX_CIPHERTEXT_BYTES {
        return Err(AppError::BadRequest(format!(
            "ciphertext 超限（{} > {} 字节）",
            ciphertext.len(),
            MAX_CIPHERTEXT_BYTES
        )));
    }
    if salt.len() != KDF_SALT_BYTES {
        return Err(AppError::BadRequest(format!(
            "kdf_salt 必须 {} 字节",
            KDF_SALT_BYTES
        )));
    }
    if payload.kdf_algorithm.trim().is_empty() {
        return Err(AppError::BadRequest("kdf_algorithm 不能为空".into()));
    }

    let now = Utc::now().timestamp_millis();
    let id = Uuid::new_v4().to_string();
    let bytes = ciphertext.len() as i64;

    // 1. Upsert backups (当前快照)
    sqlx::query(
        r#"
        INSERT INTO backups (id, user_id, kind, ciphertext, kdf_salt, kdf_algorithm, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, kind) DO UPDATE SET
            ciphertext = excluded.ciphertext,
            kdf_salt = excluded.kdf_salt,
            kdf_algorithm = excluded.kdf_algorithm,
            version = excluded.version,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(&id)
    .bind(&user.user_id)
    .bind(&kind)
    .bind(&ciphertext)
    .bind(&salt)
    .bind(&payload.kdf_algorithm)
    .bind(payload.version)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;

    // 2. 追加到 backup_versions（历史快照）
    let version_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        INSERT INTO backup_versions (id, user_id, kind, ciphertext, kdf_salt, kdf_algorithm, version, bytes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&version_id)
    .bind(&user.user_id)
    .bind(&kind)
    .bind(&ciphertext)
    .bind(&salt)
    .bind(&payload.kdf_algorithm)
    .bind(payload.version)
    .bind(bytes)
    .bind(now)
    .execute(&state.db)
    .await?;

    // 3. GC 旧版本（只保留最近 KEEP_VERSIONS）
    let _ = sqlx::query(
        r#"
        DELETE FROM backup_versions
        WHERE user_id = ? AND kind = ? AND id NOT IN (
            SELECT id FROM backup_versions
            WHERE user_id = ? AND kind = ?
            ORDER BY created_at DESC
            LIMIT ?
        )
        "#,
    )
    .bind(&user.user_id)
    .bind(&kind)
    .bind(&user.user_id)
    .bind(&kind)
    .bind(KEEP_VERSIONS)
    .execute(&state.db)
    .await;

    Ok(Json(BackupSummary {
        kind,
        version: payload.version,
        bytes,
        kdf_algorithm: payload.kdf_algorithm,
        updated_at: now,
    }))
}

// ─── 版本历史 ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct BackupVersionRow {
    pub id: String,
    pub kind: String,
    pub version: i64,
    pub bytes: i64,
    pub kdf_algorithm: String,
    pub created_at: i64,
}

pub async fn list_versions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(kind): Path<String>,
) -> AppResult<Json<Vec<BackupVersionRow>>> {
    let user = extract_user(&state, &headers).await?;
    validate_kind(&kind)?;
    let rows = sqlx::query(
        "SELECT id, kind, version, bytes, kdf_algorithm, created_at FROM backup_versions WHERE user_id = ? AND kind = ? ORDER BY created_at DESC"
    )
    .bind(&user.user_id)
    .bind(&kind)
    .fetch_all(&state.db)
    .await?;
    let out = rows
        .into_iter()
        .map(|r| BackupVersionRow {
            id: r.get("id"),
            kind: r.get("kind"),
            version: r.get("version"),
            bytes: r.get("bytes"),
            kdf_algorithm: r.get("kdf_algorithm"),
            created_at: r.get("created_at"),
        })
        .collect();
    Ok(Json(out))
}

/// POST /api/backup/:kind/restore/:version_id —— 把指定版本恢复成当前快照。
pub async fn restore_version(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((kind, version_id)): Path<(String, String)>,
) -> AppResult<Json<BackupSummary>> {
    let user = extract_user(&state, &headers).await?;
    validate_kind(&kind)?;

    let row = sqlx::query(
        "SELECT ciphertext, kdf_salt, kdf_algorithm, version FROM backup_versions WHERE id = ? AND user_id = ? AND kind = ?"
    )
    .bind(&version_id)
    .bind(&user.user_id)
    .bind(&kind)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    let ciphertext: Vec<u8> = row.get("ciphertext");
    let salt: Vec<u8> = row.get("kdf_salt");
    let kdf_algorithm: String = row.get("kdf_algorithm");
    let version: i64 = row.get("version");
    let bytes = ciphertext.len() as i64;
    let now = Utc::now().timestamp_millis();
    let id = Uuid::new_v4().to_string();

    sqlx::query(
        r#"
        INSERT INTO backups (id, user_id, kind, ciphertext, kdf_salt, kdf_algorithm, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, kind) DO UPDATE SET
            ciphertext = excluded.ciphertext,
            kdf_salt = excluded.kdf_salt,
            kdf_algorithm = excluded.kdf_algorithm,
            version = excluded.version,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(&id)
    .bind(&user.user_id)
    .bind(&kind)
    .bind(&ciphertext)
    .bind(&salt)
    .bind(&kdf_algorithm)
    .bind(version)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;

    crate::audit::record_with_metadata(
        &state.db,
        crate::audit::AuditEvent {
            actor_user_id: Some(&user.user_id),
            actor_email: &user.email,
            actor_ip: "",
            event_type: "backup.restore_version",
            target_kind: "backup",
            target_id: &kind,
        },
        serde_json::json!({"version_id": version_id}),
    )
    .await;

    Ok(Json(BackupSummary {
        kind,
        version,
        bytes,
        kdf_algorithm,
        updated_at: now,
    }))
}

// ─── 下载 ────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct DownloadResponse {
    pub ciphertext_b64: String,
    pub kdf_salt_b64: String,
    pub kdf_algorithm: String,
    pub version: i64,
    pub updated_at: i64,
}

pub async fn download_backup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(kind): Path<String>,
) -> AppResult<Json<DownloadResponse>> {
    let user = extract_user(&state, &headers).await?;
    validate_kind(&kind)?;

    let row = sqlx::query(
        "SELECT ciphertext, kdf_salt, kdf_algorithm, version, updated_at FROM backups WHERE user_id = ? AND kind = ?"
    )
    .bind(&user.user_id)
    .bind(&kind)
    .fetch_optional(&state.db)
    .await?;

    let Some(row) = row else {
        return Err(AppError::NotFound);
    };

    let ciphertext: Vec<u8> = row.get("ciphertext");
    let salt: Vec<u8> = row.get("kdf_salt");

    Ok(Json(DownloadResponse {
        ciphertext_b64: encode_b64(&ciphertext),
        kdf_salt_b64: encode_b64(&salt),
        kdf_algorithm: row.get("kdf_algorithm"),
        version: row.get("version"),
        updated_at: row.get("updated_at"),
    }))
}

// ─── 列出 ────────────────────────────────────────────────────────────────

pub async fn list_backups(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Vec<BackupSummary>>> {
    let user = extract_user(&state, &headers).await?;

    let rows = sqlx::query(
        "SELECT kind, version, length(ciphertext) AS bytes, kdf_algorithm, updated_at FROM backups WHERE user_id = ? ORDER BY kind"
    )
    .bind(&user.user_id)
    .fetch_all(&state.db)
    .await?;

    let summaries = rows
        .into_iter()
        .map(|r| BackupSummary {
            kind: r.get("kind"),
            version: r.get("version"),
            bytes: r.get::<i64, _>("bytes"),
            kdf_algorithm: r.get("kdf_algorithm"),
            updated_at: r.get("updated_at"),
        })
        .collect();
    Ok(Json(summaries))
}

// ─── 删除 ────────────────────────────────────────────────────────────────

pub async fn delete_backup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(kind): Path<String>,
) -> AppResult<impl IntoResponse> {
    let user = extract_user(&state, &headers).await?;
    validate_kind(&kind)?;

    sqlx::query("DELETE FROM backups WHERE user_id = ? AND kind = ?")
        .bind(&user.user_id)
        .bind(&kind)
        .execute(&state.db)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

// ─── 辅助 ───────────────────────────────────────────────────────────────

fn validate_kind(kind: &str) -> AppResult<()> {
    if !ALLOWED_KINDS.contains(&kind) {
        return Err(AppError::BadRequest(format!(
            "kind 必须是 {:?} 之一",
            ALLOWED_KINDS
        )));
    }
    Ok(())
}

fn decode_b64(s: &str, field: &str) -> AppResult<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| AppError::BadRequest(format!("{} 不是合法 base64: {}", field, e)))
}

fn encode_b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowed_kinds_validation() {
        assert!(validate_kind("ca-key").is_ok());
        assert!(validate_kind("subscriptions").is_ok());
        assert!(validate_kind("settings").is_ok());
        assert!(validate_kind("evil").is_err());
        assert!(validate_kind("").is_err());
    }

    #[test]
    fn b64_round_trip() {
        let bytes = vec![0x00, 0xff, 0xde, 0xad, 0xbe, 0xef];
        let s = encode_b64(&bytes);
        let back = decode_b64(&s, "test").unwrap();
        assert_eq!(bytes, back);
    }

    #[test]
    fn b64_rejects_garbage() {
        assert!(decode_b64("not base64 !!!", "test").is_err());
    }
}

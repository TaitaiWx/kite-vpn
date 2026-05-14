//! 公网邀请 (F) 的客户端 IPC —— 调 backend /api/invites + /invite/:slug 系列。
//!
//! 设计原则:
//! - 加密用 passphrase（同 backup 模式）—— passphrase 永远不上 backend
//! - 邀请 payload 用 Argon2id + AES-GCM 包，跟 CA backup 同款
//! - slug 由 backend 生成（短公网 URL 友好）；客户端只保留 slug + public_url
//!
//! 流程：
//!   Owner UI: account_create_invite(peer_name, mesh_ip, roles, passphrase, ttl_hours)
//!     ↓ 客户端拼 EnrollmentPayload (cert + key + ca + lighthouse)
//!     ↓ Argon2id(passphrase, salt) + AES-GCM 加密
//!     ↓ POST /api/invites { encrypted_payload_b64, network_id, peer_name_hint, ttl_hours }
//!     ← { slug, public_url, expires_at }
//!   Owner UI: 把 public_url + passphrase 分两渠道发给受邀人
//!
//!   受邀人 UI: account_consume_invite(slug, passphrase)
//!     ↓ GET /api/invites/:slug/payload  → encrypted_payload_b64
//!     ↓ Argon2id(passphrase, salt) + AES-GCM 解密
//!     ↓ 写 cert + key 到本机 mesh/，启动 nebula

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::account::{
    argon2_kdf, aes_decrypt, aes_encrypt, b64_decode, b64_encode, generate_kdf_salt, http_client,
    load_account, KDF_ALGORITHM_TAG,
};
use super::IpcResult;

const MESH_DIR: &str = "mesh";

// ─── 共享类型 ────────────────────────────────────────────────────────────────

/// 客户端加密时打包的 enrollment 内容 —— 跟 mesh::EnrollmentPayload 字段对齐，
/// 但单独定义避免循环依赖。
#[derive(Debug, Serialize, Deserialize)]
struct InviteInnerPayload {
    network_id: String,
    network_name: String,
    cidr: String,
    lighthouse_endpoint: String,
    cert_pem: String,
    key_pem: String,
    ca_pem: String,
    mesh_ip: String,
    peer_name: String,
    /// salt 内嵌到 payload 同步给受邀人（受邀人解密时需要相同 salt）
    kdf_salt_b64: String,
}

/// 加密后的封装：salt + ciphertext + algorithm tag。
/// 跟 backup 协议同款，但这里 salt 和 ciphertext 一起 base64 后塞进同一个 base64 包给 backend。
#[derive(Debug, Serialize, Deserialize)]
struct WireWrapper {
    kdf_salt_b64: String,
    kdf_algorithm: String,
    ciphertext_b64: String,
    version: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreateInviteRequest {
    pub peer_name: String,
    pub mesh_ip: String,
    pub passphrase: String,
    pub ttl_hours: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreatedInvite {
    pub slug: String,
    pub public_url: String,
    pub expires_at: i64,
    pub passphrase_hint_for_owner: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InviteRow {
    pub slug: String,
    pub network_id: String,
    pub peer_name_hint: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub consumed_at: Option<i64>,
    pub consumer_email: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ServerCreateResponse {
    slug: String,
    #[serde(rename = "public_url")]
    public_url: String,
    #[serde(rename = "expires_at")]
    expires_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct ServerListRow {
    slug: String,
    network_id: String,
    peer_name_hint: String,
    created_at: i64,
    expires_at: i64,
    consumed_at: Option<i64>,
    consumer_email: Option<String>,
}

// ─── 路径帮助 ────────────────────────────────────────────────────────────────

fn mesh_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?;
    let dir = base.join(MESH_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建 mesh 目录: {}", e))?;
    Ok(dir)
}

// ─── IPC: 创建公网邀请 ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn account_create_invite(
    app: AppHandle,
    request: CreateInviteRequest,
) -> IpcResult<CreatedInvite> {
    let account = load_account(&app);
    if account.session_cookie.is_empty() {
        return IpcResult::err("尚未登录 backend".to_string());
    }
    if request.passphrase.len() < 8 {
        return IpcResult::err("passphrase 至少 8 字符".to_string());
    }
    if request.peer_name.trim().is_empty() {
        return IpcResult::err("设备名不能为空".to_string());
    }
    if request.mesh_ip.trim().is_empty() {
        return IpcResult::err("内网 IP 不能为空".to_string());
    }
    if request.ttl_hours <= 0 {
        return IpcResult::err("ttl_hours 必须为正".to_string());
    }

    // 1. 读本地 mesh 元数据 + CA + 给新设备签证书
    let dir = match mesh_dir(&app) {
        Ok(d) => d,
        Err(e) => return IpcResult::err(e),
    };
    let meta_path = dir.join("network.json");
    if !meta_path.exists() {
        return IpcResult::err("尚未创建 Mesh 网络 —— 你必须是 owner 才能发邀请".to_string());
    }
    let network_str = match fs::read_to_string(&meta_path) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(format!("读取 network.json 失败: {}", e)),
    };
    let network: serde_json::Value = match serde_json::from_str(&network_str) {
        Ok(v) => v,
        Err(e) => return IpcResult::err(format!("解析 network.json 失败: {}", e)),
    };

    let network_id = network
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let network_name = network
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let cidr = network
        .get("cidr")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let lighthouse_endpoint = network
        .get("lighthouse_endpoint")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if network_id.is_empty() || lighthouse_endpoint.is_empty() {
        return IpcResult::err("network.json 缺关键字段（id / lighthouse_endpoint）".to_string());
    }

    let ca_pem = match fs::read_to_string(dir.join("ca.crt")) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(format!("读取 CA 证书失败: {}", e)),
    };

    // 用 mesh 模块同款 nebula-cert 签证书
    let nebula_cert = match crate::commands::mesh::nebula_cert_path_for_invite(&app) {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e),
    };
    let temp_dir = dir.join("enrollments/tmp");
    fs::create_dir_all(&temp_dir).ok();

    let cert_basename = format!(
        "invite-{}-{}",
        sanitize_filename(&request.peer_name),
        now_ms()
    );
    let ip_cidr = format!("{}/10", request.mesh_ip);
    if let Err(e) = crate::commands::mesh::nebula_cert_sign_for_invite(
        &nebula_cert,
        &dir,
        &temp_dir,
        &cert_basename,
        &ip_cidr,
    ) {
        return IpcResult::err(e);
    }

    let cert_path = temp_dir.join(format!("{}.crt", cert_basename));
    let key_path = temp_dir.join(format!("{}.key", cert_basename));
    let cert_pem = match fs::read_to_string(&cert_path) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(format!("读取签发证书失败: {}", e)),
    };
    let key_pem = match fs::read_to_string(&key_path) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(format!("读取签发私钥失败: {}", e)),
    };
    // 私钥立即从 owner 设备删除（一次性发出去就丢）
    let _ = fs::remove_file(&cert_path);
    let _ = fs::remove_file(&key_path);

    // 2. 生成 KDF salt + 加密 payload
    let salt = match generate_kdf_salt() {
        Ok(s) => s,
        Err(e) => return IpcResult::err(e),
    };
    let salt_b64 = b64_encode(&salt);
    let inner = InviteInnerPayload {
        network_id: network_id.clone(),
        network_name,
        cidr,
        lighthouse_endpoint,
        cert_pem,
        key_pem,
        ca_pem,
        mesh_ip: request.mesh_ip.trim().to_string(),
        peer_name: request.peer_name.trim().to_string(),
        kdf_salt_b64: salt_b64.clone(),
    };
    let plaintext = match serde_json::to_vec(&inner) {
        Ok(v) => v,
        Err(e) => return IpcResult::err(format!("序列化 payload 失败: {}", e)),
    };
    let key = match argon2_kdf(&request.passphrase, &salt) {
        Ok(k) => k,
        Err(e) => return IpcResult::err(e),
    };
    let ciphertext = match aes_encrypt(&key, &plaintext) {
        Ok(c) => c,
        Err(e) => return IpcResult::err(e),
    };

    let wire = WireWrapper {
        kdf_salt_b64: salt_b64.clone(),
        kdf_algorithm: KDF_ALGORITHM_TAG.to_string(),
        ciphertext_b64: b64_encode(&ciphertext),
        version: 1,
    };
    let wire_bytes = match serde_json::to_vec(&wire) {
        Ok(v) => v,
        Err(e) => return IpcResult::err(format!("序列化 wire wrapper 失败: {}", e)),
    };
    let encrypted_payload_b64 = b64_encode(&wire_bytes);

    // 3. 上传到 backend
    let client = match http_client() {
        Ok(c) => c,
        Err(e) => return IpcResult::err(e),
    };
    let url = format!("{}/api/invites", account.server_url);
    let body = serde_json::json!({
        "encrypted_payload_b64": encrypted_payload_b64,
        "network_id": network_id,
        "peer_name_hint": request.peer_name.trim(),
        "ttl_hours": request.ttl_hours,
    });
    let resp = match client
        .post(&url)
        .header(reqwest::header::COOKIE, &account.session_cookie)
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return IpcResult::err(format!("请求失败: {}", e)),
    };
    if !resp.status().is_success() {
        return IpcResult::err(format!("后端拒绝: HTTP {}", resp.status().as_u16()));
    }
    let parsed: ServerCreateResponse = match resp.json().await {
        Ok(p) => p,
        Err(e) => return IpcResult::err(format!("解析响应失败: {}", e)),
    };

    IpcResult::ok(CreatedInvite {
        slug: parsed.slug,
        public_url: parsed.public_url,
        expires_at: parsed.expires_at,
        passphrase_hint_for_owner: "请把 passphrase 通过另一渠道告诉受邀人（不要和 URL 同渠道发）".into(),
    })
}

// ─── IPC: 列出本人发出的邀请 ───────────────────────────────────────────────

#[tauri::command]
pub async fn account_list_invites(app: AppHandle) -> IpcResult<Vec<InviteRow>> {
    let account = load_account(&app);
    if account.session_cookie.is_empty() {
        return IpcResult::err("尚未登录".to_string());
    }
    let client = match http_client() {
        Ok(c) => c,
        Err(e) => return IpcResult::err(e),
    };
    let url = format!("{}/api/invites", account.server_url);
    let resp = match client
        .get(&url)
        .header(reqwest::header::COOKIE, &account.session_cookie)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return IpcResult::err(format!("请求失败: {}", e)),
    };
    if !resp.status().is_success() {
        return IpcResult::err(format!("后端拒绝: HTTP {}", resp.status().as_u16()));
    }
    let rows: Vec<ServerListRow> = match resp.json().await {
        Ok(v) => v,
        Err(e) => return IpcResult::err(format!("解析响应失败: {}", e)),
    };
    let out = rows
        .into_iter()
        .map(|r| InviteRow {
            slug: r.slug,
            network_id: r.network_id,
            peer_name_hint: r.peer_name_hint,
            created_at: r.created_at,
            expires_at: r.expires_at,
            consumed_at: r.consumed_at,
            consumer_email: r.consumer_email,
        })
        .collect();
    IpcResult::ok(out)
}

#[tauri::command]
pub async fn account_revoke_invite(app: AppHandle, slug: String) -> IpcResult<()> {
    let account = load_account(&app);
    if account.session_cookie.is_empty() {
        return IpcResult::err("尚未登录".to_string());
    }
    let client = match http_client() {
        Ok(c) => c,
        Err(e) => return IpcResult::err(e),
    };
    let url = format!("{}/api/invites/{}", account.server_url, slug);
    let resp = match client
        .delete(&url)
        .header(reqwest::header::COOKIE, &account.session_cookie)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return IpcResult::err(format!("请求失败: {}", e)),
    };
    if !resp.status().is_success() {
        return IpcResult::err(format!("后端拒绝: HTTP {}", resp.status().as_u16()));
    }
    IpcResult::ok(())
}

// ─── IPC: 受邀人消费 ────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConsumedInvite {
    pub network_id: String,
    pub network_name: String,
    pub mesh_ip: String,
    pub peer_name: String,
}

#[tauri::command]
pub async fn account_consume_invite(
    app: AppHandle,
    server_url: String,
    slug: String,
    passphrase: String,
) -> IpcResult<ConsumedInvite> {
    if server_url.trim().is_empty() {
        return IpcResult::err("server_url 不能为空".to_string());
    }
    if slug.trim().is_empty() {
        return IpcResult::err("slug 不能为空".to_string());
    }
    if passphrase.is_empty() {
        return IpcResult::err("passphrase 不能为空".to_string());
    }

    let client = match http_client() {
        Ok(c) => c,
        Err(e) => return IpcResult::err(e),
    };
    let url = format!(
        "{}/api/invites/{}/payload",
        server_url.trim().trim_end_matches('/'),
        slug
    );
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => return IpcResult::err(format!("请求失败: {}", e)),
    };
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return IpcResult::err("邀请不存在 / 已过期".to_string());
    }
    if resp.status() == reqwest::StatusCode::FORBIDDEN {
        return IpcResult::err("邀请已被使用".to_string());
    }
    if !resp.status().is_success() {
        return IpcResult::err(format!("后端拒绝: HTTP {}", resp.status().as_u16()));
    }

    #[derive(Deserialize)]
    struct PayloadResp {
        encrypted_payload_b64: String,
        network_id: String,
    }
    let r: PayloadResp = match resp.json().await {
        Ok(v) => v,
        Err(e) => return IpcResult::err(format!("解析响应失败: {}", e)),
    };

    let _ = r.network_id; // 仅作 hint，真正信息在 inner payload

    // 解 outer wire wrapper
    let wire_bytes = match b64_decode(&r.encrypted_payload_b64) {
        Ok(b) => b,
        Err(e) => return IpcResult::err(format!("外层 base64 解码失败: {}", e)),
    };
    let wire: WireWrapper = match serde_json::from_slice(&wire_bytes) {
        Ok(w) => w,
        Err(e) => return IpcResult::err(format!("解析 wire wrapper 失败: {}", e)),
    };
    if wire.kdf_algorithm != KDF_ALGORITHM_TAG {
        return IpcResult::err(format!(
            "邀请用了不兼容的 KDF: {}（当前客户端仅支持 {}）",
            wire.kdf_algorithm, KDF_ALGORITHM_TAG
        ));
    }
    let salt = match b64_decode(&wire.kdf_salt_b64) {
        Ok(b) => b,
        Err(e) => return IpcResult::err(format!("salt 解码失败: {}", e)),
    };
    let ciphertext = match b64_decode(&wire.ciphertext_b64) {
        Ok(b) => b,
        Err(e) => return IpcResult::err(format!("ciphertext 解码失败: {}", e)),
    };

    let key = match argon2_kdf(&passphrase, &salt) {
        Ok(k) => k,
        Err(e) => return IpcResult::err(e),
    };
    let plaintext = match aes_decrypt(&key, &ciphertext) {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e),
    };
    let inner: InviteInnerPayload = match serde_json::from_slice(&plaintext) {
        Ok(v) => v,
        Err(e) => return IpcResult::err(format!("解析 inner payload 失败: {}", e)),
    };

    // 把 cert + key + ca 写到本机 mesh/
    let dir = match mesh_dir(&app) {
        Ok(d) => d,
        Err(e) => return IpcResult::err(e),
    };
    if let Err(e) = fs::write(dir.join("ca.crt"), &inner.ca_pem) {
        return IpcResult::err(format!("写 ca.crt 失败: {}", e));
    }
    if let Err(e) = fs::write(dir.join("host.crt"), &inner.cert_pem) {
        return IpcResult::err(format!("写 host.crt 失败: {}", e));
    }
    if let Err(e) = fs::write(dir.join("host.key"), &inner.key_pem) {
        return IpcResult::err(format!("写 host.key 失败: {}", e));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir.join("host.key"), fs::Permissions::from_mode(0o600));
    }
    // 写一份 network.json（受邀人本地视角）
    let local_meta = serde_json::json!({
        "id": inner.network_id,
        "name": inner.network_name,
        "cidr": inner.cidr,
        "lighthouse_endpoint": inner.lighthouse_endpoint,
        "joined_via_invite": true,
        "self_mesh_ip": inner.mesh_ip,
    });
    if let Err(e) = fs::write(dir.join("network.json"), local_meta.to_string()) {
        return IpcResult::err(format!("写 network.json 失败: {}", e));
    }

    IpcResult::ok(ConsumedInvite {
        network_id: inner.network_id,
        network_name: inner.network_name,
        mesh_ip: inner.mesh_ip,
        peer_name: inner.peer_name,
    })
}

// ─── 辅助 ────────────────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn sanitize_filename(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

// 因为 nebula 跟 sign helper 是 private to mesh 模块的，让 mesh 暴露 *_for_invite 公开函数
// 见 commands/mesh.rs 末尾。

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_filename_strips_dangerous_chars() {
        assert_eq!(sanitize_filename("hello world"), "hello_world");
        assert_eq!(sanitize_filename("../etc/passwd"), "___etc_passwd");
        assert_eq!(sanitize_filename("clean-name_2026"), "clean-name_2026");
    }

    #[test]
    fn now_ms_is_monotonic() {
        let a = now_ms();
        let b = now_ms();
        assert!(b >= a);
    }

    #[test]
    fn wire_wrapper_round_trip() {
        let salt = [7u8; 16];
        let salt_b64 = b64_encode(&salt);
        let pass = "test-passphrase-2026";
        let key = argon2_kdf(pass, &salt).unwrap();
        let plain = b"{\"network_id\":\"abc\"}";
        let ct = aes_encrypt(&key, plain).unwrap();

        let wire = WireWrapper {
            kdf_salt_b64: salt_b64.clone(),
            kdf_algorithm: KDF_ALGORITHM_TAG.to_string(),
            ciphertext_b64: b64_encode(&ct),
            version: 1,
        };
        let bytes = serde_json::to_vec(&wire).unwrap();
        let parsed: WireWrapper = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed.kdf_algorithm, KDF_ALGORITHM_TAG);
        // 解密验证
        let salt_back = b64_decode(&parsed.kdf_salt_b64).unwrap();
        let key_back = argon2_kdf(pass, &salt_back).unwrap();
        let ct_back = b64_decode(&parsed.ciphertext_b64).unwrap();
        let pt_back = aes_decrypt(&key_back, &ct_back).unwrap();
        assert_eq!(pt_back, plain);
    }

    #[test]
    fn wrong_passphrase_fails_decrypt() {
        let salt = [3u8; 16];
        let key = argon2_kdf("right", &salt).unwrap();
        let ct = aes_encrypt(&key, b"secret payload").unwrap();
        let wrong_key = argon2_kdf("wrong", &salt).unwrap();
        assert!(aes_decrypt(&wrong_key, &ct).is_err());
    }
}

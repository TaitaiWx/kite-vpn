//! Kite Backend 客户端 IPC：账户登录 + 零知识备份。
//!
//! 设计原则（per workspace claude.md）:
//! - 业界最佳实践: Argon2id + AES-256-GCM 客户端加密，匹配 1Password / Bitwarden 模型
//! - 第一性原理: passphrase 永远不上服务端；服务端拿走 SQLite 也解不开
//! - 禁滥用 ?: 未配置 backend 时 server_url = ""（空字符串），未登录 email = ""
//!
//! 流程:
//!   1. account_set_server: 用户填后端 URL，落盘
//!   2. account_request_login(email): 让后端发 magic link 邮件
//!   3. 用户在邮件里拿到 token（或点链接 → 浏览器开 → 复制 token）
//!   4. account_verify_login(token): Kite 拿 token 调 /auth/verify，存 session
//!   5. account_backup_ca_key(passphrase): 加密本地 CA 私钥 → 上传
//!   6. account_restore_ca_key(passphrase): 下载 → 解密 → 写盘

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{
    password_hash::{rand_core::OsRng as ArgonOsRng, SaltString},
    Argon2, Algorithm, Params, Version,
};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::IpcResult;

const ACCOUNT_CONFIG_FILE: &str = "account.json";
const MESH_DIR: &str = "mesh";
const CA_KEY_FILE: &str = "ca.key";
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

// Argon2id 参数 — 跟 backend README 文档对齐
// m=64MB (65536 KiB), t=3, p=4 — OWASP 2026 推荐
const ARGON2_MEMORY_KB: u32 = 65536;
const ARGON2_ITERATIONS: u32 = 3;
const ARGON2_PARALLELISM: u32 = 4;
const ARGON2_OUTPUT_LEN: usize = 32; // 256-bit key
const KDF_ALGORITHM_TAG: &str = "argon2id-v19-m65536-t3-p4";

// ─── 持久化的本地账户配置 ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedAccount {
    /// 后端 base URL，例 https://kite.example.com。未配置则为空字符串。
    server_url: String,
    /// 已登录用户邮箱。未登录则为空字符串。
    email: String,
    /// 完整的 Cookie header 值，例 "kite_session=xxxxx"。未登录则为空。
    session_cookie: String,
}

fn account_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取 app_data_dir: {}", e))?;
    fs::create_dir_all(&base).map_err(|e| format!("无法创建 app_data: {}", e))?;
    Ok(base.join(ACCOUNT_CONFIG_FILE))
}

fn load_account(app: &AppHandle) -> PersistedAccount {
    let path = match account_config_path(app) {
        Ok(p) => p,
        Err(_) => return PersistedAccount::default(),
    };
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_account(app: &AppHandle, account: &PersistedAccount) -> Result<(), String> {
    let path = account_config_path(app)?;
    let json = serde_json::to_string_pretty(account)
        .map_err(|e| format!("序列化失败: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("写入 {} 失败: {}", path.display(), e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

// ─── IPC types ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountState {
    pub server_url: String,
    pub email: String,
    pub logged_in: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub kind: String,
    pub version: i64,
    pub bytes: i64,
    pub kdf_algorithm: String,
    pub updated_at: i64,
}

// ─── HTTP client ────────────────────────────────────────────────────────

fn http_client() -> Result<reqwest::Client, String> {
    // .no_proxy() 防止 mihomo 把 backend 请求绕进墙
    reqwest::Client::builder()
        .no_proxy()
        .timeout(HTTP_TIMEOUT)
        .user_agent(format!("kite-desktop/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("HTTP client 构造失败: {}", e))
}

fn extract_session_cookie(set_cookie_header: &str) -> Option<String> {
    // "kite_session=xxx; Path=/; ..." → "kite_session=xxx"
    set_cookie_header
        .split(';')
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| s.starts_with("kite_session="))
}

// ─── 配置后端 URL ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn account_set_server(app: AppHandle, server_url: String) -> IpcResult<AccountState> {
    let trimmed = server_url.trim().trim_end_matches('/').to_string();
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return IpcResult::err("server_url 必须以 http:// 或 https:// 开头".to_string());
    }
    let mut account = load_account(&app);
    // 改服务器 = 强制登出
    if account.server_url != trimmed {
        account.email = String::new();
        account.session_cookie = String::new();
    }
    account.server_url = trimmed.clone();
    if let Err(e) = save_account(&app, &account) {
        return IpcResult::err(e);
    }
    IpcResult::ok(AccountState {
        server_url: trimmed,
        email: account.email,
        logged_in: !account.session_cookie.is_empty(),
    })
}

#[tauri::command]
pub async fn account_get_state(app: AppHandle) -> IpcResult<AccountState> {
    let account = load_account(&app);
    IpcResult::ok(AccountState {
        server_url: account.server_url,
        email: account.email,
        logged_in: !account.session_cookie.is_empty(),
    })
}

// ─── Magic link 流程 ────────────────────────────────────────────────────

#[tauri::command]
pub async fn account_request_login(app: AppHandle, email: String) -> IpcResult<()> {
    let account = load_account(&app);
    if account.server_url.is_empty() {
        return IpcResult::err("尚未配置后端 URL".to_string());
    }
    let trimmed_email = email.trim().to_lowercase();
    if !trimmed_email.contains('@') {
        return IpcResult::err("邮箱格式不合法".to_string());
    }

    let client = match http_client() {
        Ok(c) => c,
        Err(e) => return IpcResult::err(e),
    };
    let url = format!("{}/api/auth/request-login", account.server_url);
    let body = serde_json::json!({ "email": trimmed_email });
    match client.post(&url).json(&body).send().await {
        Ok(resp) if resp.status().is_success() => IpcResult::ok(()),
        Ok(resp) => IpcResult::err(format!("后端拒绝: HTTP {}", resp.status().as_u16())),
        Err(e) => IpcResult::err(format!("请求失败: {}", e)),
    }
}

#[tauri::command]
pub async fn account_verify_login(app: AppHandle, token: String) -> IpcResult<AccountState> {
    let mut account = load_account(&app);
    if account.server_url.is_empty() {
        return IpcResult::err("尚未配置后端 URL".to_string());
    }
    let token = token.trim().to_string();
    if token.is_empty() {
        return IpcResult::err("token 不能为空".to_string());
    }

    let client = match http_client() {
        Ok(c) => c,
        Err(e) => return IpcResult::err(e),
    };

    // 走 redirect 模式：从 set-cookie 头取 session
    let url = format!("{}/auth/verify?token={}", account.server_url, urlencoding::encode(&token));
    let resp = match client
        .get(&url)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return IpcResult::err(format!("请求失败: {}", e)),
    };

    // 后端验证成功时返回 302 + Set-Cookie；失败时 401
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return IpcResult::err("token 已过期或不存在".to_string());
    }
    if !resp.status().is_redirection() && !resp.status().is_success() {
        return IpcResult::err(format!("后端拒绝: HTTP {}", resp.status().as_u16()));
    }

    // 提取 session cookie
    let cookie_header = resp
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let Some(session) = extract_session_cookie(cookie_header) else {
        return IpcResult::err("后端未返回 session cookie（异常）".to_string());
    };
    account.session_cookie = session;

    // 拿 email：调一个简单的 endpoint，但我们没建 /api/me，
    // 所以从用户最初输入的 email 直接保存（前端调用 verify 时一并传入）。
    // 这里没传 email，所以保持原样 —— UI 在调 verify 前会先调 request_login 存 email。
    if let Err(e) = save_account(&app, &account) {
        return IpcResult::err(e);
    }

    IpcResult::ok(AccountState {
        server_url: account.server_url,
        email: account.email,
        logged_in: true,
    })
}

/// 把已知的 email 记到本地账户里（在调 request_login 时调用，方便后续 UI 显示）。
#[tauri::command]
pub async fn account_remember_email(app: AppHandle, email: String) -> IpcResult<()> {
    let mut account = load_account(&app);
    account.email = email.trim().to_lowercase();
    if let Err(e) = save_account(&app, &account) {
        return IpcResult::err(e);
    }
    IpcResult::ok(())
}

#[tauri::command]
pub async fn account_logout(app: AppHandle) -> IpcResult<()> {
    let mut account = load_account(&app);
    if !account.session_cookie.is_empty() && !account.server_url.is_empty() {
        // best-effort：通知 backend 失效 session
        if let Ok(client) = http_client() {
            let url = format!("{}/api/auth/logout", account.server_url);
            let _ = client
                .post(&url)
                .header(reqwest::header::COOKIE, &account.session_cookie)
                .send()
                .await;
        }
    }
    account.session_cookie = String::new();
    if let Err(e) = save_account(&app, &account) {
        return IpcResult::err(e);
    }
    IpcResult::ok(())
}

// ─── KDF + 加密 helpers ─────────────────────────────────────────────────

fn argon2_kdf(passphrase: &str, salt: &[u8]) -> Result<[u8; ARGON2_OUTPUT_LEN], String> {
    let params = Params::new(
        ARGON2_MEMORY_KB,
        ARGON2_ITERATIONS,
        ARGON2_PARALLELISM,
        Some(ARGON2_OUTPUT_LEN),
    )
    .map_err(|e| format!("Argon2 参数非法: {}", e))?;

    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; ARGON2_OUTPUT_LEN];
    argon2
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| format!("Argon2 KDF 失败: {}", e))?;
    Ok(key)
}

fn aes_encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nonce_bytes = [0u8; 12];
    rand::rngs::OsRng
        .try_fill_bytes(&mut nonce_bytes)
        .map_err(|e| format!("nonce rng: {}", e))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let mut ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("AES-GCM 加密失败: {}", e))?;
    // 把 nonce 拼到 ciphertext 前面（标准做法）
    let mut combined = Vec::with_capacity(12 + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.append(&mut ciphertext);
    Ok(combined)
}

fn aes_decrypt(key: &[u8; 32], combined: &[u8]) -> Result<Vec<u8>, String> {
    if combined.len() < 12 + 16 {
        return Err("ciphertext 太短".to_string());
    }
    let nonce_bytes = &combined[..12];
    let ct = &combined[12..];
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ct)
        .map_err(|_| "解密失败（passphrase 错或备份损坏）".to_string())
}

fn b64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| format!("base64 解码失败: {}", e))
}

fn generate_kdf_salt() -> Result<[u8; 16], String> {
    let salt = SaltString::generate(&mut ArgonOsRng);
    let raw = salt.as_str().as_bytes();
    // SaltString 给的是 base64-ish 长度可变；我们需要固定 16 字节
    let mut out = [0u8; 16];
    rand::rngs::OsRng
        .try_fill_bytes(&mut out)
        .map_err(|e| format!("salt rng: {}", e))?;
    let _ = raw; // SaltString 只是为了引入 argon2 helper，未实际用
    Ok(out)
}

// ─── 备份 / 恢复 ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn account_backup_ca_key(app: AppHandle, passphrase: String) -> IpcResult<BackupSummary> {
    let account = load_account(&app);
    if account.session_cookie.is_empty() {
        return IpcResult::err("尚未登录".to_string());
    }
    if passphrase.len() < 8 {
        return IpcResult::err("passphrase 至少 8 字符（建议 ≥12）".to_string());
    }

    // 读 CA 私钥
    let mesh_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppErrorWrapped(e.to_string()))
        .map(|p| p.join(MESH_DIR));
    let mesh_dir = match mesh_dir {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e.0),
    };
    let ca_key_path = mesh_dir.join(CA_KEY_FILE);
    if !ca_key_path.exists() {
        return IpcResult::err("CA 私钥不存在 —— 你必须是 owner 才能备份（在 Kite 创建过网络）".to_string());
    }
    let plaintext = match fs::read(&ca_key_path) {
        Ok(b) => b,
        Err(e) => return IpcResult::err(format!("读 CA 失败: {}", e)),
    };

    // KDF + 加密
    let salt = match generate_kdf_salt() {
        Ok(s) => s,
        Err(e) => return IpcResult::err(e),
    };
    let key = match argon2_kdf(&passphrase, &salt) {
        Ok(k) => k,
        Err(e) => return IpcResult::err(e),
    };
    let ciphertext = match aes_encrypt(&key, &plaintext) {
        Ok(c) => c,
        Err(e) => return IpcResult::err(e),
    };

    // 上传
    let client = match http_client() {
        Ok(c) => c,
        Err(e) => return IpcResult::err(e),
    };
    let url = format!("{}/api/backup/ca-key", account.server_url);
    let body = serde_json::json!({
        "ciphertext_b64": b64_encode(&ciphertext),
        "kdf_salt_b64": b64_encode(&salt),
        "kdf_algorithm": KDF_ALGORITHM_TAG,
        "version": 1,
    });
    let resp = match client
        .put(&url)
        .header(reqwest::header::COOKIE, &account.session_cookie)
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return IpcResult::err(format!("上传失败: {}", e)),
    };
    if !resp.status().is_success() {
        return IpcResult::err(format!("后端拒绝: HTTP {}", resp.status().as_u16()));
    }
    match resp.json::<BackupSummary>().await {
        Ok(s) => IpcResult::ok(s),
        Err(e) => IpcResult::err(format!("解析响应失败: {}", e)),
    }
}

#[tauri::command]
pub async fn account_restore_ca_key(app: AppHandle, passphrase: String) -> IpcResult<()> {
    let account = load_account(&app);
    if account.session_cookie.is_empty() {
        return IpcResult::err("尚未登录".to_string());
    }
    if passphrase.is_empty() {
        return IpcResult::err("passphrase 不能为空".to_string());
    }

    // 拉远端
    let client = match http_client() {
        Ok(c) => c,
        Err(e) => return IpcResult::err(e),
    };
    let url = format!("{}/api/backup/ca-key", account.server_url);
    let resp = match client
        .get(&url)
        .header(reqwest::header::COOKIE, &account.session_cookie)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return IpcResult::err(format!("请求失败: {}", e)),
    };
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return IpcResult::err("远端没有 CA 备份 —— 你需要先在 owner 设备做 backup".to_string());
    }
    if !resp.status().is_success() {
        return IpcResult::err(format!("后端拒绝: HTTP {}", resp.status().as_u16()));
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RestoreResp {
        ciphertext_b64: String,
        kdf_salt_b64: String,
        kdf_algorithm: String,
    }
    let body: RestoreResp = match resp.json().await {
        Ok(b) => b,
        Err(e) => return IpcResult::err(format!("解析响应失败: {}", e)),
    };
    if body.kdf_algorithm != KDF_ALGORITHM_TAG {
        return IpcResult::err(format!(
            "备份用了不兼容的 KDF: {}（当前客户端只支持 {}）",
            body.kdf_algorithm, KDF_ALGORITHM_TAG
        ));
    }
    let ciphertext = match b64_decode(&body.ciphertext_b64) {
        Ok(c) => c,
        Err(e) => return IpcResult::err(e),
    };
    let salt = match b64_decode(&body.kdf_salt_b64) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(e),
    };

    let key = match argon2_kdf(&passphrase, &salt) {
        Ok(k) => k,
        Err(e) => return IpcResult::err(e),
    };
    let plaintext = match aes_decrypt(&key, &ciphertext) {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e),
    };

    // 写盘
    let mesh_dir = app
        .path()
        .app_data_dir()
        .map(|p| p.join(MESH_DIR));
    let mesh_dir = match mesh_dir {
        Ok(p) => p,
        Err(e) => return IpcResult::err(format!("无法获取 mesh 目录: {}", e)),
    };
    if let Err(e) = fs::create_dir_all(&mesh_dir) {
        return IpcResult::err(format!("创建 mesh 目录失败: {}", e));
    }
    let ca_key_path = mesh_dir.join(CA_KEY_FILE);
    if let Err(e) = fs::write(&ca_key_path, &plaintext) {
        return IpcResult::err(format!("写入 CA 私钥失败: {}", e));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&ca_key_path, fs::Permissions::from_mode(0o600));
    }

    IpcResult::ok(())
}

// ─── 辅助 ───────────────────────────────────────────────────────────────

struct AppErrorWrapped(String);

// ─── 单元测试 ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_cookie_from_set_cookie() {
        assert_eq!(
            extract_session_cookie("kite_session=abc; Path=/; HttpOnly"),
            Some("kite_session=abc".to_string()),
        );
        assert_eq!(
            extract_session_cookie("other=foo; Path=/"),
            None,
        );
    }

    #[test]
    fn argon2_kdf_is_deterministic() {
        let salt = [0u8; 16];
        let k1 = argon2_kdf("test passphrase", &salt).unwrap();
        let k2 = argon2_kdf("test passphrase", &salt).unwrap();
        assert_eq!(k1, k2);
    }

    #[test]
    fn argon2_kdf_changes_with_passphrase() {
        let salt = [0u8; 16];
        let k1 = argon2_kdf("password-a", &salt).unwrap();
        let k2 = argon2_kdf("password-b", &salt).unwrap();
        assert_ne!(k1, k2);
    }

    #[test]
    fn argon2_kdf_changes_with_salt() {
        let salt1 = [0u8; 16];
        let salt2 = [1u8; 16];
        let k1 = argon2_kdf("same passphrase", &salt1).unwrap();
        let k2 = argon2_kdf("same passphrase", &salt2).unwrap();
        assert_ne!(k1, k2);
    }

    #[test]
    fn aes_encrypt_decrypt_round_trip() {
        let key = [42u8; 32];
        let plaintext = b"hello kite zero-knowledge backup";
        let ct = aes_encrypt(&key, plaintext).unwrap();
        let pt = aes_decrypt(&key, &ct).unwrap();
        assert_eq!(pt, plaintext);
    }

    #[test]
    fn aes_decrypt_rejects_wrong_key() {
        let key = [42u8; 32];
        let wrong = [99u8; 32];
        let ct = aes_encrypt(&key, b"secret").unwrap();
        assert!(aes_decrypt(&wrong, &ct).is_err());
    }

    #[test]
    fn aes_decrypt_rejects_tampered_ciphertext() {
        let key = [42u8; 32];
        let mut ct = aes_encrypt(&key, b"hello kite").unwrap();
        *ct.last_mut().unwrap() ^= 0x01; // flip 1 bit in tag
        assert!(aes_decrypt(&key, &ct).is_err());
    }

    #[test]
    fn aes_decrypt_rejects_short_input() {
        let key = [0u8; 32];
        assert!(aes_decrypt(&key, b"too short").is_err());
    }

    #[test]
    fn kdf_salt_is_unique() {
        let s1 = generate_kdf_salt().unwrap();
        let s2 = generate_kdf_salt().unwrap();
        assert_ne!(s1, s2);
    }

    #[test]
    fn full_round_trip_kdf_then_aes() {
        let passphrase = "my-secure-passphrase-2026";
        let salt = generate_kdf_salt().unwrap();
        let key = argon2_kdf(passphrase, &salt).unwrap();

        let plaintext = b"-----BEGIN NEBULA CERTIFICATE-----\nfake CA key\n-----END";
        let ct = aes_encrypt(&key, plaintext).unwrap();

        // Server 视角: 拿到 ct + salt, 不知道 passphrase 解不开
        let wrong_key = argon2_kdf("wrong-passphrase", &salt).unwrap();
        assert!(aes_decrypt(&wrong_key, &ct).is_err());

        // 新设备: 输入正确 passphrase, KDF 出相同 key, 解出原文
        let recovered_key = argon2_kdf(passphrase, &salt).unwrap();
        let recovered = aes_decrypt(&recovered_key, &ct).unwrap();
        assert_eq!(recovered, plaintext);
    }

    #[test]
    fn b64_round_trip() {
        let data = vec![0u8, 0xff, 0xde, 0xad, 0xbe, 0xef];
        let s = b64_encode(&data);
        let back = b64_decode(&s).unwrap();
        assert_eq!(back, data);
    }
}

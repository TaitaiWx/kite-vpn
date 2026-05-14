//! 更新签名验证 IPC —— 调 backend /api/updates/{pubkey,latest.json}。
//!
//! 流程：
//!   1. account_fetch_update_pubkey: 首次启动调一次，落盘到 account.json
//!   2. account_check_update_signed: 走 backend latest.json + X-Kite-Signature
//!      header，本地 ed25519 验签。验通过返回更新元信息；不通过 UI 警告 +
//!      回落到 GitHub fallback。
//!
//! 跟 Tauri 自带 updater 的关系：
//!   Tauri 内置 updater 不开放 hook，所以这里是"并行"流程：客户端可以同时
//!   用 Tauri updater（验 .tar.gz minisign）和我们这套（验 latest.json
//!   ed25519）。前者保证二进制没被改，后者保证你看到的 latest.json 没被改。
//!   两层独立密钥，defense in depth。

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::account::{b64_decode, http_client, load_account, save_account};
use super::IpcResult;

// ─── IPC: 拿 backend transport pubkey ──────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePubkeyInfo {
    pub pubkey_b64: String,
    pub algorithm: String,
}

#[derive(Debug, Deserialize)]
struct ServerPubkey {
    pubkey_b64: String,
    algorithm: String,
}

#[tauri::command]
pub async fn account_fetch_update_pubkey(app: AppHandle) -> IpcResult<UpdatePubkeyInfo> {
    let mut account = load_account(&app);
    if account.server_url.is_empty() {
        return IpcResult::err("尚未配置 backend URL".to_string());
    }
    let client = match http_client() {
        Ok(c) => c,
        Err(e) => return IpcResult::err(e),
    };
    let url = format!("{}/api/updates/pubkey", account.server_url);
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => return IpcResult::err(format!("请求失败: {}", e)),
    };
    if !resp.status().is_success() {
        return IpcResult::err(format!("后端拒绝: HTTP {}", resp.status().as_u16()));
    }
    let body: ServerPubkey = match resp.json().await {
        Ok(v) => v,
        Err(e) => return IpcResult::err(format!("解析响应失败: {}", e)),
    };
    if body.algorithm != "ed25519" {
        return IpcResult::err(format!(
            "不支持的签名算法: {}（仅支持 ed25519）",
            body.algorithm
        ));
    }
    // 验证 pubkey 是 32 字节
    let bytes = match b64_decode(&body.pubkey_b64) {
        Ok(b) => b,
        Err(e) => return IpcResult::err(format!("pubkey base64 非法: {}", e)),
    };
    if bytes.len() != 32 {
        return IpcResult::err(format!("ed25519 pubkey 必须 32 字节，实际 {}", bytes.len()));
    }

    account.update_pubkey_b64 = body.pubkey_b64.clone();
    if let Err(e) = save_account(&app, &account) {
        return IpcResult::err(e);
    }
    IpcResult::ok(UpdatePubkeyInfo {
        pubkey_b64: body.pubkey_b64,
        algorithm: body.algorithm,
    })
}

// ─── IPC: 走 backend 校验签名拿 latest.json ───────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedUpdateCheck {
    /// latest.json 原文（透传给上层 UI / Tauri updater 用）
    pub body: String,
    /// X-Kite-Signature header 值（base64 ed25519）
    pub signature_b64: String,
    /// 用本机缓存 pubkey 验签结果。false = 警告，但 body 仍然返回让 UI 决定
    pub signature_valid: bool,
    /// 是否走了 backend 缓存（X-Cache: HIT）
    pub from_cache: bool,
    /// 客户端是否有 pubkey 可验。false = UI 应提示先 fetch_update_pubkey
    pub pubkey_cached: bool,
}

#[tauri::command]
pub async fn account_check_update_signed(app: AppHandle) -> IpcResult<SignedUpdateCheck> {
    let account = load_account(&app);
    if account.server_url.is_empty() {
        return IpcResult::err("尚未配置 backend URL".to_string());
    }
    let client = match http_client() {
        Ok(c) => c,
        Err(e) => return IpcResult::err(e),
    };
    let url = format!("{}/api/updates/latest.json", account.server_url);
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => return IpcResult::err(format!("请求失败: {}", e)),
    };
    if !resp.status().is_success() {
        return IpcResult::err(format!("后端拒绝: HTTP {}", resp.status().as_u16()));
    }
    let signature_b64 = resp
        .headers()
        .get("x-kite-signature")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let from_cache = resp
        .headers()
        .get("x-cache")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.eq_ignore_ascii_case("HIT"))
        .unwrap_or(false);
    let body = match resp.text().await {
        Ok(t) => t,
        Err(e) => return IpcResult::err(format!("读取响应失败: {}", e)),
    };

    // 用本机缓存 pubkey 验签
    let pubkey_cached = !account.update_pubkey_b64.is_empty();
    let signature_valid = if pubkey_cached && !signature_b64.is_empty() {
        verify_signature(&account.update_pubkey_b64, &signature_b64, body.as_bytes())
            .unwrap_or(false)
    } else {
        false
    };

    IpcResult::ok(SignedUpdateCheck {
        body,
        signature_b64,
        signature_valid,
        from_cache,
        pubkey_cached,
    })
}

// ─── 纯函数：ed25519 验签（拿出来便于单元测试）────────────────────────────

pub(super) fn verify_signature(
    pubkey_b64: &str,
    signature_b64: &str,
    body: &[u8],
) -> Result<bool, String> {
    let pub_bytes = b64_decode(pubkey_b64).map_err(|e| format!("pubkey 解码: {}", e))?;
    let sig_bytes = b64_decode(signature_b64).map_err(|e| format!("signature 解码: {}", e))?;

    if pub_bytes.len() != 32 {
        return Err(format!("ed25519 pubkey 须 32 字节，实际 {}", pub_bytes.len()));
    }
    if sig_bytes.len() != 64 {
        return Err(format!("ed25519 signature 须 64 字节，实际 {}", sig_bytes.len()));
    }
    let pub_array: [u8; 32] = pub_bytes.try_into().expect("checked above");
    let sig_array: [u8; 64] = sig_bytes.try_into().expect("checked above");

    let verifying_key = VerifyingKey::from_bytes(&pub_array)
        .map_err(|e| format!("无效 pubkey: {}", e))?;
    let signature = Signature::from_bytes(&sig_array);
    Ok(verifying_key.verify(body, &signature).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use rand::rngs::OsRng;
    use rand::RngCore;

    use super::super::account::b64_encode;

    fn make_keypair() -> SigningKey {
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        SigningKey::from_bytes(&seed)
    }

    #[test]
    fn valid_signature_verifies() {
        let key = make_keypair();
        let body = b"{\"version\":\"1.0.2\"}";
        let sig = key.sign(body);
        let result = verify_signature(
            &b64_encode(key.verifying_key().to_bytes().as_slice()),
            &b64_encode(sig.to_bytes().as_slice()),
            body,
        )
        .unwrap();
        assert!(result);
    }

    #[test]
    fn tampered_body_fails() {
        let key = make_keypair();
        let original = b"{\"version\":\"1.0.2\"}";
        let sig = key.sign(original);
        let tampered = b"{\"version\":\"1.0.3\"}";
        let result = verify_signature(
            &b64_encode(key.verifying_key().to_bytes().as_slice()),
            &b64_encode(sig.to_bytes().as_slice()),
            tampered,
        )
        .unwrap();
        assert!(!result);
    }

    #[test]
    fn wrong_pubkey_fails() {
        let key1 = make_keypair();
        let key2 = make_keypair();
        let body = b"hello";
        let sig = key1.sign(body);
        let result = verify_signature(
            &b64_encode(key2.verifying_key().to_bytes().as_slice()),
            &b64_encode(sig.to_bytes().as_slice()),
            body,
        )
        .unwrap();
        assert!(!result);
    }

    #[test]
    fn wrong_size_pubkey_errors() {
        let result = verify_signature("short", "AAAAAA", b"x");
        assert!(result.is_err());
    }
}

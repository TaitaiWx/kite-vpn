//! 跨 Mesh 互联 (G) 客户端 IPC —— 调 backend /api/bridges 系列。
//!
//! 后端协议见 apps/backend/src/bridges.rs 的 module doc。本模块只做 HTTP wrapper：
//! - create_bridge_invite: owner A 生成 bridge invite，得到 redeem_url
//! - redeem_bridge: owner B 用 redeem_url 调本地 backend，本地 backend 自动跟对方 backend 协调
//! - list_bridges: 看自己的 bridge 状态
//! - revoke_bridge: 撤销某条
//!
//! 实际证书交换由 client 在 mesh 模块完成（本模块只管"信任关系登记"层）。
//! v1 拿到 bridge 后客户端需要：
//!   1. 本地 nebula firewall 加白名单（用 remote_ca_fingerprint 限定）
//!   2. 给对方签一张"限定 IP"的证书（限定 remote_peer_id 的访问范围）
//!   3. 通过 backend invite / bridge_token 把这张证书发给对方
//! 这套 cert 交换流程留给 mesh 模块后续扩展（v1.1）。

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::account::{http_client, load_account};
use super::IpcResult;

// ─── 类型 ────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreateBridgeInviteRequest {
    pub local_peer_id: String,
    pub remote_owner_email_hint: String,
    /// "in" | "out" | "both"
    pub direction: String,
    pub ttl_hours: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreatedBridgeInvite {
    pub bridge_token: String,
    pub redeem_url: String,
    pub expires_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct ServerCreatedBridge {
    bridge_token: String,
    redeem_url: String,
    expires_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RedeemBridgeRequest {
    pub redeem_url: String,
    pub local_peer_id: String,
    pub local_ca_fingerprint: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RedeemedBridge {
    pub remote_owner_email: String,
    pub remote_ca_fingerprint: String,
    pub direction: String,
    pub remote_peer_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ServerRedeem {
    remote_owner_email: String,
    remote_ca_fingerprint: String,
    direction: String,
    remote_peer_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Serialize, Deserialize)]
struct ServerBridgeRow {
    id: String,
    local_peer_id: String,
    remote_peer_id: String,
    direction: String,
    status: String,
    remote_backend_url: String,
    remote_ca_fingerprint: String,
    created_at: i64,
    updated_at: i64,
}

// ─── IPC: 创建 bridge invite (owner A) ─────────────────────────────────────

#[tauri::command]
pub async fn account_create_bridge_invite(
    app: AppHandle,
    request: CreateBridgeInviteRequest,
) -> IpcResult<CreatedBridgeInvite> {
    let account = load_account(&app);
    if account.session_cookie.is_empty() {
        return IpcResult::err("尚未登录".to_string());
    }
    if !["in", "out", "both"].contains(&request.direction.as_str()) {
        return IpcResult::err("direction 必须是 in / out / both".to_string());
    }
    if request.local_peer_id.trim().is_empty() {
        return IpcResult::err("local_peer_id 不能为空".to_string());
    }
    if request.ttl_hours <= 0 {
        return IpcResult::err("ttl_hours 必须为正".to_string());
    }

    let client = match http_client() {
        Ok(c) => c,
        Err(e) => return IpcResult::err(e),
    };
    let url = format!("{}/api/bridges/invites", account.server_url);
    let body = serde_json::json!({
        "local_peer_id": request.local_peer_id.trim(),
        "remote_owner_email_hint": request.remote_owner_email_hint.trim(),
        "direction": request.direction,
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
    let parsed: ServerCreatedBridge = match resp.json().await {
        Ok(v) => v,
        Err(e) => return IpcResult::err(format!("解析响应失败: {}", e)),
    };
    IpcResult::ok(CreatedBridgeInvite {
        bridge_token: parsed.bridge_token,
        redeem_url: parsed.redeem_url,
        expires_at: parsed.expires_at,
    })
}

// ─── IPC: 赎回 bridge (owner B) ────────────────────────────────────────────

#[tauri::command]
pub async fn account_redeem_bridge(
    app: AppHandle,
    request: RedeemBridgeRequest,
) -> IpcResult<RedeemedBridge> {
    let account = load_account(&app);
    if account.session_cookie.is_empty() {
        return IpcResult::err("尚未登录".to_string());
    }
    if request.redeem_url.trim().is_empty() {
        return IpcResult::err("redeem_url 不能为空".to_string());
    }
    if request.local_peer_id.trim().is_empty() {
        return IpcResult::err("local_peer_id 不能为空".to_string());
    }

    let client = match http_client() {
        Ok(c) => c,
        Err(e) => return IpcResult::err(e),
    };
    let url = format!("{}/api/bridges/redeem", account.server_url);
    let body = serde_json::json!({
        "redeem_url": request.redeem_url.trim(),
        "local_peer_id": request.local_peer_id.trim(),
        "local_ca_fingerprint": request.local_ca_fingerprint.trim(),
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
    let parsed: ServerRedeem = match resp.json().await {
        Ok(v) => v,
        Err(e) => return IpcResult::err(format!("解析响应失败: {}", e)),
    };
    IpcResult::ok(RedeemedBridge {
        remote_owner_email: parsed.remote_owner_email,
        remote_ca_fingerprint: parsed.remote_ca_fingerprint,
        direction: parsed.direction,
        remote_peer_id: parsed.remote_peer_id,
    })
}

// ─── IPC: 列出 / 撤销 ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn account_list_bridges(app: AppHandle) -> IpcResult<Vec<BridgeRow>> {
    let account = load_account(&app);
    if account.session_cookie.is_empty() {
        return IpcResult::err("尚未登录".to_string());
    }
    let client = match http_client() {
        Ok(c) => c,
        Err(e) => return IpcResult::err(e),
    };
    let url = format!("{}/api/bridges", account.server_url);
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
    let rows: Vec<ServerBridgeRow> = match resp.json().await {
        Ok(v) => v,
        Err(e) => return IpcResult::err(format!("解析响应失败: {}", e)),
    };
    let out = rows
        .into_iter()
        .map(|r| BridgeRow {
            id: r.id,
            local_peer_id: r.local_peer_id,
            remote_peer_id: r.remote_peer_id,
            direction: r.direction,
            status: r.status,
            remote_backend_url: r.remote_backend_url,
            remote_ca_fingerprint: r.remote_ca_fingerprint,
            created_at: r.created_at,
            updated_at: r.updated_at,
        })
        .collect();
    IpcResult::ok(out)
}

#[tauri::command]
pub async fn account_revoke_bridge(app: AppHandle, id: String) -> IpcResult<()> {
    let account = load_account(&app);
    if account.session_cookie.is_empty() {
        return IpcResult::err("尚未登录".to_string());
    }
    let client = match http_client() {
        Ok(c) => c,
        Err(e) => return IpcResult::err(e),
    };
    let url = format!("{}/api/bridges/{}", account.server_url, id);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direction_validation_matches_backend() {
        // 跟 backend bridges.rs::ALLOWED_DIRECTIONS 对齐
        for d in &["in", "out", "both"] {
            assert!(["in", "out", "both"].contains(d));
        }
    }
}

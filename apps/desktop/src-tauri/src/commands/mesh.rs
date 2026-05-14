//! Mesh 网络 IPC（Phase 4，基于 Nebula sidecar）。
//!
//! 这一版是**框架 + 序列化契约**，不真正启动 nebula 进程。等 sidecar 集成完成
//! 后会回填实际逻辑。先把 IPC 形状钉死，让前端可以并行开发。
//!
//! 设计原则（per workspace claude.md）：
//! - 业界最佳实践：用 serde 显式 rename camelCase 跟 TS 端对齐
//! - 禁止隐藏变量：所有 IPC 入参 / 返回值类型显式，不用 serde_json::Value 偷懒
//! - 多写测试：每个公开类型有 round-trip serde 测试
//!
//! 当 nebula sidecar 真正集成后，每个 #[tauri::command] 函数的 body 会调
//! nebula-cert / nebula 子进程；类型签名不变。
//!
//! 详细设计见：
//! ~/.gstack/projects/vpn/fengwenxuan-main-design-20260514-015705-mesh.md

use serde::{Deserialize, Serialize};

use super::IpcResult;

// ─── 类型定义（跟 packages/types/src/mesh.ts 对齐） ─────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MeshPeerRole {
    Owner,
    Member,
    Exit,
    Subnet,
    Lighthouse,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MeshPeerStatus {
    Online,
    Offline,
    Handshaking,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MeshEngineStatus {
    Stopped,
    Starting,
    Running,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshPeer {
    pub id: String,
    pub name: String,
    pub mesh_ip: String,
    pub roles: Vec<MeshPeerRole>,
    pub status: MeshPeerStatus,
    pub last_seen_at: i64,
    pub public_endpoint: String,
    pub enrolled_at: i64,
    pub cert_expires_at: i64,
    pub advertised_subnet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshNetwork {
    pub id: String,
    pub name: String,
    pub cidr: String,
    pub lighthouse_endpoint: String,
    pub created_at: i64,
    pub self_peer_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshEnrollmentToken {
    pub token: String,
    pub peer_name: String,
    pub roles: Vec<MeshPeerRole>,
    pub mesh_ip: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshEngineState {
    pub status: MeshEngineStatus,
    pub pid: u32,
    pub version: String,
    pub error: String,
}

impl MeshEngineState {
    /// Helper: 默认"已停止"状态，所有数值字段显式为 0 / 空字符串，
    /// 符合"禁止滥用 Option 隐藏空值"原则。
    pub fn stopped() -> Self {
        Self {
            status: MeshEngineStatus::Stopped,
            pid: 0,
            version: String::new(),
            error: String::new(),
        }
    }
}

// ─── IPC 命令（v1 framework 阶段：全部返回未实现状态） ─────────────────────

const NOT_IMPLEMENTED: &str = "Mesh sidecar 尚未集成 —— framework only, 等待 nebula 二进制就位";

/// 查询 Mesh 引擎运行状态。
#[tauri::command]
pub async fn mesh_get_engine_state() -> IpcResult<MeshEngineState> {
    IpcResult::ok(MeshEngineState::stopped())
}

/// 启动 Mesh 引擎（前提：本设备已加入某个网络，配置文件已落盘）。
#[tauri::command]
pub async fn mesh_start() -> IpcResult<MeshEngineState> {
    IpcResult::err(NOT_IMPLEMENTED)
}

/// 停止 Mesh 引擎。
#[tauri::command]
pub async fn mesh_stop() -> IpcResult<MeshEngineState> {
    IpcResult::err(NOT_IMPLEMENTED)
}

/// 列出本设备所在网络的所有 peers。
#[tauri::command]
pub async fn mesh_list_peers() -> IpcResult<Vec<MeshPeer>> {
    IpcResult::ok(Vec::new())
}

/// 当前网络元数据。未加入任何网络时返回 None。
#[tauri::command]
pub async fn mesh_get_network() -> IpcResult<Option<MeshNetwork>> {
    IpcResult::ok(None)
}

/// 创建新的 Mesh 网络（首次启动 Kite 用）。
/// 生成 CA + owner 证书 + 默认配置。返回创建好的网络元数据。
#[tauri::command]
pub async fn mesh_create_network(name: String, lighthouse_endpoint: String) -> IpcResult<MeshNetwork> {
    let _ = (name, lighthouse_endpoint);
    IpcResult::err(NOT_IMPLEMENTED)
}

/// Owner 生成一次性 enrollment token，供新设备加入。
#[tauri::command]
pub async fn mesh_generate_enrollment_token(
    peer_name: String,
    roles: Vec<MeshPeerRole>,
) -> IpcResult<MeshEnrollmentToken> {
    let _ = (peer_name, roles);
    IpcResult::err(NOT_IMPLEMENTED)
}

/// 新设备用 token 加入网络。
#[tauri::command]
pub async fn mesh_join_network(token: String) -> IpcResult<MeshNetwork> {
    let _ = token;
    IpcResult::err(NOT_IMPLEMENTED)
}

/// 撤销一个 peer（Owner only）。
#[tauri::command]
pub async fn mesh_revoke_peer(peer_id: String) -> IpcResult<()> {
    let _ = peer_id;
    IpcResult::err(NOT_IMPLEMENTED)
}

// ─── 单元测试（rule 4：多写测试 case） ──────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_status_serializes_lowercase() {
        let s = serde_json::to_string(&MeshEngineStatus::Stopped).unwrap();
        assert_eq!(s, "\"stopped\"");
        let s = serde_json::to_string(&MeshEngineStatus::Running).unwrap();
        assert_eq!(s, "\"running\"");
    }

    #[test]
    fn peer_role_serializes_lowercase() {
        let s = serde_json::to_string(&MeshPeerRole::Owner).unwrap();
        assert_eq!(s, "\"owner\"");
        let s = serde_json::to_string(&MeshPeerRole::Lighthouse).unwrap();
        assert_eq!(s, "\"lighthouse\"");
    }

    #[test]
    fn peer_round_trip_camelcase() {
        let peer = MeshPeer {
            id: "abc123".into(),
            name: "Mac 笔记本".into(),
            mesh_ip: "100.64.0.2".into(),
            roles: vec![MeshPeerRole::Member, MeshPeerRole::Subnet],
            status: MeshPeerStatus::Online,
            last_seen_at: 1_700_000_000_000,
            public_endpoint: "203.0.113.5:4242".into(),
            enrolled_at: 1_690_000_000_000,
            cert_expires_at: 1_720_000_000_000,
            advertised_subnet: "192.168.1.0/24".into(),
        };
        let json = serde_json::to_string(&peer).unwrap();
        // 确认 camelCase rename 生效
        assert!(json.contains("\"meshIp\":\"100.64.0.2\""));
        assert!(json.contains("\"lastSeenAt\":1700000000000"));
        assert!(json.contains("\"advertisedSubnet\":\"192.168.1.0/24\""));
        // 反序列化往返
        let restored: MeshPeer = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.id, peer.id);
        assert_eq!(restored.mesh_ip, peer.mesh_ip);
        assert_eq!(restored.roles.len(), 2);
    }

    #[test]
    fn engine_state_stopped_has_zero_pid_and_empty_strings() {
        let s = MeshEngineState::stopped();
        assert_eq!(s.pid, 0);
        assert_eq!(s.version, "");
        assert_eq!(s.error, "");
        assert!(matches!(s.status, MeshEngineStatus::Stopped));
    }

    #[test]
    fn enrollment_token_round_trip() {
        let t = MeshEnrollmentToken {
            token: "AAAAAAAA-BBBBBBBB-CCCC".into(),
            peer_name: "iPhone".into(),
            roles: vec![MeshPeerRole::Member],
            mesh_ip: "100.64.0.5".into(),
            expires_at: 1_700_000_600_000,
        };
        let json = serde_json::to_string(&t).unwrap();
        assert!(json.contains("\"peerName\":\"iPhone\""));
        assert!(json.contains("\"meshIp\":\"100.64.0.5\""));
        let restored: MeshEnrollmentToken = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.token, t.token);
    }

    #[tokio::test]
    async fn stub_engine_state_returns_stopped() {
        let result = mesh_get_engine_state().await;
        assert!(result.success);
        let state = result.data.unwrap();
        assert!(matches!(state.status, MeshEngineStatus::Stopped));
        assert_eq!(state.pid, 0);
    }

    #[tokio::test]
    async fn stub_start_returns_not_implemented_err() {
        let result = mesh_start().await;
        assert!(!result.success);
        assert!(result.error.unwrap().contains("尚未集成"));
    }

    #[tokio::test]
    async fn stub_list_peers_returns_empty() {
        let result = mesh_list_peers().await;
        assert!(result.success);
        assert!(result.data.unwrap().is_empty());
    }
}

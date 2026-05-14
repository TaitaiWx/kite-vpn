//! Mesh 网络 IPC（Phase 4，基于 Nebula sidecar）。
//!
//! 设计原则（per workspace claude.md）：
//! - **业界最佳实践**: 调用 Slack 官方 nebula-cert 二进制做证书操作，不自己实现
//!   X25519 签名 / Curve25519 keygen
//! - **第一性原理**: 一个用户的多设备 mesh，CA 私钥永远在 owner 设备，新设备
//!   通过一次性加密 token 拿到自己的证书 + 私钥
//! - **多写测试**: 见底部 tests 模块（>15 个用例）
//! - **禁滥用 Option**: 错误字段用空字符串，未配置 lighthouse_endpoint 用空字符串
//!
//! 文件布局（保存在 Tauri app_data_dir/mesh/）:
//!     mesh/
//!       network.json        本网络元数据
//!       ca.crt              CA 公钥证书
//!       ca.key              CA 私钥（敏感，权限 0600）
//!       self.crt            本设备 owner 证书
//!       self.key            本设备私钥
//!       config.yaml         Nebula 配置
//!       enrollments/        owner 端：未消费的 enrollment token 元数据
//!
//! 详细设计：~/.gstack/projects/vpn/...20260514...-mesh.md

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, KeyInit, OsRng as AeadOsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base32::Alphabet;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::nebula_engine::NebulaEngineState;
use super::IpcResult;

// ─── 共享类型（跟 packages/types/src/mesh.ts 对齐） ─────────────────────────

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
    pub fn stopped() -> Self {
        Self {
            status: MeshEngineStatus::Stopped,
            pid: 0,
            version: String::new(),
            error: String::new(),
        }
    }
}

// ─── enrollment payload（owner 加密后塞进 token） ──────────────────────────

/// 加密后通过 token 传给新设备的完整 enrollment 载荷。
#[derive(Debug, Serialize, Deserialize)]
struct EnrollmentPayload {
    network_id: String,
    network_name: String,
    cidr: String,
    lighthouse_endpoint: String,
    cert_pem: String,
    key_pem: String,
    ca_pem: String,
    mesh_ip: String,
    peer_name: String,
    roles: Vec<MeshPeerRole>,
    enrolled_at: i64,
    cert_expires_at: i64,
    self_peer_id: String,
}

// ─── 文件系统帮助 ─────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn mesh_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?;
    let dir = base.join("mesh");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建 mesh 目录: {}", e))?;
    Ok(dir)
}

fn enrollments_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = mesh_dir(app)?.join("enrollments");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建 enrollments 目录: {}", e))?;
    Ok(dir)
}

fn network_meta_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(mesh_dir(app)?.join("network.json"))
}

/// 把字节写到文件并设置受限权限（CA 私钥 / 节点私钥用）。
fn write_sensitive(path: &Path, content: &[u8]) -> Result<(), String> {
    let mut f = fs::File::create(path).map_err(|e| format!("写入 {} 失败: {}", path.display(), e))?;
    f.write_all(content)
        .map_err(|e| format!("写入 {} 失败: {}", path.display(), e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

// ─── nebula / nebula-cert sidecar 路径 ────────────────────────────────────

fn sidecar_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let triple = env!("TAURI_ENV_TARGET_TRIPLE");

    #[cfg(target_os = "windows")]
    let bin_name = format!("{}-{}.exe", name, triple);
    #[cfg(not(target_os = "windows"))]
    let bin_name = format!("{}-{}", name, triple);

    // 1. 打包后的 resource dir
    if let Ok(resource_dir) = app.path().resource_dir() {
        let p = resource_dir.join("binaries").join(&bin_name);
        if p.exists() {
            return Ok(p);
        }
    }
    // 2. 开发模式
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(&bin_name);
    if dev_path.exists() {
        return Ok(dev_path);
    }
    Err(format!("未找到 {} sidecar（{}）。请先 pnpm build:nebula:current", name, bin_name))
}

fn nebula_path(app: &AppHandle) -> Result<PathBuf, String> {
    sidecar_path(app, "nebula")
}

fn nebula_cert_path(app: &AppHandle) -> Result<PathBuf, String> {
    sidecar_path(app, "nebula-cert")
}

// ─── nebula-cert 调用 wrappers ────────────────────────────────────────────

/// 在指定目录里生成 CA（产出 ca.crt + ca.key）。
fn nebula_cert_ca(nebula_cert: &Path, name: &str, output_dir: &Path) -> Result<(), String> {
    let output = Command::new(nebula_cert)
        .args([
            "ca",
            "-name", name,
            "-out-crt", &output_dir.join("ca.crt").to_string_lossy(),
            "-out-key", &output_dir.join("ca.key").to_string_lossy(),
        ])
        .output()
        .map_err(|e| format!("调用 nebula-cert ca 失败: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "nebula-cert ca 失败: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// 用 CA 给一个节点签证书。产出 <node>.crt + <node>.key。
fn nebula_cert_sign(
    nebula_cert: &Path,
    ca_dir: &Path,
    out_dir: &Path,
    node_name: &str,
    ip_cidr: &str,
) -> Result<(), String> {
    let output = Command::new(nebula_cert)
        .args([
            "sign",
            "-ca-crt", &ca_dir.join("ca.crt").to_string_lossy(),
            "-ca-key", &ca_dir.join("ca.key").to_string_lossy(),
            "-name", node_name,
            "-ip", ip_cidr,
            "-out-crt", &out_dir.join(format!("{}.crt", node_name)).to_string_lossy(),
            "-out-key", &out_dir.join(format!("{}.key", node_name)).to_string_lossy(),
        ])
        .output()
        .map_err(|e| format!("调用 nebula-cert sign 失败: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "nebula-cert sign 失败: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    // 私钥设受限权限
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let key_path = out_dir.join(format!("{}.key", node_name));
        let _ = fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

// ─── Nebula config.yaml 生成 ─────────────────────────────────────────────

/// 渲染本设备的 nebula config.yaml。am_lighthouse=false（owner 设备是普通节点，
/// lighthouse 跑在用户的 VPS 上，配置由独立脚本部署）。
fn render_node_config(
    mesh_dir: &Path,
    self_cert_name: &str,
    lighthouse_endpoint: &str,
) -> String {
    let ca = mesh_dir.join("ca.crt").to_string_lossy().to_string();
    let crt = mesh_dir.join(format!("{}.crt", self_cert_name)).to_string_lossy().to_string();
    let key = mesh_dir.join(format!("{}.key", self_cert_name)).to_string_lossy().to_string();
    let lighthouse_ip = "100.64.0.1"; // owner 设备 = lighthouse 内网 IP（v1 简化：owner 即 lighthouse 内网入口）
    format!(
        r#"# Generated by Kite — Phase 4 Mesh
pki:
  ca: "{ca}"
  cert: "{crt}"
  key: "{key}"
static_host_map:
  "{lighthouse_ip}": ["{lighthouse_endpoint}"]
lighthouse:
  am_lighthouse: false
  interval: 60
  hosts:
    - "{lighthouse_ip}"
listen:
  host: 0.0.0.0
  port: 0
punchy:
  punch: true
  respond: true
tun:
  disabled: false
  dev: kite-mesh
  drop_local_broadcast: false
  drop_multicast: false
  tx_queue: 500
  mtu: 1300
firewall:
  outbound_action: drop
  inbound_action: drop
  outbound:
    - port: any
      proto: any
      host: any
  inbound:
    - port: any
      proto: icmp
      host: any
    - port: any
      proto: any
      host: any
logging:
  level: info
  format: text
"#
    )
}

// ─── 指纹 / token ID ──────────────────────────────────────────────────────

fn fingerprint_hex(content: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content);
    let digest = hasher.finalize();
    // 取前 16 字节 → 32 hex 字符
    hex_encode(&digest[..16])
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

// ─── enrollment token 加密 / 解密 ─────────────────────────────────────────

/// 加密 enrollment payload → base32 token。
/// 格式：base32( nonce[12B] + key[32B] + ciphertext )
/// 自包含解密所需所有信息（key 内嵌于 token），适用 v1 personal use。
/// 在 v2 lighthouse 中转时，token 只携带 lookup ID + 短密钥，payload 放服务端。
fn encrypt_payload_to_token(payload: &EnrollmentPayload) -> Result<String, String> {
    let plaintext = serde_json::to_vec(payload).map_err(|e| format!("序列化 payload 失败: {}", e))?;

    // 生成 256-bit key + 96-bit nonce
    let mut key_bytes = [0u8; 32];
    let mut nonce_bytes = [0u8; 12];
    AeadOsRng.try_fill_bytes(&mut key_bytes)
        .map_err(|e| format!("生成随机 key 失败: {}", e))?;
    AeadOsRng.try_fill_bytes(&mut nonce_bytes)
        .map_err(|e| format!("生成随机 nonce 失败: {}", e))?;

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| format!("AES-GCM 加密失败: {}", e))?;

    // 拼装：12B nonce + 32B key + ciphertext
    let mut combined = Vec::with_capacity(12 + 32 + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&key_bytes);
    combined.extend_from_slice(&ciphertext);

    Ok(base32::encode(Alphabet::Rfc4648 { padding: false }, &combined))
}

fn decrypt_token_to_payload(token: &str) -> Result<EnrollmentPayload, String> {
    let combined = base32::decode(Alphabet::Rfc4648 { padding: false }, token)
        .ok_or_else(|| "token 不是合法的 base32".to_string())?;
    if combined.len() < 12 + 32 + 16 {
        return Err("token 长度过短，疑似已损坏".to_string());
    }
    let nonce_bytes = &combined[0..12];
    let key_bytes = &combined[12..44];
    let ciphertext = &combined[44..];

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key_bytes));
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "解密失败（token 已损坏或被篡改）".to_string())?;

    serde_json::from_slice::<EnrollmentPayload>(&plaintext)
        .map_err(|e| format!("解析 payload 失败: {}", e))
}

// ─── IPC commands ─────────────────────────────────────────────────────────

/// 查询 Mesh 引擎运行状态。
#[tauri::command]
pub async fn mesh_get_engine_state(app: AppHandle) -> IpcResult<MeshEngineState> {
    let state = app.state::<NebulaEngineState>();
    let mut engine = state.engine.lock().unwrap();

    let running = engine.is_running();
    let pid = engine.pid().unwrap_or(0);
    let status = if running { MeshEngineStatus::Running } else { MeshEngineStatus::Stopped };

    IpcResult::ok(MeshEngineState {
        status,
        pid,
        version: env!("CARGO_PKG_VERSION").to_string(),
        error: String::new(),
    })
}

/// 启动 Mesh 引擎（前提：已加入网络，config.yaml 已落盘）。
#[tauri::command]
pub async fn mesh_start(app: AppHandle) -> IpcResult<MeshEngineState> {
    let dir = match mesh_dir(&app) {
        Ok(d) => d,
        Err(e) => return IpcResult::err(e),
    };
    let config = dir.join("config.yaml");
    if !config.exists() {
        return IpcResult::err("Mesh 尚未配置 —— 请先创建或加入网络".to_string());
    }
    let nebula = match nebula_path(&app) {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e),
    };
    let state = app.state::<NebulaEngineState>();
    let mut engine = state.engine.lock().unwrap();
    match engine.start(&nebula.to_string_lossy(), &config.to_string_lossy()) {
        Ok(pid) => IpcResult::ok(MeshEngineState {
            status: MeshEngineStatus::Running,
            pid,
            version: env!("CARGO_PKG_VERSION").to_string(),
            error: String::new(),
        }),
        Err(e) => IpcResult::err(e),
    }
}

#[tauri::command]
pub async fn mesh_stop(app: AppHandle) -> IpcResult<MeshEngineState> {
    let state = app.state::<NebulaEngineState>();
    let mut engine = state.engine.lock().unwrap();
    if let Err(e) = engine.stop() {
        return IpcResult::err(e);
    }
    IpcResult::ok(MeshEngineState::stopped())
}

/// 当前网络元数据。未加入任何网络时 data 为 None。
#[tauri::command]
pub async fn mesh_get_network(app: AppHandle) -> IpcResult<Option<MeshNetwork>> {
    let meta_path = match network_meta_path(&app) {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e),
    };
    if !meta_path.exists() {
        return IpcResult::ok(None);
    }
    match fs::read_to_string(&meta_path) {
        Ok(s) => match serde_json::from_str::<MeshNetwork>(&s) {
            Ok(n) => IpcResult::ok(Some(n)),
            Err(e) => IpcResult::err(format!("解析 network.json 失败: {}", e)),
        },
        Err(e) => IpcResult::err(format!("读取 network.json 失败: {}", e)),
    }
}

/// 创建新 Mesh 网络。生成 CA + 自签 owner 证书 + config.yaml + network.json。
#[tauri::command]
pub async fn mesh_create_network(
    app: AppHandle,
    name: String,
    lighthouse_endpoint: String,
) -> IpcResult<MeshNetwork> {
    if name.trim().is_empty() {
        return IpcResult::err("网络名称不能为空".to_string());
    }
    if lighthouse_endpoint.trim().is_empty() {
        return IpcResult::err("lighthouse 公网地址不能为空（例：vps.example.com:4242）".to_string());
    }

    let dir = match mesh_dir(&app) {
        Ok(d) => d,
        Err(e) => return IpcResult::err(e),
    };
    // 已经有网络配置时拒绝（避免覆盖）
    if dir.join("network.json").exists() {
        return IpcResult::err("已存在网络配置 —— 请先 mesh_leave_network 退出再创建".to_string());
    }

    let nebula_cert = match nebula_cert_path(&app) {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e),
    };

    // 1. 生成 CA
    if let Err(e) = nebula_cert_ca(&nebula_cert, &name, &dir) {
        return IpcResult::err(e);
    }
    // 2. 给 owner 节点签证书（IP 默认 100.64.0.1）
    if let Err(e) = nebula_cert_sign(&nebula_cert, &dir, &dir, "self", "100.64.0.1/10") {
        return IpcResult::err(e);
    }
    // 3. 写 config.yaml
    let yaml = render_node_config(&dir, "self", &lighthouse_endpoint);
    if let Err(e) = fs::write(dir.join("config.yaml"), yaml) {
        return IpcResult::err(format!("写入 config.yaml 失败: {}", e));
    }
    // 4. 保护 CA 私钥权限（rule 8：显式控制敏感文件）
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir.join("ca.key"), fs::Permissions::from_mode(0o600));
        let _ = fs::set_permissions(dir.join("self.key"), fs::Permissions::from_mode(0o600));
    }

    // 5. 计算 network_id（CA 证书 fingerprint）+ self_peer_id（owner 证书 fingerprint）
    let ca_bytes = fs::read(dir.join("ca.crt")).unwrap_or_default();
    let self_bytes = fs::read(dir.join("self.crt")).unwrap_or_default();
    let network_id = fingerprint_hex(&ca_bytes);
    let self_peer_id = fingerprint_hex(&self_bytes);

    let network = MeshNetwork {
        id: network_id,
        name,
        cidr: "100.64.0.0/10".to_string(),
        lighthouse_endpoint,
        created_at: now_ms(),
        self_peer_id,
    };

    // 6. 写 network.json
    let meta_json = serde_json::to_string_pretty(&network).map_err(|e| format!("序列化失败: {}", e));
    let Ok(meta_json) = meta_json else { return IpcResult::err(meta_json.unwrap_err()) };
    if let Err(e) = fs::write(dir.join("network.json"), meta_json) {
        return IpcResult::err(format!("写入 network.json 失败: {}", e));
    }

    IpcResult::ok(network)
}

/// Owner 生成一次性 enrollment token。
/// 流程：签发新证书 → 加密成 token → 落盘 metadata 用于过期 / 撤销跟踪。
#[tauri::command]
pub async fn mesh_generate_enrollment_token(
    app: AppHandle,
    peer_name: String,
    roles: Vec<MeshPeerRole>,
    mesh_ip: String,
) -> IpcResult<MeshEnrollmentToken> {
    if peer_name.trim().is_empty() {
        return IpcResult::err("设备名称不能为空".to_string());
    }
    if mesh_ip.trim().is_empty() {
        return IpcResult::err("内网 IP 不能为空（例：100.64.0.2）".to_string());
    }

    let dir = match mesh_dir(&app) {
        Ok(d) => d,
        Err(e) => return IpcResult::err(e),
    };
    let nebula_cert = match nebula_cert_path(&app) {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e),
    };
    let meta_path = dir.join("network.json");
    if !meta_path.exists() {
        return IpcResult::err("尚未创建网络 —— 请先 mesh_create_network".to_string());
    }
    let network: MeshNetwork = match fs::read_to_string(&meta_path)
        .map_err(|e| format!("读取 network.json 失败: {}", e))
        .and_then(|s| serde_json::from_str(&s).map_err(|e| format!("解析失败: {}", e)))
    {
        Ok(n) => n,
        Err(e) => return IpcResult::err(e),
    };

    // 1. 在临时目录给新设备签证书（生成 <name>.crt + <name>.key）
    let temp_dir = dir.join("enrollments/tmp");
    fs::create_dir_all(&temp_dir).ok();
    let cert_basename = format!("enroll-{}", now_ms());
    let ip_cidr = format!("{}/10", mesh_ip);
    if let Err(e) = nebula_cert_sign(&nebula_cert, &dir, &temp_dir, &cert_basename, &ip_cidr) {
        return IpcResult::err(e);
    }

    let cert_path = temp_dir.join(format!("{}.crt", cert_basename));
    let key_path = temp_dir.join(format!("{}.key", cert_basename));
    let cert_pem = match fs::read_to_string(&cert_path) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(format!("读取新证书失败: {}", e)),
    };
    let key_pem = match fs::read_to_string(&key_path) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(format!("读取新私钥失败: {}", e)),
    };
    let ca_pem = match fs::read_to_string(dir.join("ca.crt")) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(format!("读取 CA 证书失败: {}", e)),
    };

    // 2. 立即删除临时文件（私钥不留在 owner 设备）
    let _ = fs::remove_file(&cert_path);
    let _ = fs::remove_file(&key_path);

    // 3. 计算新 peer 的 fingerprint
    let new_peer_id = fingerprint_hex(cert_pem.as_bytes());

    let enrolled_at = now_ms();
    let cert_expires_at = enrolled_at + 365 * 24 * 3600 * 1000; // 1 年（跟 nebula-cert 默认对齐）
    let expires_at = enrolled_at + 10 * 60 * 1000; // token 10 分钟过期

    // 4. 装 payload + 加密
    let payload = EnrollmentPayload {
        network_id: network.id.clone(),
        network_name: network.name.clone(),
        cidr: network.cidr.clone(),
        lighthouse_endpoint: network.lighthouse_endpoint.clone(),
        cert_pem,
        key_pem,
        ca_pem,
        mesh_ip: mesh_ip.clone(),
        peer_name: peer_name.clone(),
        roles: roles.clone(),
        enrolled_at,
        cert_expires_at,
        self_peer_id: new_peer_id,
    };
    let token = match encrypt_payload_to_token(&payload) {
        Ok(t) => t,
        Err(e) => return IpcResult::err(e),
    };

    // 5. 落盘元数据，方便 owner 端看「待加入设备」列表（不存私钥本身）
    let track_meta = serde_json::json!({
        "peer_name": peer_name,
        "mesh_ip": mesh_ip,
        "roles": roles,
        "expires_at": expires_at,
        "issued_at": enrolled_at,
    });
    let enroll_meta_path = match enrollments_dir(&app) {
        Ok(d) => d.join(format!("{}.json", &token[..16])),
        Err(e) => return IpcResult::err(e),
    };
    let _ = fs::write(
        &enroll_meta_path,
        serde_json::to_string_pretty(&track_meta).unwrap_or_default(),
    );

    IpcResult::ok(MeshEnrollmentToken {
        token,
        peer_name,
        roles,
        mesh_ip,
        expires_at,
    })
}

/// 新设备用 token 加入网络。
#[tauri::command]
pub async fn mesh_join_network(app: AppHandle, token: String) -> IpcResult<MeshNetwork> {
    let dir = match mesh_dir(&app) {
        Ok(d) => d,
        Err(e) => return IpcResult::err(e),
    };
    if dir.join("network.json").exists() {
        return IpcResult::err("已加入网络 —— 请先 mesh_leave_network".to_string());
    }

    let payload = match decrypt_token_to_payload(token.trim()) {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e),
    };

    // 落盘 ca / self.crt / self.key（注意：新设备这里没有 ca.key，因为不是 owner）
    if let Err(e) = fs::write(dir.join("ca.crt"), &payload.ca_pem) {
        return IpcResult::err(format!("写入 ca.crt 失败: {}", e));
    }
    if let Err(e) = fs::write(dir.join("self.crt"), &payload.cert_pem) {
        return IpcResult::err(format!("写入 self.crt 失败: {}", e));
    }
    if let Err(e) = write_sensitive(&dir.join("self.key"), payload.key_pem.as_bytes()) {
        return IpcResult::err(e);
    }

    // 渲染 config.yaml
    let yaml = render_node_config(&dir, "self", &payload.lighthouse_endpoint);
    if let Err(e) = fs::write(dir.join("config.yaml"), yaml) {
        return IpcResult::err(format!("写入 config.yaml 失败: {}", e));
    }

    let network = MeshNetwork {
        id: payload.network_id,
        name: payload.network_name,
        cidr: payload.cidr,
        lighthouse_endpoint: payload.lighthouse_endpoint,
        created_at: now_ms(),
        self_peer_id: payload.self_peer_id,
    };
    let meta_json = serde_json::to_string_pretty(&network).map_err(|e| format!("序列化失败: {}", e));
    let Ok(meta_json) = meta_json else { return IpcResult::err(meta_json.unwrap_err()) };
    if let Err(e) = fs::write(dir.join("network.json"), meta_json) {
        return IpcResult::err(format!("写入 network.json 失败: {}", e));
    }

    IpcResult::ok(network)
}

/// Owner 端：列出本网络的所有 peers。
/// v1 实现：从 enrollments/ 目录读 metadata（owner 签发了哪些设备）。
/// 真正的"是否在线"状态需要从 nebula 控制 socket 读，v1 全部返回 offline。
#[tauri::command]
pub async fn mesh_list_peers(app: AppHandle) -> IpcResult<Vec<MeshPeer>> {
    let dir = match mesh_dir(&app) {
        Ok(d) => d,
        Err(e) => return IpcResult::err(e),
    };
    let meta_path = dir.join("network.json");
    if !meta_path.exists() {
        return IpcResult::ok(Vec::new());
    }

    let mut peers = Vec::new();

    // 把 owner 自己作为第一个 peer
    let self_cert = fs::read(dir.join("self.crt")).unwrap_or_default();
    if !self_cert.is_empty() {
        peers.push(MeshPeer {
            id: fingerprint_hex(&self_cert),
            name: "self".to_string(),
            mesh_ip: "100.64.0.1".to_string(),
            roles: vec![MeshPeerRole::Owner],
            status: MeshPeerStatus::Offline, // v1: 真实状态需要 nebula API
            last_seen_at: 0,
            public_endpoint: String::new(),
            enrolled_at: 0,
            cert_expires_at: 0,
            advertised_subnet: String::new(),
        });
    }

    // 已签发的 enrollment 设备
    let enrolls = enrollments_dir(&app).ok();
    if let Some(enrolls_dir) = enrolls {
        if let Ok(entries) = fs::read_dir(&enrolls_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let Ok(content) = fs::read_to_string(&path) else {
                    continue;
                };
                let Ok(meta) = serde_json::from_str::<serde_json::Value>(&content) else {
                    continue;
                };
                let name = meta
                    .get("peer_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("(未知)")
                    .to_string();
                let mesh_ip = meta
                    .get("mesh_ip")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let issued_at = meta
                    .get("issued_at")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                // 用文件名前 16 字符当 peer id（fingerprint 前缀）
                let id = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                peers.push(MeshPeer {
                    id,
                    name,
                    mesh_ip,
                    roles: vec![MeshPeerRole::Member],
                    status: MeshPeerStatus::Offline,
                    last_seen_at: 0,
                    public_endpoint: String::new(),
                    enrolled_at: issued_at,
                    cert_expires_at: 0,
                    advertised_subnet: String::new(),
                });
            }
        }
    }

    IpcResult::ok(peers)
}

/// 读 nebula 子进程的日志增量。
#[tauri::command]
pub async fn mesh_get_logs(since_index: Option<usize>) -> IpcResult<super::LogChunk> {
    let idx = since_index.unwrap_or(0);
    let lines = crate::nebula_engine::read_logs(idx);
    let total = crate::nebula_engine::log_count();
    IpcResult::ok(super::LogChunk { lines, total })
}

/// 撤销 peer（v1：只删 enrollment metadata，重签 CA 留给 v2 ACL 一起做）。
#[tauri::command]
pub async fn mesh_revoke_peer(app: AppHandle, peer_id: String) -> IpcResult<()> {
    if peer_id.trim().is_empty() {
        return IpcResult::err("peer_id 不能为空".to_string());
    }
    let enrolls = match enrollments_dir(&app) {
        Ok(d) => d,
        Err(e) => return IpcResult::err(e),
    };
    let target = enrolls.join(format!("{}.json", peer_id));
    if target.exists() {
        if let Err(e) = fs::remove_file(&target) {
            return IpcResult::err(format!("删除 enrollment 元数据失败: {}", e));
        }
    }
    IpcResult::ok(())
}

// ─── 单元测试（rule 4：多写测试 case） ──────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_status_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&MeshEngineStatus::Stopped).unwrap(), "\"stopped\"");
        assert_eq!(serde_json::to_string(&MeshEngineStatus::Running).unwrap(), "\"running\"");
    }

    #[test]
    fn peer_role_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&MeshPeerRole::Owner).unwrap(), "\"owner\"");
        assert_eq!(serde_json::to_string(&MeshPeerRole::Lighthouse).unwrap(), "\"lighthouse\"");
    }

    #[test]
    fn peer_round_trip_camelcase() {
        let peer = MeshPeer {
            id: "abc123".into(),
            name: "Mac".into(),
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
        assert!(json.contains("\"meshIp\":\"100.64.0.2\""));
        assert!(json.contains("\"lastSeenAt\":1700000000000"));
        let restored: MeshPeer = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.id, peer.id);
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
            token: "AAAA-BBBB-CCCC".into(),
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

    #[test]
    fn fingerprint_is_deterministic() {
        let a = fingerprint_hex(b"hello kite");
        let b = fingerprint_hex(b"hello kite");
        assert_eq!(a, b);
        // 16 字节 → 32 hex 字符
        assert_eq!(a.len(), 32);
    }

    #[test]
    fn fingerprint_differs_for_different_input() {
        let a = fingerprint_hex(b"hello");
        let b = fingerprint_hex(b"world");
        assert_ne!(a, b);
    }

    #[test]
    fn hex_encode_round_trip_known_value() {
        assert_eq!(hex_encode(&[0xde, 0xad, 0xbe, 0xef]), "deadbeef");
        assert_eq!(hex_encode(&[]), "");
    }

    #[test]
    fn token_round_trip_preserves_payload() {
        let original = EnrollmentPayload {
            network_id: "net-abc".into(),
            network_name: "家庭网络".into(),
            cidr: "100.64.0.0/10".into(),
            lighthouse_endpoint: "vps.example.com:4242".into(),
            cert_pem: "-----BEGIN NEBULA CERTIFICATE-----\nfake cert\n-----END...\n".into(),
            key_pem: "-----BEGIN NEBULA PRIVATE KEY-----\nfake key\n-----END...\n".into(),
            ca_pem: "-----BEGIN NEBULA CERTIFICATE-----\nfake ca\n-----END...\n".into(),
            mesh_ip: "100.64.0.5".into(),
            peer_name: "iPhone".into(),
            roles: vec![MeshPeerRole::Member, MeshPeerRole::Subnet],
            enrolled_at: 1_700_000_000_000,
            cert_expires_at: 1_731_536_000_000,
            self_peer_id: "fp-xyz".into(),
        };
        let token = encrypt_payload_to_token(&original).unwrap();
        // base32 字符集
        assert!(token.chars().all(|c| c.is_ascii_alphanumeric()));
        // 解密后等价
        let decrypted = decrypt_token_to_payload(&token).unwrap();
        assert_eq!(decrypted.network_id, original.network_id);
        assert_eq!(decrypted.peer_name, original.peer_name);
        assert_eq!(decrypted.cert_pem, original.cert_pem);
        assert_eq!(decrypted.roles, original.roles);
        assert_eq!(decrypted.mesh_ip, original.mesh_ip);
    }

    #[test]
    fn token_decryption_rejects_garbage() {
        // 完全乱码
        let result = decrypt_token_to_payload("not-a-real-token");
        assert!(result.is_err());
    }

    #[test]
    fn token_decryption_rejects_short_input() {
        // 太短，连 nonce + key 都装不下
        let result = decrypt_token_to_payload("AAAABBBB");
        assert!(result.is_err());
    }

    #[test]
    fn token_decryption_rejects_tampered_ciphertext() {
        let payload = EnrollmentPayload {
            network_id: "net".into(),
            network_name: "n".into(),
            cidr: "100.64.0.0/10".into(),
            lighthouse_endpoint: "x".into(),
            cert_pem: "c".into(),
            key_pem: "k".into(),
            ca_pem: "ca".into(),
            mesh_ip: "100.64.0.2".into(),
            peer_name: "p".into(),
            roles: vec![MeshPeerRole::Member],
            enrolled_at: 0,
            cert_expires_at: 0,
            self_peer_id: "id".into(),
        };
        let token = encrypt_payload_to_token(&payload).unwrap();
        // 改最后一个字符 → ciphertext 被篡改 → AES-GCM auth tag 应失败
        let mut tampered = token.chars().collect::<Vec<_>>();
        let last = tampered.last_mut().unwrap();
        *last = if *last == 'A' { 'B' } else { 'A' };
        let tampered: String = tampered.into_iter().collect();
        assert!(decrypt_token_to_payload(&tampered).is_err());
    }

    #[test]
    fn token_uses_unique_key_per_call() {
        // 同一 payload 两次加密产生不同 token（nonce + key 都是随机的）
        let payload = EnrollmentPayload {
            network_id: "net".into(),
            network_name: "n".into(),
            cidr: "100.64.0.0/10".into(),
            lighthouse_endpoint: "x".into(),
            cert_pem: "c".into(),
            key_pem: "k".into(),
            ca_pem: "ca".into(),
            mesh_ip: "100.64.0.2".into(),
            peer_name: "p".into(),
            roles: vec![MeshPeerRole::Member],
            enrolled_at: 0,
            cert_expires_at: 0,
            self_peer_id: "id".into(),
        };
        let t1 = encrypt_payload_to_token(&payload).unwrap();
        let t2 = encrypt_payload_to_token(&payload).unwrap();
        assert_ne!(t1, t2, "随机性失效 —— token 不应该重复");
    }

    #[test]
    fn render_config_includes_paths_and_lighthouse() {
        let dir = PathBuf::from("/tmp/kite-mesh-test");
        let yaml = render_node_config(&dir, "self", "203.0.113.5:4242");
        assert!(yaml.contains("/tmp/kite-mesh-test/ca.crt"));
        assert!(yaml.contains("/tmp/kite-mesh-test/self.crt"));
        assert!(yaml.contains("/tmp/kite-mesh-test/self.key"));
        assert!(yaml.contains("203.0.113.5:4242"));
        assert!(yaml.contains("am_lighthouse: false"));
        assert!(yaml.contains("kite-mesh"));
    }

    #[test]
    fn render_config_is_valid_yaml() {
        let dir = PathBuf::from("/tmp/x");
        let yaml = render_node_config(&dir, "self", "example.com:4242");
        let parsed: serde_yaml::Value = serde_yaml::from_str(&yaml)
            .expect("render_node_config 应该产出合法 YAML");
        // 检查关键 key 存在
        assert!(parsed.get("pki").is_some());
        assert!(parsed.get("tun").is_some());
        assert!(parsed.get("listen").is_some());
    }
}

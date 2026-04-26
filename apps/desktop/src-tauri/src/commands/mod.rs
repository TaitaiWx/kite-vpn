//! Tauri IPC commands, split into domain modules.
//!
//! Each submodule owns a coherent slice of the surface area:
//! - `engine`        — mihomo lifecycle (start / stop / state) + tray sync
//! - `subscription`  — remote订阅 fetch + local persistence
//! - `config`        — config.yaml read / write / mixin / Clash 导入
//! - `system`        — system proxy + autostart
//! - `mihomo`        — mihomo HTTP API proxies (avoid CORS) + tray rebuild + mode
//! - `speed_test`    — 节点延迟和真实带宽测试
//!
//! Shared types (`IpcResult`, `EngineInfo`, …) and shared helpers
//! (`get_config_dir`, `get_mihomo_path`, …) live here in `mod.rs`.

pub mod engine;
pub mod subscription;
pub mod config;
pub mod system;
pub mod mihomo;
pub mod speed_test;

// 顶层 wildcard re-export：保持 `commands::xxx` 路径不变，lib.rs 的 generate_handler!
// 不用改。必须用 `*` 而不是命名导入，因为 #[tauri::command] 宏会生成
// `__cmd__xxx` wrapper item，命名 `pub use` 不会带这些自动生成的 item。
pub use engine::*;
pub use subscription::*;
pub use config::*;
pub use system::*;
pub use mihomo::*;
pub use speed_test::*;

// ─── 共享类型 ───────────────────────────────────────────────────────────────

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Debug, Serialize, Deserialize)]
pub struct IpcResult<T: Serialize> {
    pub success: bool,
    pub data: Option<T>,
    pub error: Option<String>,
}

impl<T: Serialize> IpcResult<T> {
    pub fn ok(data: T) -> Self {
        Self { success: true, data: Some(data), error: None }
    }
    pub fn err(msg: impl Into<String>) -> Self {
        Self { success: false, data: None, error: Some(msg.into()) }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EngineInfo {
    pub status: String,
    pub version: Option<String>,
    pub pid: Option<u32>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FetchedSubscription {
    pub content: String,
    pub user_info: Option<String>,
    pub content_type: Option<String>,
    pub update_interval: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProxyDelay {
    pub name: String,
    pub delay: u32,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LogChunk {
    pub lines: Vec<String>,
    pub total: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LocalClashConfig {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mtime_secs: u64,
}

// ─── 跨平台 Command 工厂 ──────────────────────────────────────────────────
//
// Windows 自动加 CREATE_NO_WINDOW，避免子进程弹控制台黑窗。
// `mut` 在 Windows 上确实需要（creation_flags 是 &mut self），其他平台
// 不需要，#[allow(unused_mut)] 抑制非 Windows 的警告。
#[allow(dead_code, unused_mut)]
pub(crate) fn cmd(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(target_os = "windows")]
    c.creation_flags(0x08000000);
    c
}

// ─── 路径帮助 ────────────────────────────────────────────────────────────────

pub(crate) fn get_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?;
    let dir = base.join("mihomo");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("无法创建配置目录 {}: {}", dir.display(), e))?;
    Ok(dir)
}

pub(crate) fn get_data_path(app: &AppHandle, filename: &str) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?;
    fs::create_dir_all(&base)
        .map_err(|e| format!("无法创建数据目录: {}", e))?;
    Ok(base.join(filename))
}

pub(crate) fn get_mihomo_path(app: &AppHandle) -> Result<String, String> {
    let target_triple = env!("TAURI_ENV_TARGET_TRIPLE");

    #[cfg(target_os = "windows")]
    let sidecar_name = format!("mihomo-{}.exe", target_triple);
    #[cfg(not(target_os = "windows"))]
    let sidecar_name = format!("mihomo-{}", target_triple);

    // 1. Tauri sidecar（externalBin 打包的路径）
    if let Ok(resource_dir) = app.path().resource_dir() {
        let sidecar = resource_dir.join("binaries").join(&sidecar_name);
        if sidecar.exists() {
            return Ok(sidecar.to_string_lossy().to_string());
        }
    }

    // 2. 开发模式下直接在 src-tauri/binaries/
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(&sidecar_name);
    if dev_path.exists() {
        return Ok(dev_path.to_string_lossy().to_string());
    }

    // 3. 回退到 PATH
    let which_cmd = if cfg!(target_os = "windows") { "where" } else { "which" };
    if let Ok(o) = std::process::Command::new(which_cmd).arg("mihomo").output() {
        if o.status.success() {
            let path = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !path.is_empty() {
                return Ok(path);
            }
        }
    }

    Err(format!("未找到 mihomo 引擎 ({})。请先运行 pnpm run build:engine 编译引擎。", sidecar_name))
}

pub(crate) fn setup_geo_databases(app: &AppHandle, config_dir: &std::path::Path) {
    if let Ok(resource_dir) = app.path().resource_dir() {
        for file in &["geoip.dat", "geosite.dat", "country.mmdb"] {
            let src = resource_dir.join("resources").join(file);
            let dst = config_dir.join(file);
            if src.exists() && !dst.exists() {
                let _ = fs::copy(&src, &dst);
            }
        }
    }
}

/// 优先从 bundled resources 里找一份完整的默认配置；否则 fallback 到最小可跑配置。
/// 顺序：
/// 1. bundled resources/default_config.yaml（派生自典型 Clash 机场订阅，7000+ 条规则）
/// 2. 开发模式下 src-tauri/resources/default_config.yaml
/// 3. 兜底：硬编码的极简 config（只保证引擎能启动）
pub(crate) fn load_default_config_template(app: &AppHandle) -> String {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("resources").join("default_config.yaml");
        if let Ok(content) = fs::read_to_string(&bundled) {
            return content;
        }
    }
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("default_config.yaml");
    if let Ok(content) = fs::read_to_string(&dev_path) {
        return content;
    }
    // 最后兜底 —— 只保证引擎能启动
    r#"mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
external-controller: 127.0.0.1:9090
dns:
  enable: true
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  default-nameserver:
    - 223.5.5.5
    - 119.29.29.29
    - 1.0.0.1
  nameserver:
    - https://dns.google/dns-query
    - tls://8.8.8.8:853
    - 8.8.8.8
  fallback:
    - https://1.1.1.1/dns-query
    - tls://1.1.1.1:853
    - 1.1.1.1
proxies: []
proxy-groups:
  - name: Proxy
    type: select
    proxies: [DIRECT]
rules:
  - GEOSITE,cn,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,DIRECT
"#.to_string()
}

// ─── 托盘同步 helpers（被多个 commands 调用）──────────────────────────────

pub(crate) fn update_tray_tooltip(app: &AppHandle, status: &str) {
    if let Some(tray) = app.tray_by_id("kite-tray") {
        let _ = tray.set_tooltip(Some(&format!("Kite — {}", status)));
    }
}

pub(crate) fn sync_tray_engine(app: &AppHandle, running: bool) {
    crate::tray::update_engine_status(app, running);
}

pub(crate) fn sync_tray_system_proxy(app: &AppHandle, enabled: bool) {
    crate::tray::update_system_proxy_check(app, enabled);
}

pub(crate) fn sync_tray_mode(app: &AppHandle, mode: &str) {
    crate::tray::update_mode_check(app, mode);
}

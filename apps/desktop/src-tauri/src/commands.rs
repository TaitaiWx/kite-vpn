use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use crate::engine::EngineState as EngineAppState;
use crate::system_proxy;

fn update_tray_tooltip(app: &AppHandle, status: &str) {
    if let Some(tray) = app.tray_by_id("kite-tray") {
        let _ = tray.set_tooltip(Some(&format!("Kite — {}", status)));
    }
}

// ─── 通用响应 ───────────────────────────────────────────────────────────────

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

// ─── 引擎状态 ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EngineInfo {
    pub status: String,
    pub version: Option<String>,
    pub pid: Option<u32>,
    pub error: Option<String>,
}

fn get_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?;
    let dir = base.join("mihomo");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("无法创建配置目录 {}: {}", dir.display(), e))?;
    Ok(dir)
}

fn get_mihomo_path(app: &AppHandle) -> Result<String, String> {
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

fn setup_geo_databases(app: &AppHandle, config_dir: &std::path::Path) {
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

// ─── 检测 mihomo 是否可用 ───────────────────────────────────────────────────

#[tauri::command]
pub async fn check_mihomo(app: AppHandle) -> IpcResult<String> {
    match get_mihomo_path(&app) {
        Ok(path) => IpcResult::ok(path),
        Err(e) => IpcResult::err(e),
    }
}

// ─── 引擎命令 ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn engine_start(app: AppHandle) -> IpcResult<EngineInfo> {
    let config_dir = match get_config_dir(&app) {
        Ok(d) => d,
        Err(e) => return IpcResult::err(e),
    };
    let mihomo_path = match get_mihomo_path(&app) {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e),
    };

    // 复制 GeoIP/GeoSite 规则库到配置目录
    setup_geo_databases(&app, &config_dir);

    // 确保有默认配置文件
    let config_file = config_dir.join("config.yaml");
    if !config_file.exists() {
        let default_config = r#"mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
external-controller: 127.0.0.1:9090
dns:
  enable: true
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver:
    - https://doh.pub/dns-query
    - https://dns.alidns.com/dns-query
  fallback:
    - https://1.1.1.1/dns-query
    - https://dns.google/dns-query
  fallback-filter:
    geoip: true
    geoip-code: CN
proxies: []
proxy-groups: []
rules:
  - GEOSITE,cn,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,DIRECT
"#;
        let _ = fs::write(&config_file, default_config);
    }

    let config_dir_str = config_dir.to_string_lossy().to_string();
    let state = app.state::<EngineAppState>();
    let mut engine = state.engine.lock().unwrap();

    match engine.start(&mihomo_path, &config_dir_str) {
        Ok(pid) => {
            update_tray_tooltip(&app, "运行中");
            IpcResult::ok(EngineInfo {
                status: "running".to_string(),
                version: None,
                pid: Some(pid),
                error: None,
            })
        },
        Err(e) => IpcResult::err(format!("启动引擎失败: {}", e)),
    }
}

#[tauri::command]
pub async fn engine_stop(app: AppHandle) -> IpcResult<EngineInfo> {
    let state = app.state::<EngineAppState>();
    let mut engine = state.engine.lock().unwrap();

    // 先停引擎
    if let Err(e) = engine.stop() {
        return IpcResult::err(format!("停止引擎失败: {}", e));
    }

    // 尝试关闭系统代理，失败不阻断
    if let Err(e) = system_proxy::disable() {
        eprintln!("关闭系统代理失败（非致命）: {}", e);
    }

    update_tray_tooltip(&app, "已停止");
    IpcResult::ok(EngineInfo {
        status: "stopped".to_string(), version: None, pid: None, error: None,
    })
}

#[tauri::command]
pub async fn engine_restart(app: AppHandle) -> IpcResult<EngineInfo> {
    let mihomo_path = match get_mihomo_path(&app) {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e),
    };

    let state = app.state::<EngineAppState>();
    let mut engine = state.engine.lock().unwrap();

    match engine.restart(&mihomo_path) {
        Ok(pid) => IpcResult::ok(EngineInfo {
            status: "running".to_string(), version: None, pid: Some(pid), error: None,
        }),
        Err(e) => IpcResult::err(format!("重启引擎失败: {}", e)),
    }
}

#[tauri::command]
pub async fn engine_get_state(app: AppHandle) -> IpcResult<EngineInfo> {
    let state = app.state::<EngineAppState>();
    let mut engine = state.engine.lock().unwrap();

    let running = engine.is_running();
    let pid = engine.pid();

    IpcResult::ok(EngineInfo {
        status: if running { "running" } else { "stopped" }.to_string(),
        version: None, pid, error: None,
    })
}

// ─── 远程订阅拉取（Rust 侧，无 CORS 问题）─────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct FetchedSubscription {
    pub content: String,
    pub user_info: Option<String>,
    pub content_type: Option<String>,
    pub update_interval: Option<f64>,
}

#[tauri::command]
pub async fn fetch_remote_subscription(url: String, timeout_ms: Option<u64>) -> IpcResult<FetchedSubscription> {
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(15000));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .user_agent("UniProxy/0.1.0 (Clash-compatible)")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e));

    let client = match client {
        Ok(c) => c,
        Err(e) => return IpcResult::err(e),
    };

    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => return IpcResult::err(format!("请求订阅失败: {}", e)),
    };

    if !resp.status().is_success() {
        return IpcResult::err(format!("HTTP {}: {}", resp.status().as_u16(), resp.status().canonical_reason().unwrap_or("未知错误")));
    }

    let user_info = resp.headers().get("subscription-userinfo")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let content_type = resp.headers().get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let update_interval = resp.headers().get("profile-update-interval")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<f64>().ok());

    let content = match resp.text().await {
        Ok(t) => t,
        Err(e) => return IpcResult::err(format!("读取响应体失败: {}", e)),
    };

    IpcResult::ok(FetchedSubscription {
        content, user_info, content_type, update_interval,
    })
}

// ─── 配置文件 ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn write_config(app: AppHandle, yaml_content: String) -> IpcResult<String> {
    let config_dir = match get_config_dir(&app) {
        Ok(d) => d,
        Err(e) => return IpcResult::err(e),
    };
    let config_path = config_dir.join("config.yaml");
    match fs::write(&config_path, &yaml_content) {
        Ok(()) => IpcResult::ok(config_path.to_string_lossy().to_string()),
        Err(e) => IpcResult::err(format!("写入配置失败: {}", e)),
    }
}

#[tauri::command]
pub async fn read_config(app: AppHandle) -> IpcResult<String> {
    let config_dir = match get_config_dir(&app) {
        Ok(d) => d,
        Err(e) => return IpcResult::err(e),
    };
    match fs::read_to_string(config_dir.join("config.yaml")) {
        Ok(content) => IpcResult::ok(content),
        Err(e) => IpcResult::err(format!("读取配置失败: {}", e)),
    }
}

// ─── 订阅持久化 ─────────────────────────────────────────────────────────────

fn get_data_path(app: &AppHandle, filename: &str) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?;
    fs::create_dir_all(&base)
        .map_err(|e| format!("无法创建数据目录: {}", e))?;
    Ok(base.join(filename))
}

#[tauri::command]
pub async fn save_subscriptions(app: AppHandle, json_data: String) -> IpcResult<()> {
    let path = match get_data_path(&app, "subscriptions.json") {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e),
    };
    match fs::write(&path, &json_data) {
        Ok(()) => IpcResult::ok(()),
        Err(e) => IpcResult::err(format!("保存订阅失败: {}", e)),
    }
}

#[tauri::command]
pub async fn load_subscriptions(app: AppHandle) -> IpcResult<String> {
    let path = match get_data_path(&app, "subscriptions.json") {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e),
    };
    match fs::read_to_string(&path) {
        Ok(content) => IpcResult::ok(content),
        Err(_) => IpcResult::ok("[]".to_string()),
    }
}

// ─── 应用配置持久化 ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn save_app_config(app: AppHandle, json_data: String) -> IpcResult<()> {
    let path = match get_data_path(&app, "app_config.json") {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e),
    };
    match fs::write(&path, &json_data) {
        Ok(()) => IpcResult::ok(()),
        Err(e) => IpcResult::err(format!("保存配置失败: {}", e)),
    }
}

#[tauri::command]
pub async fn load_app_config(app: AppHandle) -> IpcResult<String> {
    let path = match get_data_path(&app, "app_config.json") {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e),
    };
    match fs::read_to_string(&path) {
        Ok(content) => IpcResult::ok(content),
        Err(_) => IpcResult::ok("null".to_string()),
    }
}

// ─── 系统代理 ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn enable_system_proxy(host: Option<String>, port: Option<u16>) -> IpcResult<bool> {
    let config = system_proxy::ProxyConfig {
        host: host.unwrap_or_else(|| "127.0.0.1".to_string()),
        port: port.unwrap_or(7890),
    };
    match system_proxy::enable(&config) {
        Ok(()) => IpcResult::ok(true),
        Err(e) => IpcResult::err(e),
    }
}

#[tauri::command]
pub async fn disable_system_proxy() -> IpcResult<bool> {
    match system_proxy::disable() {
        Ok(()) => IpcResult::ok(false),
        Err(e) => IpcResult::err(e),
    }
}

#[tauri::command]
pub async fn get_system_proxy_status() -> IpcResult<bool> {
    match system_proxy::is_enabled() {
        Ok(enabled) => IpcResult::ok(enabled),
        Err(e) => IpcResult::err(e),
    }
}

// ─── 代理模式 ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn set_mode(mode: String, controller_url: Option<String>) -> IpcResult<()> {
    let url = controller_url.unwrap_or_else(|| "http://127.0.0.1:9090".to_string());
    let client = reqwest::Client::new();
    match client.patch(format!("{}/configs", url))
        .header("Content-Type", "application/json")
        .body(format!(r#"{{"mode":"{}"}}"#, mode))
        .send().await
    {
        Ok(_) => IpcResult::ok(()),
        Err(e) => IpcResult::err(format!("设置模式失败: {}", e)),
    }
}

// ─── mihomo API 代理（前端通过 IPC 调用，避免 CORS）───────────────────────

#[tauri::command]
pub async fn mihomo_get_connections(controller_url: Option<String>) -> IpcResult<String> {
    let url = controller_url.unwrap_or_else(|| "http://127.0.0.1:9090".to_string());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build().unwrap();

    match client.get(format!("{}/connections", url)).send().await {
        Ok(resp) => match resp.text().await {
            Ok(text) => IpcResult::ok(text),
            Err(e) => IpcResult::err(format!("读取连接数据失败: {}", e)),
        },
        Err(e) => IpcResult::err(format!("获取连接失败: {}", e)),
    }
}

#[tauri::command]
pub async fn mihomo_get_proxies(controller_url: Option<String>) -> IpcResult<String> {
    let url = controller_url.unwrap_or_else(|| "http://127.0.0.1:9090".to_string());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build().unwrap();

    match client.get(format!("{}/proxies", url)).send().await {
        Ok(resp) => match resp.text().await {
            Ok(text) => IpcResult::ok(text),
            Err(e) => IpcResult::err(format!("读取代理数据失败: {}", e)),
        },
        Err(e) => IpcResult::err(format!("获取代理列表失败: {}", e)),
    }
}

// ─── 延迟测试 ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct ProxyDelay {
    pub name: String,
    pub delay: u32,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn test_proxy_delay(
    name: String, test_url: Option<String>, timeout: Option<u32>,
    controller_url: Option<String>,
) -> IpcResult<ProxyDelay> {
    let base = controller_url.unwrap_or_else(|| "http://127.0.0.1:9090".to_string());
    let url = test_url.unwrap_or_else(|| "http://www.gstatic.com/generate_204".to_string());
    let timeout_ms = timeout.unwrap_or(5000);

    let encoded_name = urlencoding::encode(&name);
    let encoded_url = urlencoding::encode(&url);
    let api_url = format!("{}/proxies/{}/delay?url={}&timeout={}", base, encoded_name, encoded_url, timeout_ms);

    let client = reqwest::Client::new();
    match client.get(&api_url).send().await {
        Ok(resp) => {
            if let Ok(text) = resp.text().await {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                    let delay = val["delay"].as_u64().unwrap_or(0) as u32;
                    return IpcResult::ok(ProxyDelay { name, delay, error: None });
                }
            }
            IpcResult::ok(ProxyDelay { name, delay: 0, error: Some("解析响应失败".to_string()) })
        }
        Err(e) => IpcResult::ok(ProxyDelay { name, delay: 0, error: Some(format!("请求失败: {}", e)) }),
    }
}

// ─── 引擎日志（从 stderr 缓冲读取）────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct LogChunk {
    pub lines: Vec<String>,
    pub total: usize,
}

#[tauri::command]
pub async fn mihomo_get_logs(since_index: Option<usize>) -> IpcResult<LogChunk> {
    let idx = since_index.unwrap_or(0);
    let lines = crate::engine::read_logs(idx);
    let total = crate::engine::log_count();
    IpcResult::ok(LogChunk { lines, total })
}

// ─── mihomo 版本检测 ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn mihomo_get_version(controller_url: Option<String>) -> IpcResult<String> {
    let base = controller_url.unwrap_or_else(|| "http://127.0.0.1:9090".to_string());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build().unwrap();

    match client.get(format!("{}/version", base)).send().await {
        Ok(resp) => match resp.text().await {
            Ok(text) => {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(version) = val["version"].as_str() {
                        return IpcResult::ok(version.to_string());
                    }
                }
                IpcResult::ok("unknown".to_string())
            },
            Err(e) => IpcResult::err(format!("读取版本失败: {}", e)),
        },
        Err(e) => IpcResult::err(format!("获取版本失败: {}", e)),
    }
}

// ─── mihomo 选择代理节点 ────────────────────────────────────────────────────

#[tauri::command]
pub async fn mihomo_select_proxy(group: String, proxy: String, controller_url: Option<String>) -> IpcResult<()> {
    let base = controller_url.unwrap_or_else(|| "http://127.0.0.1:9090".to_string());
    let encoded_group = urlencoding::encode(&group);
    let client = reqwest::Client::new();

    match client.put(format!("{}/proxies/{}", base, encoded_group))
        .header("Content-Type", "application/json")
        .body(format!(r#"{{"name":"{}"}}"#, proxy.replace('"', "\\\"")))
        .send().await
    {
        Ok(resp) if resp.status().is_success() => IpcResult::ok(()),
        Ok(resp) => {
            let text = resp.text().await.unwrap_or_default();
            IpcResult::err(format!("切换节点失败: {}", text))
        }
        Err(e) => IpcResult::err(format!("切换节点失败: {}", e)),
    }
}

// ─── mihomo 关闭所有连接 ────────────────────────────────────────────────────

#[tauri::command]
pub async fn mihomo_close_connections(controller_url: Option<String>) -> IpcResult<()> {
    let base = controller_url.unwrap_or_else(|| "http://127.0.0.1:9090".to_string());
    let client = reqwest::Client::new();

    match client.delete(format!("{}/connections", base)).send().await {
        Ok(resp) if resp.status().is_success() => IpcResult::ok(()),
        Ok(resp) => {
            let text = resp.text().await.unwrap_or_default();
            IpcResult::err(format!("关闭连接失败: {}", text))
        }
        Err(e) => IpcResult::err(format!("关闭连接失败: {}", e)),
    }
}

// ─── mihomo 配置重载 ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn mihomo_reload_config(controller_url: Option<String>, config_path: Option<String>) -> IpcResult<()> {
    let base = controller_url.unwrap_or_else(|| "http://127.0.0.1:9090".to_string());
    let client = reqwest::Client::new();

    let body = if let Some(path) = config_path {
        format!(r#"{{"path":"{}"}}"#, path.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        "{}".to_string()
    };

    match client.put(format!("{}/configs?force=true", base))
        .header("Content-Type", "application/json")
        .body(body)
        .send().await
    {
        Ok(resp) => {
            if resp.status().is_success() {
                IpcResult::ok(())
            } else {
                let text = resp.text().await.unwrap_or_default();
                IpcResult::err(format!("重载配置失败: {}", text))
            }
        }
        Err(e) => IpcResult::err(format!("重载配置失败: {}", e)),
    }
}

// ─── 开机自启 ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn set_autostart(enabled: bool, _app: AppHandle) -> IpcResult<bool> {
    let exe_path = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(e) => return IpcResult::err(format!("获取路径失败: {}", e)),
    };

    #[cfg(target_os = "macos")]
    {
        let plist_dir = dirs::home_dir().unwrap().join("Library/LaunchAgents");
        let plist_path = plist_dir.join("com.kite-vpn.desktop.plist");
        if enabled {
            let plist = format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kite-vpn.desktop</string>
  <key>ProgramArguments</key><array><string>{}</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>"#, exe_path);
            fs::create_dir_all(&plist_dir).ok();
            if let Err(e) = fs::write(&plist_path, plist) {
                return IpcResult::err(format!("写入 plist 失败: {}", e));
            }
        } else {
            let _ = fs::remove_file(&plist_path);
        }
        return IpcResult::ok(enabled);
    }

    #[cfg(target_os = "windows")]
    {
        if enabled {
            let _ = std::process::Command::new("reg")
                .args(["add", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                       "/v", "Kite", "/t", "REG_SZ", "/d", &exe_path, "/f"])
                .output();
        } else {
            let _ = std::process::Command::new("reg")
                .args(["delete", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                       "/v", "Kite", "/f"])
                .output();
        }
        return IpcResult::ok(enabled);
    }

    #[cfg(target_os = "linux")]
    {
        let autostart_dir = dirs::config_dir().unwrap().join("autostart");
        let desktop_path = autostart_dir.join("kite.desktop");
        if enabled {
            let entry = format!(
                "[Desktop Entry]\nType=Application\nName=Kite\nExec={}\nX-GNOME-Autostart-enabled=true\n",
                exe_path);
            fs::create_dir_all(&autostart_dir).ok();
            if let Err(e) = fs::write(&desktop_path, entry) {
                return IpcResult::err(format!("写入 desktop 失败: {}", e));
            }
        } else {
            let _ = fs::remove_file(&desktop_path);
        }
        return IpcResult::ok(enabled);
    }

    #[allow(unreachable_code)]
    IpcResult::err("不支持的操作系统")
}

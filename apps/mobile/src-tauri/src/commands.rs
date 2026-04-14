use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

// ─── IPC Result ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct IpcResult<T: Serialize> {
    pub success: bool,
    pub data: Option<T>,
    pub error: Option<String>,
}

impl<T: Serialize> IpcResult<T> {
    pub fn ok(data: T) -> Self { Self { success: true, data: Some(data), error: None } }
    pub fn err(msg: impl Into<String>) -> Self { Self { success: false, data: None, error: Some(msg.into()) } }
}

// ─── 引擎管理（mihomo 进程）────────────────────────────────────────────────

pub struct EngineState {
    pub child: Mutex<Option<Child>>,
    pub config_dir: Mutex<Option<PathBuf>>,
}

impl EngineState {
    pub fn new() -> Self {
        Self { child: Mutex::new(None), config_dir: Mutex::new(None) }
    }
}

fn get_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir()
        .map_err(|e| format!("无法获取数据目录: {}", e))?;
    fs::create_dir_all(&base).map_err(|e| format!("无法创建目录: {}", e))?;
    Ok(base)
}

fn get_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = get_data_dir(app)?.join("mihomo");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建配置目录: {}", e))?;
    Ok(dir)
}

// ─── 引擎命令 ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EngineInfo {
    pub status: String,
    pub pid: Option<u32>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn engine_start(app: AppHandle) -> IpcResult<EngineInfo> {
    let config_dir = match get_config_dir(&app) {
        Ok(d) => d,
        Err(e) => return IpcResult::err(e),
    };

    // 确保有默认配置
    let config_file = config_dir.join("config.yaml");
    if !config_file.exists() {
        let default_config = "mixed-port: 7890\nallow-lan: false\nmode: rule\nlog-level: info\nexternalcontroller: 127.0.0.1:9090\ntun:\n  enable: true\n  stack: gvisor\n  auto-route: true\n  auto-detect-interface: true\nproxies: []\nproxy-groups: []\nrules:\n  - MATCH,DIRECT\n";
        let _ = fs::write(&config_file, default_config);
    }

    // 查找 mihomo 二进制（打包在 libs/ 目录中）
    let mihomo_path = {
        let data = get_data_dir(&app)?;
        let local_bin = data.join("mihomo");
        if local_bin.exists() {
            local_bin.to_string_lossy().to_string()
        } else {
            // 从 app 资源中复制
            if let Ok(res) = app.path().resource_dir() {
                for abi in &["arm64-v8a", "x86_64", "aarch64"] {
                    let src = res.join("libs").join(abi).join("libmihomo");
                    if src.exists() {
                        let _ = fs::copy(&src, &local_bin);
                        #[cfg(unix)]
                        { use std::os::unix::fs::PermissionsExt; let _ = fs::set_permissions(&local_bin, fs::Permissions::from_mode(0o755)); }
                        break;
                    }
                }
            }
            if local_bin.exists() {
                local_bin.to_string_lossy().to_string()
            } else {
                return IpcResult::err("未找到 mihomo 引擎二进制");
            }
        }
    };

    let state = app.state::<EngineState>();
    let mut child_guard = state.child.lock().unwrap();

    // 停掉旧进程
    if let Some(mut old) = child_guard.take() {
        let _ = old.kill();
        let _ = old.wait();
    }

    match Command::new(mihomo_path)
        .arg("-d").arg(config_dir.to_string_lossy().to_string())
        .stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => {
            let pid = child.id();
            *child_guard = Some(child);
            *state.config_dir.lock().unwrap() = Some(config_dir);
            IpcResult::ok(EngineInfo { status: "running".to_string(), pid: Some(pid), error: None })
        }
        Err(e) => IpcResult::err(format!("启动引擎失败: {}", e)),
    }
}

#[tauri::command]
pub async fn engine_stop(app: AppHandle) -> IpcResult<EngineInfo> {
    let state = app.state::<EngineState>();
    let mut child_guard = state.child.lock().unwrap();
    if let Some(mut child) = child_guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    IpcResult::ok(EngineInfo { status: "stopped".to_string(), pid: None, error: None })
}

#[tauri::command]
pub async fn engine_get_state(app: AppHandle) -> IpcResult<EngineInfo> {
    let state = app.state::<EngineState>();
    let mut child_guard = state.child.lock().unwrap();
    let running = child_guard.as_mut().map(|c| matches!(c.try_wait(), Ok(None))).unwrap_or(false);
    let pid = child_guard.as_ref().map(|c| c.id());
    IpcResult::ok(EngineInfo {
        status: if running { "running" } else { "stopped" }.to_string(),
        pid: if running { pid } else { None },
        error: None,
    })
}

// ─── 远程订阅拉取 ───────────────────────────────────────────────────────────

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
    let client = match reqwest::Client::builder().timeout(timeout).user_agent("Kite/0.1.0").build() {
        Ok(c) => c,
        Err(e) => return IpcResult::err(format!("HTTP 客户端失败: {}", e)),
    };

    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => return IpcResult::err(format!("请求失败: {}", e)),
    };

    if !resp.status().is_success() {
        return IpcResult::err(format!("HTTP {}", resp.status().as_u16()));
    }

    let user_info = resp.headers().get("subscription-userinfo").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let content_type = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let update_interval = resp.headers().get("profile-update-interval").and_then(|v| v.to_str().ok()).and_then(|s| s.parse::<f64>().ok());

    match resp.text().await {
        Ok(content) => IpcResult::ok(FetchedSubscription { content, user_info, content_type, update_interval }),
        Err(e) => IpcResult::err(format!("读取失败: {}", e)),
    }
}

// ─── 配置文件读写 ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn write_config(app: AppHandle, yaml_content: String) -> IpcResult<String> {
    let config_dir = match get_config_dir(&app) {
        Ok(d) => d,
        Err(e) => return IpcResult::err(e),
    };
    let path = config_dir.join("config.yaml");
    match fs::write(&path, &yaml_content) {
        Ok(()) => IpcResult::ok(path.to_string_lossy().to_string()),
        Err(e) => IpcResult::err(format!("写入失败: {}", e)),
    }
}

#[tauri::command]
pub async fn read_config(app: AppHandle) -> IpcResult<String> {
    let config_dir = match get_config_dir(&app) {
        Ok(d) => d,
        Err(e) => return IpcResult::err(e),
    };
    match fs::read_to_string(config_dir.join("config.yaml")) {
        Ok(s) => IpcResult::ok(s),
        Err(e) => IpcResult::err(format!("读取失败: {}", e)),
    }
}

// ─── 订阅持久化 ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn save_subscriptions(app: AppHandle, json_data: String) -> IpcResult<()> {
    let path = match get_data_dir(&app) {
        Ok(d) => d.join("subscriptions.json"),
        Err(e) => return IpcResult::err(e),
    };
    match fs::write(&path, &json_data) {
        Ok(()) => IpcResult::ok(()),
        Err(e) => IpcResult::err(format!("保存失败: {}", e)),
    }
}

#[tauri::command]
pub async fn load_subscriptions(app: AppHandle) -> IpcResult<String> {
    let path = match get_data_dir(&app) {
        Ok(d) => d.join("subscriptions.json"),
        Err(e) => return IpcResult::err(e),
    };
    match fs::read_to_string(&path) {
        Ok(s) => IpcResult::ok(s),
        Err(_) => IpcResult::ok("[]".to_string()),
    }
}

// ─── 应用配置 ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn save_app_config(app: AppHandle, json_data: String) -> IpcResult<()> {
    let path = match get_data_dir(&app) {
        Ok(d) => d.join("app_config.json"),
        Err(e) => return IpcResult::err(e),
    };
    match fs::write(&path, &json_data) {
        Ok(()) => IpcResult::ok(()),
        Err(e) => IpcResult::err(format!("保存失败: {}", e)),
    }
}

#[tauri::command]
pub async fn load_app_config(app: AppHandle) -> IpcResult<String> {
    let path = match get_data_dir(&app) {
        Ok(d) => d.join("app_config.json"),
        Err(e) => return IpcResult::err(e),
    };
    match fs::read_to_string(&path) {
        Ok(s) => IpcResult::ok(s),
        Err(_) => IpcResult::ok("null".to_string()),
    }
}

// ─── mihomo API 代理 ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn set_mode(mode: String) -> IpcResult<()> {
    let client = reqwest::Client::new();
    match client.patch("http://127.0.0.1:9090/configs")
        .header("Content-Type", "application/json")
        .body(format!(r#"{{"mode":"{}"}}"#, mode))
        .send().await
    {
        Ok(_) => IpcResult::ok(()),
        Err(e) => IpcResult::err(format!("设置失败: {}", e)),
    }
}

#[tauri::command]
pub async fn mihomo_get_connections() -> IpcResult<String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(2)).build().unwrap();
    match client.get("http://127.0.0.1:9090/connections").send().await {
        Ok(r) => match r.text().await {
            Ok(t) => IpcResult::ok(t),
            Err(e) => IpcResult::err(format!("{}", e)),
        },
        Err(e) => IpcResult::err(format!("{}", e)),
    }
}

#[tauri::command]
pub async fn mihomo_get_proxies() -> IpcResult<String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(2)).build().unwrap();
    match client.get("http://127.0.0.1:9090/proxies").send().await {
        Ok(r) => match r.text().await {
            Ok(t) => IpcResult::ok(t),
            Err(e) => IpcResult::err(format!("{}", e)),
        },
        Err(e) => IpcResult::err(format!("{}", e)),
    }
}

#[tauri::command]
pub async fn mihomo_reload_config(config_path: Option<String>) -> IpcResult<()> {
    let client = reqwest::Client::new();
    let body = if let Some(p) = config_path {
        format!(r#"{{"path":"{}"}}"#, p.replace('\\', "\\\\").replace('"', "\\\""))
    } else { "{}".to_string() };

    match client.put("http://127.0.0.1:9090/configs?force=true")
        .header("Content-Type", "application/json")
        .body(body).send().await
    {
        Ok(r) if r.status().is_success() => IpcResult::ok(()),
        Ok(r) => IpcResult::err(format!("重载失败: {}", r.text().await.unwrap_or_default())),
        Err(e) => IpcResult::err(format!("重载失败: {}", e)),
    }
}

#[tauri::command]
pub async fn mihomo_select_proxy(group: String, proxy: String) -> IpcResult<()> {
    let client = reqwest::Client::new();
    let encoded = urlencoding::encode(&group);
    match client.put(format!("http://127.0.0.1:9090/proxies/{}", encoded))
        .header("Content-Type", "application/json")
        .body(format!(r#"{{"name":"{}"}}"#, proxy.replace('"', "\\\"")))
        .send().await
    {
        Ok(r) if r.status().is_success() => IpcResult::ok(()),
        _ => IpcResult::err("切换失败"),
    }
}

#[tauri::command]
pub async fn test_proxy_delay(name: String) -> IpcResult<u32> {
    let encoded = urlencoding::encode(&name);
    let url = format!("http://127.0.0.1:9090/proxies/{}/delay?url=http://www.gstatic.com/generate_204&timeout=5000", encoded);
    let client = reqwest::Client::new();
    match client.get(&url).send().await {
        Ok(r) => {
            if let Ok(t) = r.text().await {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                    return IpcResult::ok(v["delay"].as_u64().unwrap_or(0) as u32);
                }
            }
            IpcResult::ok(0)
        }
        Err(_) => IpcResult::ok(0),
    }
}

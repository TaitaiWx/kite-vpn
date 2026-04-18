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

fn sync_tray_engine(app: &AppHandle, running: bool) {
    crate::tray::update_engine_status(app, running);
}

fn sync_tray_system_proxy(app: &AppHandle, enabled: bool) {
    crate::tray::update_system_proxy_check(app, enabled);
}

fn sync_tray_mode(app: &AppHandle, mode: &str) {
    crate::tray::update_mode_check(app, mode);
}

// ─── YAML 深度合并 ──────────────────────────────────────────────────────────

/// 把 `overlay` 深度合并到 `base` —— map 递归合并，数组直接替换，标量替换。
/// 这是 Clash Verge 等客户端 "Mixin" 的标准语义。
fn deep_merge_yaml(base: &mut serde_yaml::Value, overlay: serde_yaml::Value) {
    use serde_yaml::Value;
    match (base, overlay) {
        (Value::Mapping(b), Value::Mapping(o)) => {
            for (k, v) in o {
                match b.get_mut(&k) {
                    Some(existing) => deep_merge_yaml(existing, v),
                    None => { b.insert(k, v); }
                }
            }
        }
        (slot, overlay) => { *slot = overlay; }
    }
}

/// 从磁盘读当前 config.yaml，合并 AppConfig.mixin.content，写回。
/// 若 engine 正在运行，调用 mihomo /configs PUT 触发热重载。
#[tauri::command]
pub async fn apply_mixin_and_reload(app: AppHandle) -> IpcResult<String> {
    // 1. 读 AppConfig
    let app_cfg_path = match get_data_path(&app, "app_config.json") {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e),
    };
    let app_cfg_raw = match fs::read_to_string(&app_cfg_path) {
        Ok(s) => s,
        Err(_) => return IpcResult::err("尚未保存 AppConfig".to_string()),
    };
    let app_cfg: serde_json::Value = match serde_json::from_str(&app_cfg_raw) {
        Ok(v) => v,
        Err(e) => return IpcResult::err(format!("解析 AppConfig 失败: {}", e)),
    };

    let mixin_enabled = app_cfg.pointer("/mixin/enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    let mixin_content = app_cfg.pointer("/mixin/content").and_then(|v| v.as_str()).unwrap_or("").to_string();

    // 2. 读当前 config.yaml
    let cfg_dir = match get_config_dir(&app) {
        Ok(d) => d,
        Err(e) => return IpcResult::err(e),
    };
    let config_file = cfg_dir.join("config.yaml");
    if !config_file.exists() {
        return IpcResult::err("config.yaml 不存在，请先启动一次引擎".to_string());
    }
    let base_yaml_raw = match fs::read_to_string(&config_file) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(format!("读取 config.yaml 失败: {}", e)),
    };

    // 基础 YAML 可能已经是之前 apply mixin 后的产物；为了避免叠加，
    // 从备份重读：如果有 config.base.yaml 用它，没有就把当前 config 存一份作为 base。
    let base_backup = cfg_dir.join("config.base.yaml");
    let base_source = if base_backup.exists() {
        match fs::read_to_string(&base_backup) {
            Ok(s) => s,
            Err(_) => base_yaml_raw.clone(),
        }
    } else {
        let _ = fs::write(&base_backup, &base_yaml_raw);
        base_yaml_raw.clone()
    };

    // 3. 解析
    let mut base_val: serde_yaml::Value = match serde_yaml::from_str(&base_source) {
        Ok(v) => v,
        Err(e) => return IpcResult::err(format!("解析基础 config.yaml 失败: {}", e)),
    };

    // 4. 合并 mixin（如果启用且非空）
    let mut applied = false;
    if mixin_enabled && !mixin_content.trim().is_empty() {
        let overlay: serde_yaml::Value = match serde_yaml::from_str(&mixin_content) {
            Ok(v) => v,
            Err(e) => return IpcResult::err(format!("解析 Mixin YAML 失败: {}", e)),
        };
        deep_merge_yaml(&mut base_val, overlay);
        applied = true;
    }

    // 5. 写回最终 config.yaml
    let merged = match serde_yaml::to_string(&base_val) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(format!("序列化最终 YAML 失败: {}", e)),
    };
    if let Err(e) = fs::write(&config_file, &merged) {
        return IpcResult::err(format!("写入 config.yaml 失败: {}", e));
    }

    // 6. 如果引擎在跑，调用 /configs PUT 热重载
    let is_running = {
        let state = app.state::<EngineAppState>();
        let mut engine = state.engine.lock().unwrap();
        engine.is_running()
    };

    if is_running {
        let client = reqwest::Client::builder().no_proxy()
            .timeout(std::time::Duration::from_secs(5))
            .build().unwrap();
        let cfg_path_str = config_file.to_string_lossy().to_string();
        let body = format!(
            r#"{{"path":"{}"}}"#,
            cfg_path_str.replace('\\', "\\\\").replace('"', "\\\""),
        );
        match client.put("http://127.0.0.1:9090/configs?force=true")
            .header("Content-Type", "application/json")
            .body(body)
            .send().await
        {
            Ok(resp) if resp.status().is_success() => {
                IpcResult::ok(if applied { "已热重载（应用 Mixin）".to_string() } else { "已热重载".to_string() })
            }
            Ok(resp) => {
                let text = resp.text().await.unwrap_or_default();
                IpcResult::err(format!("热重载失败: {}", text))
            }
            Err(e) => IpcResult::err(format!("热重载失败（引擎可能未就绪）: {}", e)),
        }
    } else {
        IpcResult::ok(if applied { "已应用（引擎未运行，下次启动生效）".to_string() } else { "已保存".to_string() })
    }
}

// ─── 扫描本地已有的 Clash / Mihomo 配置 ─────────────────────────
//
// 首次使用 Kite 的用户通常已经在 ClashX / ClashX Pro / Clash Verge /
// Clash for Windows 等客户端里跑着订阅了，那些 config.yaml 可以直接
// 作为 Kite 的起点（尤其是里面带着已付费的代理节点 / 规则，重新配
// 一遍徒增摩擦）。

#[derive(Debug, Serialize, Deserialize)]
pub struct LocalClashConfig {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mtime_secs: u64,
}

fn common_clash_config_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        // macOS 下 ClashX / ClashX Pro / Clash Verge / Nexitally 窗口版
        #[cfg(target_os = "macos")]
        {
            dirs.push(home.join(".config/clash"));
            dirs.push(home.join(".config/mihomo"));
            dirs.push(home.join("Library/Application Support/com.west2online.ClashX"));
            dirs.push(home.join("Library/Application Support/com.west2online.ClashXPro"));
            dirs.push(home.join("Library/Application Support/clash_win_nex"));
            dirs.push(home.join("Library/Application Support/io.github.clash-verge-rev.clash-verge-rev"));
        }
        #[cfg(target_os = "windows")]
        {
            dirs.push(home.join(".config/clash"));
            dirs.push(home.join("AppData/Roaming/clash_win_nex"));
            dirs.push(home.join("AppData/Roaming/io.github.clash-verge-rev.clash-verge-rev"));
        }
        #[cfg(target_os = "linux")]
        {
            dirs.push(home.join(".config/clash"));
            dirs.push(home.join(".config/mihomo"));
            dirs.push(home.join(".config/clash-verge"));
        }
    }
    dirs
}

/// 扫描系统里已有的 Clash/Mihomo YAML 配置（不读内容，只返回元数据）。
#[tauri::command]
pub async fn scan_local_clash_configs() -> IpcResult<Vec<LocalClashConfig>> {
    let mut found = Vec::new();
    for dir in common_clash_config_dirs() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() { continue; }
            let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
            if ext != "yaml" && ext != "yml" { continue; }
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            // 跳过太小的文件（<1KB 基本不是真订阅配置）
            if meta.len() < 1024 { continue; }
            let mtime_secs = meta.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
            found.push(LocalClashConfig {
                path: path.to_string_lossy().to_string(),
                name,
                size: meta.len(),
                mtime_secs,
            });
        }
    }
    // 按 mtime 倒序，用户最常用的排前面
    found.sort_by(|a, b| b.mtime_secs.cmp(&a.mtime_secs));
    IpcResult::ok(found)
}

/// 把本地 Clash 配置导入到 Kite 的 mihomo 配置目录作为 base。
/// 同时清掉可能残留的 config.base.yaml（防止 mixin 合并错乱）。
#[tauri::command]
pub async fn import_local_clash_config(app: AppHandle, source_path: String) -> IpcResult<String> {
    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return IpcResult::err(format!("文件不存在: {}", source_path));
    }
    let content = match fs::read_to_string(&source) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(format!("读取失败: {}", e)),
    };
    // 校验是合法 YAML
    if serde_yaml::from_str::<serde_yaml::Value>(&content).is_err() {
        return IpcResult::err("文件不是合法的 YAML".to_string());
    }
    let cfg_dir = match get_config_dir(&app) {
        Ok(d) => d,
        Err(e) => return IpcResult::err(e),
    };
    if let Err(e) = fs::write(cfg_dir.join("config.yaml"), &content) {
        return IpcResult::err(format!("写入失败: {}", e));
    }
    // 清掉旧 base，下次 apply_mixin 会从新 config 重新做基线
    let _ = fs::remove_file(cfg_dir.join("config.base.yaml"));
    IpcResult::ok(format!("已导入 {} 字节", content.len()))
}

/// 读取 bundled default_config.yaml 里的 rules 数组，返回 JSON。
/// 引擎未运行时 Rules 页用这个展示模板规则（而不是硬编码 4 条）。
/// 直接 TCP 连接测速（不需要 mihomo 运行）。
/// 测量到代理服务器的 TCP 握手延迟，跟 ClashX / Clash Verge 的独立测速一样。
/// 引擎启动后调用：从 mihomo /proxies 拉数据重建托盘菜单（加入节点切换子菜单）
#[tauri::command]
pub async fn rebuild_tray_with_proxies(app: AppHandle) -> IpcResult<()> {
    let client = reqwest::Client::builder().no_proxy()
        .timeout(std::time::Duration::from_secs(3))
        .build().unwrap();
    match client.get("http://127.0.0.1:9090/proxies").send().await {
        Ok(resp) => {
            if let Ok(text) = resp.text().await {
                crate::tray::rebuild_proxy_menu(&app, &text);
                return IpcResult::ok(());
            }
            IpcResult::err("解析代理数据失败".to_string())
        }
        Err(e) => IpcResult::err(format!("获取代理列表失败: {}", e)),
    }
}

#[tauri::command]
pub async fn test_node_tcp_delay(server: String, port: u16, timeout_ms: Option<u64>) -> IpcResult<u32> {
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(5000));
    let addr = format!("{}:{}", server, port);
    let start = std::time::Instant::now();
    match tokio::time::timeout(timeout, tokio::net::TcpStream::connect(&addr)).await {
        Ok(Ok(_)) => {
            let ms = start.elapsed().as_millis() as u32;
            IpcResult::ok(ms)
        }
        Ok(Err(e)) => IpcResult::err(format!("连接失败: {}", e)),
        Err(_) => IpcResult::err("超时".to_string()),
    }
}

#[tauri::command]
pub async fn get_default_rules(app: AppHandle) -> IpcResult<String> {
    let yaml_content = load_default_config_template(&app);
    let val: serde_yaml::Value = match serde_yaml::from_str(&yaml_content) {
        Ok(v) => v,
        Err(e) => return IpcResult::err(format!("解析默认配置失败: {}", e)),
    };
    let rules = val.get("rules").cloned().unwrap_or(serde_yaml::Value::Sequence(vec![]));
    let rules_seq = rules.as_sequence().cloned().unwrap_or_default();
    // 转成 mihomo /rules API 相同格式的 JSON
    let mut out: Vec<serde_json::Value> = Vec::new();
    for r in &rules_seq {
        if let Some(s) = r.as_str() {
            let parts: Vec<&str> = s.splitn(3, ',').collect();
            if parts.len() >= 2 {
                let rule_type = parts[0].trim();
                let payload = if parts.len() == 3 { parts[1].trim() } else { "" };
                let proxy = parts.last().unwrap().trim()
                    .replace(",no-resolve", "").replace(",src", "");
                out.push(serde_json::json!({
                    "type": rule_type,
                    "payload": payload,
                    "proxy": proxy,
                }));
            }
        }
    }
    IpcResult::ok(serde_json::json!({ "rules": out }).to_string())
}

#[tauri::command]
pub async fn sync_tray_state(
    app: AppHandle,
    engine_running: bool,
    system_proxy: bool,
    mode: String,
    tun_enabled: bool,
    mixin_enabled: bool,
) -> IpcResult<()> {
    crate::tray::update_engine_status(&app, engine_running);
    crate::tray::update_system_proxy_check(&app, system_proxy);
    crate::tray::update_mode_check(&app, &mode);
    crate::tray::update_tun_check(&app, tun_enabled);
    crate::tray::update_mixin_check(&app, mixin_enabled);
    IpcResult::ok(())
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

/// 优先从 bundled resources 里找一份完整的默认配置；否则 fallback 到最小可跑配置。
/// 顺序：
/// 1. bundled resources/default_config.yaml（派生自典型 Clash 机场订阅，7000+ 条规则）
/// 2. 开发模式下 src-tauri/resources/default_config.yaml
/// 3. 兜底：硬编码的极简 config（只保证引擎能启动）
fn load_default_config_template(app: &AppHandle) -> String {
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
        let default_config = load_default_config_template(&app);
        let _ = fs::write(&config_file, &default_config);
    }

    let config_dir_str = config_dir.to_string_lossy().to_string();
    let state = app.state::<EngineAppState>();
    let mut engine = state.engine.lock().unwrap();

    match engine.start(&mihomo_path, &config_dir_str) {
        Ok(pid) => {
            update_tray_tooltip(&app, "运行中");
            drop(engine);
            sync_tray_engine(&app, true);
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
    // 1. 先关系统代理（在停引擎之前，避免流量指向不存在的端口→断网）
    let _ = system_proxy::disable();

    // 2. 停引擎
    {
        let state = app.state::<EngineAppState>();
        let mut engine = state.engine.lock().unwrap();
        let _ = engine.stop(); // stop() 内部已有 killall fallback
    }

    update_tray_tooltip(&app, "已停止");
    sync_tray_engine(&app, false);
    sync_tray_system_proxy(&app, false);
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
    let (child_running, pid) = {
        let state = app.state::<EngineAppState>();
        let mut engine = state.engine.lock().unwrap();
        (engine.is_running(), engine.pid())
    }; // MutexGuard 在这里 drop，不跨 await

    // 即使 child process 不在（dev 重编译后丢失），也检查 mihomo API 是否响应
    let api_running = if !child_running {
        let client = reqwest::Client::builder().no_proxy()
            .timeout(std::time::Duration::from_millis(500))
            .build().unwrap();
        client.get("http://127.0.0.1:9090/version").send().await
            .map(|r| r.status().is_success()).unwrap_or(false)
    } else {
        true
    };

    let running = child_running || api_running;
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

/// 拉取远程订阅。
///
/// 健壮性措施：
/// 1. User-Agent 伪装成 mihomo（大部分机场 CDN 白名单识别 clash/mihomo）
/// 2. 自动解压 gzip/brotli/deflate（reqwest 开启 gzip feature）
/// 3. 自动重试最多 2 次（间隔 1s、2s）
/// 4. 空响应体视为失败（而不是返回空 content 让前端解析爆炸）
/// 5. 超时默认 30s（部分机场 CDN 慢）
#[tauri::command]
pub async fn fetch_remote_subscription(url: String, timeout_ms: Option<u64>) -> IpcResult<FetchedSubscription> {
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(30000));

    let client = match reqwest::Client::builder().no_proxy()
        .timeout(timeout)
        // mihomo 的真实 UA —— 大部分机场 CDN 白名单识别这个
        .user_agent(format!("clash.meta/{}", env!("CARGO_PKG_VERSION")))
        .gzip(true)
        .brotli(true)
        .deflate(true)
        // 跟随重定向（最多 10 跳）
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => return IpcResult::err(format!("创建 HTTP 客户端失败: {}", e)),
    };

    // 最多重试 3 次（首次 + 2 次重试）
    let max_retries = 2;
    let mut last_err = String::new();
    for attempt in 0..=max_retries {
        if attempt > 0 {
            eprintln!("[KITE] 订阅拉取重试 {}/{}: {}", attempt, max_retries, &url);
            tokio::time::sleep(std::time::Duration::from_secs(attempt as u64)).await;
        }

        let resp = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("网络请求失败: {}", e);
                continue;
            }
        };

        let status = resp.status();
        if !status.is_success() {
            last_err = format!("HTTP {}: {}", status.as_u16(),
                status.canonical_reason().unwrap_or("服务器返回错误"));
            // 4xx 不重试（客户端错误 / 订阅 key 无效），5xx 才重试
            if status.is_client_error() { break; }
            continue;
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
            Err(e) => {
                last_err = format!("读取响应体失败: {}", e);
                continue;
            }
        };

        // 空响应体 = 失败（CDN 返回 200 但没给内容，可能是地理限制或 bot 防护）
        if content.trim().is_empty() {
            last_err = "服务器返回空响应。可能原因：订阅已过期、CDN 地理限制、或需要从代理环境访问".to_string();
            continue;
        }

        return IpcResult::ok(FetchedSubscription {
            content, user_info, content_type, update_interval,
        });
    }

    IpcResult::err(last_err)
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
pub async fn enable_system_proxy(app: AppHandle, host: Option<String>, port: Option<u16>) -> IpcResult<bool> {
    let config = system_proxy::ProxyConfig {
        host: host.unwrap_or_else(|| "127.0.0.1".to_string()),
        port: port.unwrap_or(7890),
    };
    match system_proxy::enable(&config) {
        Ok(()) => {
            sync_tray_system_proxy(&app, true);
            IpcResult::ok(true)
        },
        Err(e) => IpcResult::err(e),
    }
}

#[tauri::command]
pub async fn disable_system_proxy(app: AppHandle) -> IpcResult<bool> {
    match system_proxy::disable() {
        Ok(()) => {
            sync_tray_system_proxy(&app, false);
            IpcResult::ok(false)
        },
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
pub async fn set_mode(app: AppHandle, mode: String, controller_url: Option<String>) -> IpcResult<()> {
    let url = controller_url.unwrap_or_else(|| "http://127.0.0.1:9090".to_string());
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    match client.patch(format!("{}/configs", url))
        .header("Content-Type", "application/json")
        .body(format!(r#"{{"mode":"{}"}}"#, mode))
        .send().await
    {
        Ok(_) => {
            sync_tray_mode(&app, &mode);
            IpcResult::ok(())
        },
        Err(e) => IpcResult::err(format!("设置模式失败: {}", e)),
    }
}

// ─── mihomo API 代理（前端通过 IPC 调用，避免 CORS）───────────────────────

#[tauri::command]
pub async fn mihomo_get_connections(controller_url: Option<String>) -> IpcResult<String> {
    let url = controller_url.unwrap_or_else(|| "http://127.0.0.1:9090".to_string());
    let client = reqwest::Client::builder().no_proxy()
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
    let client = reqwest::Client::builder().no_proxy()
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

#[tauri::command]
pub async fn mihomo_get_rules(controller_url: Option<String>) -> IpcResult<String> {
    let url = controller_url.unwrap_or_else(|| "http://127.0.0.1:9090".to_string());
    let client = reqwest::Client::builder().no_proxy()
        .timeout(std::time::Duration::from_secs(2))
        .build().unwrap();

    match client.get(format!("{}/rules", url)).send().await {
        Ok(resp) => match resp.text().await {
            Ok(text) => IpcResult::ok(text),
            Err(e) => IpcResult::err(format!("读取规则数据失败: {}", e)),
        },
        Err(e) => IpcResult::err(format!("获取规则列表失败: {}", e)),
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

    let client = reqwest::Client::builder().no_proxy().build().unwrap();
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
    let client = reqwest::Client::builder().no_proxy()
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
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

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
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

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
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

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

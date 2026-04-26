//! config.yaml 的读写、AppConfig 持久化、Mixin 合并、Clash 本地配置导入、默认 rules。

use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

use crate::engine::EngineState as EngineAppState;
use tauri::Manager;
use super::{
    IpcResult, LocalClashConfig,
    get_config_dir, get_data_path, load_default_config_template,
};

// ─── 配置文件读写 ────────────────────────────────────────────────────────────

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

// ─── AppConfig 持久化 ────────────────────────────────────────────────────────

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

// ─── 默认 rules ──────────────────────────────────────────────────────────────

/// 读取 bundled default_config.yaml 里的 rules 数组，返回 JSON。
/// 引擎未运行时 Rules 页用这个展示模板规则（而不是硬编码 4 条）。
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

// ─── 扫描本地已有的 Clash / Mihomo 配置 ─────────────────────────
//
// 首次使用 Kite 的用户通常已经在 ClashX / ClashX Pro / Clash Verge /
// Clash for Windows 等客户端里跑着订阅了，那些 config.yaml 可以直接
// 作为 Kite 的起点（尤其是里面带着已付费的代理节点 / 规则，重新配
// 一遍徒增摩擦）。

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

// ─── Mixin 深度合并 ─────────────────────────────────────────────────────────

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

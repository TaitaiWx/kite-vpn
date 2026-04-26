//! mihomo HTTP API 的代理（前端调 mihomo 走这里，避免 CORS）。
//!
//! 包含 connections / proxies / rules / version / select / close / reload，
//! 以及 set_mode 和 rebuild_tray_with_proxies（这两个动作都依赖 mihomo API）。

use tauri::AppHandle;

use super::{IpcResult, sync_tray_mode};

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
        }
        Err(e) => IpcResult::err(format!("设置模式失败: {}", e)),
    }
}

// ─── HTTP API 代理 ──────────────────────────────────────────────────────────

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
            }
            Err(e) => IpcResult::err(format!("读取版本失败: {}", e)),
        },
        Err(e) => IpcResult::err(format!("获取版本失败: {}", e)),
    }
}

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

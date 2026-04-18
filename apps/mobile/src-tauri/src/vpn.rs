use serde::{Deserialize, Serialize};
use tauri::AppHandle;

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
    #[allow(dead_code)]
    pub fn err(msg: impl Into<String>) -> Self {
        Self { success: false, data: None, error: Some(msg.into()) }
    }
}

/// 通过 Android Intent 启动 KiteVpnService 前台服务。
/// Tauri 的 shell plugin 执行 `am startservice`。
///
/// 在 Android 上，VPN 必须走 VpnService API（需要用户授权弹窗）。
/// KiteVpnService.kt 负责创建 TUN + 设置 HttpProxy → mihomo 端口。
#[tauri::command]
pub async fn start_vpn(app: AppHandle, proxy_port: Option<u16>, dns_port: Option<u16>) -> IpcResult<bool> {
    let port = proxy_port.unwrap_or(7890);
    let dns = dns_port.unwrap_or(1053);

    // 通过 Tauri shell plugin 调用 Android Activity Manager 启动服务。
    // 在真正的 Android 打包环境下，更好的做法是使用 Tauri 的
    // Android plugin bridge (Kotlin ↔ Rust)。这里用 shell 启动作为 MVP。
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_shell::ShellExt;
        let shell = app.shell();
        let output = shell.command("am")
            .args([
                "startservice",
                "-n", "com.kitevpn.mobile/.KiteVpnService",
                "--ei", "proxy_port", &port.to_string(),
                "--ei", "dns_port", &dns.to_string(),
            ])
            .output()
            .await;
        match output {
            Ok(o) if o.status.success() => return IpcResult::ok(true),
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr).to_string();
                return IpcResult::err(format!("启动 VPN 服务失败: {}", stderr));
            }
            Err(e) => return IpcResult::err(format!("执行命令失败: {}", e)),
        }
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, port, dns);
        IpcResult::ok(false) // 非 Android 平台不需要 VpnService
    }
}

/// 停止 VPN 服务。
#[tauri::command]
pub async fn stop_vpn(app: AppHandle) -> IpcResult<bool> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_shell::ShellExt;
        let shell = app.shell();
        let output = shell.command("am")
            .args([
                "startservice",
                "-n", "com.kitevpn.mobile/.KiteVpnService",
                "-a", "com.kitevpn.STOP",
            ])
            .output()
            .await;
        match output {
            Ok(_) => return IpcResult::ok(true),
            Err(e) => return IpcResult::err(format!("停止 VPN 服务失败: {}", e)),
        }
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        IpcResult::ok(false)
    }
}

/// 查询 VPN 服务是否在运行。
#[tauri::command]
pub async fn get_vpn_status(app: AppHandle) -> IpcResult<bool> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_shell::ShellExt;
        let shell = app.shell();
        let output = shell.command("dumpsys")
            .args(["activity", "services", "com.kitevpn.mobile/.KiteVpnService"])
            .output()
            .await;
        match output {
            Ok(o) => {
                let stdout = String::from_utf8_lossy(&o.stdout);
                return IpcResult::ok(stdout.contains("ServiceRecord"));
            }
            Err(_) => return IpcResult::ok(false),
        }
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        IpcResult::ok(false)
    }
}

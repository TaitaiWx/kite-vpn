//! 系统代理 + 开机自启动。

use std::fs;
use tauri::AppHandle;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::system_proxy;
use super::{IpcResult, sync_tray_system_proxy};

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
        }
        Err(e) => IpcResult::err(e),
    }
}

#[tauri::command]
pub async fn disable_system_proxy(app: AppHandle) -> IpcResult<bool> {
    match system_proxy::disable() {
        Ok(()) => {
            sync_tray_system_proxy(&app, false);
            IpcResult::ok(false)
        }
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
        let mut c = std::process::Command::new("reg");
        if enabled {
            c.args(["add", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                    "/v", "Kite", "/t", "REG_SZ", "/d", &exe_path, "/f"]);
        } else {
            c.args(["delete", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                    "/v", "Kite", "/f"]);
        }
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let _ = c.output();
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

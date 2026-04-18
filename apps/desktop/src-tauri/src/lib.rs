mod commands;
mod engine;
mod native_menu_mac;
mod system_proxy;
mod tray;

/// 初始化本地日志文件。所有 eprintln! 输出 + panic 信息都写进去。
/// 路径：~/Library/Application Support/com.kitevpn.desktop/logs/kite.log（macOS）
fn init_local_logging() {
    use std::{fs, io::Write, panic};

    // 跟 Tauri 的 app_data_dir() 保持一致：
    // macOS:   ~/Library/Application Support/com.kitevpn.desktop/logs/
    // Windows: %APPDATA%/com.kitevpn.desktop/logs/
    // Linux:   ~/.local/share/com.kitevpn.desktop/logs/
    let log_dir = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("com.kitevpn.desktop")
        .join("logs");
    let _ = fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("kite.log");

    // 截断到最近 50KB（避免日志无限膨胀）
    if let Ok(meta) = fs::metadata(&log_path) {
        if meta.len() > 50 * 1024 {
            if let Ok(content) = fs::read_to_string(&log_path) {
                let keep = &content[content.len().saturating_sub(30 * 1024)..];
                let _ = fs::write(&log_path, keep);
            }
        }
    }

    // 写启动时间戳
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&log_path) {
        let _ = writeln!(f, "\n══ Kite started at {} ══", chrono_now());
    }

    // panic hook —— 把 panic 信息写日志 + stderr
    let log_path_clone = log_path.clone();
    panic::set_hook(Box::new(move |info| {
        let msg = format!("[PANIC] {}", info);
        eprintln!("{}", msg);
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&log_path_clone) {
            let _ = writeln!(f, "{} {}", chrono_now(), msg);
        }
    }));

    eprintln!("[KITE] 日志文件: {}", log_path.display());
}

fn chrono_now() -> String {
    use std::time::SystemTime;
    let d = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs();
    let h = (secs / 3600) % 24;
    let m = (secs / 60) % 60;
    let s = secs % 60;
    format!("{:02}:{:02}:{:02}", h, m, s)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_local_logging();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        // 源码与分发都在公开的 TaitaiWx/kite-vpn。零鉴权零秘密在二进制里。
        // 更新完整性靠 minisign 签名保证（pubkey 在 tauri.conf.json）。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(engine::EngineState::new())
        .setup(|app| {
            // 启动时清理：如果上次异常退出残留了系统代理但引擎没跑，关掉代理
            if system_proxy::is_enabled().unwrap_or(false) {
                // 快速检查 mihomo 是否在跑（TCP 连接 9090）
                let api_alive = std::net::TcpStream::connect_timeout(
                    &"127.0.0.1:9090".parse().unwrap(),
                    std::time::Duration::from_millis(200),
                ).is_ok();
                if !api_alive {
                    eprintln!("[KITE] 检测到残留系统代理（引擎未运行），自动关闭");
                    let _ = system_proxy::disable();
                }
            }
            tray::create_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 点关闭时隐藏窗口到托盘，不退出
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::check_mihomo,
            commands::engine_start,
            commands::engine_stop,
            commands::engine_restart,
            commands::engine_get_state,
            commands::fetch_remote_subscription,
            commands::write_config,
            commands::read_config,
            commands::save_subscriptions,
            commands::load_subscriptions,
            commands::save_app_config,
            commands::load_app_config,
            commands::enable_system_proxy,
            commands::disable_system_proxy,
            commands::get_system_proxy_status,
            commands::set_mode,
            commands::mihomo_get_connections,
            commands::mihomo_get_proxies,
            commands::mihomo_get_rules,
            commands::mihomo_get_logs,
            commands::mihomo_get_version,
            commands::mihomo_reload_config,
            commands::mihomo_select_proxy,
            commands::mihomo_close_connections,
            commands::test_proxy_delay,
            commands::set_autostart,
            commands::sync_tray_state,
            commands::apply_mixin_and_reload,
            commands::rebuild_tray_with_proxies,
            commands::test_node_tcp_delay,
            commands::get_default_rules,
            commands::scan_local_clash_configs,
            commands::import_local_clash_config,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            use tauri::Manager;
            if let tauri::RunEvent::Exit = event {
                eprintln!("[KITE] App exiting, cleaning up...");
                // 关系统代理（防止退出后代理残留→断网）
                let _ = system_proxy::disable();
                // 停 mihomo 进程
                if let Some(state) = _app.try_state::<engine::EngineState>() {
                    let mut eng = state.engine.lock().unwrap();
                    let _ = eng.stop();
                }
                eprintln!("[KITE] Cleanup done.");
            }
        });
}

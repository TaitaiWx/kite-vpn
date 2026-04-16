mod commands;
mod engine;
mod system_proxy;
mod tray;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            commands::scan_local_clash_configs,
            commands::import_local_clash_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

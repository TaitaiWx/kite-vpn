mod commands;
mod vpn;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .manage(commands::EngineState::new())
        .invoke_handler(tauri::generate_handler![
            commands::engine_start,
            commands::engine_stop,
            commands::engine_get_state,
            commands::fetch_remote_subscription,
            commands::write_config,
            commands::read_config,
            commands::save_subscriptions,
            commands::load_subscriptions,
            commands::save_app_config,
            commands::load_app_config,
            commands::set_mode,
            commands::mihomo_get_connections,
            commands::mihomo_get_proxies,
            commands::mihomo_reload_config,
            commands::mihomo_select_proxy,
            commands::test_proxy_delay,
            vpn::start_vpn,
            vpn::stop_vpn,
            vpn::get_vpn_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

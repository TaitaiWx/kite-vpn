use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Manager,
};

pub fn create_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏窗口", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let mode_rule = MenuItem::with_id(app, "mode_rule", "🔰 规则模式", true, None::<&str>)?;
    let mode_global = MenuItem::with_id(app, "mode_global", "🌐 全局模式", true, None::<&str>)?;
    let mode_direct = MenuItem::with_id(app, "mode_direct", "🔗 直连模式", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let system_proxy = MenuItem::with_id(app, "system_proxy", "系统代理", true, None::<&str>)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Kite", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &toggle, &sep1,
            &mode_rule, &mode_global, &mode_direct, &sep2,
            &system_proxy, &sep3,
            &quit,
        ],
    )?;

    TrayIconBuilder::with_id("kite-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Kite — 已停止")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

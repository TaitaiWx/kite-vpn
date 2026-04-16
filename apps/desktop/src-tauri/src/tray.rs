use std::sync::Mutex;

use tauri::{
    include_image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Wry,
};

pub struct TrayHandles {
    pub mode_rule: CheckMenuItem<Wry>,
    pub mode_global: CheckMenuItem<Wry>,
    pub mode_direct: CheckMenuItem<Wry>,
    pub system_proxy: CheckMenuItem<Wry>,
    pub tun_mode: CheckMenuItem<Wry>,
    pub mixin: CheckMenuItem<Wry>,
    pub engine_toggle: MenuItem<Wry>,
    pub status_label: MenuItem<Wry>,
}

pub struct TrayState(pub Mutex<Option<TrayHandles>>);

pub fn create_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    eprintln!("[KITE] create_tray: building menu …");

    // ── 状态 & 主面板 ───────────────────────────────────────
    let status_label = MenuItem::with_id(app, "status_label", "● 引擎已停止", false, None::<&str>)?;
    let dashboard = MenuItem::with_id(app, "dashboard", "打开主面板", true, Some("CmdOrCtrl+Shift+D"))?;
    let sep_a = PredefinedMenuItem::separator(app)?;

    // ── 引擎开关 ────────────────────────────────────────────
    let engine_toggle = MenuItem::with_id(app, "engine_toggle", "启动引擎", true, Some("CmdOrCtrl+E"))?;

    let sep_b = PredefinedMenuItem::separator(app)?;

    // ── 出站模式（平铺，CheckMenuItem 做单选） ───────────────
    let mode_header = MenuItem::with_id(app, "mode_header", "出站模式", false, None::<&str>)?;
    let mode_rule = CheckMenuItem::with_id(app, "mode_rule", "  规则模式", true, true, None::<&str>)?;
    let mode_global = CheckMenuItem::with_id(app, "mode_global", "  全局模式", true, false, None::<&str>)?;
    let mode_direct = CheckMenuItem::with_id(app, "mode_direct", "  直连模式", true, false, None::<&str>)?;

    let sep_c = PredefinedMenuItem::separator(app)?;

    // ── 接入方式 ────────────────────────────────────────────
    let system_proxy = CheckMenuItem::with_id(
        app,
        "system_proxy",
        "设为系统代理",
        true,
        false,
        None::<&str>,
    )?;
    let tun_mode = CheckMenuItem::with_id(
        app,
        "tun_mode",
        "TUN 模式",
        true,
        false,
        None::<&str>,
    )?;
    let mixin = CheckMenuItem::with_id(
        app,
        "mixin",
        "启用 Mixin",
        true,
        false,
        None::<&str>,
    )?;

    let sep_d = PredefinedMenuItem::separator(app)?;

    // ── 订阅与配置 ──────────────────────────────────────────
    let subscriptions = MenuItem::with_id(app, "subscriptions", "订阅管理…", true, None::<&str>)?;
    let reload_config = MenuItem::with_id(app, "reload_config", "重载配置", true, None::<&str>)?;
    let open_config_dir = MenuItem::with_id(app, "open_config_dir", "打开配置目录", true, None::<&str>)?;

    let sep_e = PredefinedMenuItem::separator(app)?;

    // ── 帮助 ────────────────────────────────────────────────
    let check_update = MenuItem::with_id(app, "check_update", "检查更新…", true, None::<&str>)?;
    let about = MenuItem::with_id(app, "about", "关于 Kite", true, None::<&str>)?;

    let sep_f = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Kite", true, Some("CmdOrCtrl+Q"))?;

    let menu = Menu::with_items(
        app,
        &[
            &status_label,
            &dashboard,
            &sep_a,
            &engine_toggle,
            &sep_b,
            &mode_header,
            &mode_rule,
            &mode_global,
            &mode_direct,
            &sep_c,
            &system_proxy,
            &tun_mode,
            &mixin,
            &sep_d,
            &subscriptions,
            &reload_config,
            &open_config_dir,
            &sep_e,
            &check_update,
            &about,
            &sep_f,
            &quit,
        ],
    )?;

    // 保存句柄以便后续动态更新勾选 / 文字
    app.manage(TrayState(Mutex::new(Some(TrayHandles {
        mode_rule: mode_rule.clone(),
        mode_global: mode_global.clone(),
        mode_direct: mode_direct.clone(),
        system_proxy: system_proxy.clone(),
        tun_mode: tun_mode.clone(),
        mixin: mixin.clone(),
        engine_toggle: engine_toggle.clone(),
        status_label: status_label.clone(),
    }))));

    let icon = include_image!("icons/32x32.png");

    let mut builder = TrayIconBuilder::with_id("kite-tray")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Kite — 跨平台代理客户端");

    #[cfg(target_os = "macos")]
    {
        builder = builder.title("Kite");
    }

    let tray = builder
        .on_menu_event(|app, event| {
            let id = event.id.as_ref().to_string();
            eprintln!("[KITE] menu event: {}", id);
            dispatch_menu_event(app, &id);
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    eprintln!("[KITE] tray built successfully: id={:?}", tray.id());
    Ok(())
}

fn dispatch_menu_event(app: &AppHandle, id: &str) {
    match id {
        "dashboard" => show_main_window(app),
        "quit" => app.exit(0),
        "engine_toggle" => emit(app, "tray://engine-toggle", ()),
        "mode_rule" => {
            set_mode_check(app, "rule");
            emit(app, "tray://set-mode", "rule");
        }
        "mode_global" => {
            set_mode_check(app, "global");
            emit(app, "tray://set-mode", "global");
        }
        "mode_direct" => {
            set_mode_check(app, "direct");
            emit(app, "tray://set-mode", "direct");
        }
        "system_proxy" => emit(app, "tray://toggle-system-proxy", ()),
        "tun_mode" => emit(app, "tray://toggle-tun", ()),
        "mixin" => emit(app, "tray://toggle-mixin", ()),
        "subscriptions" => {
            show_main_window(app);
            emit(app, "tray://navigate", "/subscriptions");
        }
        "reload_config" => emit(app, "tray://reload-config", ()),
        "open_config_dir" => {
            if let Ok(dir) = app.path().app_data_dir() {
                let mihomo = dir.join("mihomo");
                let _ = open_path(&mihomo);
            }
        }
        "check_update" => {
            show_main_window(app);
            emit(app, "tray://navigate", "/settings");
            emit(app, "tray://check-update", ());
        }
        "about" => {
            show_main_window(app);
            emit(app, "tray://navigate", "/settings");
        }
        _ => {}
    }
}

fn emit<P: serde::Serialize + Clone>(app: &AppHandle, event: &str, payload: P) {
    let _ = app.emit(event, payload);
}

fn show_main_window(app: &AppHandle) {
    // macOS：点托盘时 app 可能处于非激活态，Window::show() 只把窗口
    // 标记为可见，不会把 app 带到前台。需要把 activation policy 切成
    // Regular 以便 NSApp 接管激活。
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn set_mode_check(app: &AppHandle, mode: &str) {
    if let Some(state) = app.try_state::<TrayState>() {
        if let Ok(guard) = state.0.lock() {
            if let Some(handles) = guard.as_ref() {
                let _ = handles.mode_rule.set_checked(mode == "rule");
                let _ = handles.mode_global.set_checked(mode == "global");
                let _ = handles.mode_direct.set_checked(mode == "direct");
            }
        }
    }
}

fn open_path(path: &std::path::Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(path).spawn().map(|_| ())
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer").arg(path).spawn().map(|_| ())
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(path).spawn().map(|_| ())
    }
}

// ── 外部更新 API（引擎状态变化时调用） ─────────────────────────

pub fn update_engine_status(app: &AppHandle, running: bool) {
    if let Some(state) = app.try_state::<TrayState>() {
        if let Ok(guard) = state.0.lock() {
            if let Some(handles) = guard.as_ref() {
                let label = if running { "● 引擎运行中" } else { "● 引擎已停止" };
                let _ = handles.status_label.set_text(label);
                let toggle = if running { "停止引擎" } else { "启动引擎" };
                let _ = handles.engine_toggle.set_text(toggle);
            }
        }
    }
    if let Some(tray) = app.tray_by_id("kite-tray") {
        let tip = if running {
            "Kite — 运行中"
        } else {
            "Kite — 已停止"
        };
        let _ = tray.set_tooltip(Some(tip));
    }
}

pub fn update_system_proxy_check(app: &AppHandle, enabled: bool) {
    if let Some(state) = app.try_state::<TrayState>() {
        if let Ok(guard) = state.0.lock() {
            if let Some(handles) = guard.as_ref() {
                let _ = handles.system_proxy.set_checked(enabled);
            }
        }
    }
}

pub fn update_mode_check(app: &AppHandle, mode: &str) {
    set_mode_check(app, mode);
}

pub fn update_tun_check(app: &AppHandle, enabled: bool) {
    if let Some(state) = app.try_state::<TrayState>() {
        if let Ok(guard) = state.0.lock() {
            if let Some(handles) = guard.as_ref() {
                let _ = handles.tun_mode.set_checked(enabled);
            }
        }
    }
}

pub fn update_mixin_check(app: &AppHandle, enabled: bool) {
    if let Some(state) = app.try_state::<TrayState>() {
        if let Ok(guard) = state.0.lock() {
            if let Some(handles) = guard.as_ref() {
                let _ = handles.mixin.set_checked(enabled);
            }
        }
    }
}

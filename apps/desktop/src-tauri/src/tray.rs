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
    let status_label = MenuItem::with_id(app, "status_label", "● 已断开", false, None::<&str>)?;
    let dashboard = MenuItem::with_id(app, "dashboard", "打开主面板", true, Some("CmdOrCtrl+Shift+D"))?;
    let sep_a = PredefinedMenuItem::separator(app)?;

    // ── 代理开关（合并了引擎+系统代理，一键操作） ──────────────
    let engine_toggle = MenuItem::with_id(app, "engine_toggle", "开启代理", true, Some("CmdOrCtrl+E"))?;

    let sep_b = PredefinedMenuItem::separator(app)?;

    // ── 出站模式 ────────────────────────────────────────────
    let mode_header = MenuItem::with_id(app, "mode_header", "出站模式", false, None::<&str>)?;
    let mode_rule = CheckMenuItem::with_id(app, "mode_rule", "  规则模式", true, true, None::<&str>)?;
    let mode_global = CheckMenuItem::with_id(app, "mode_global", "  全局模式", true, false, None::<&str>)?;
    let mode_direct = CheckMenuItem::with_id(app, "mode_direct", "  直连模式", true, false, None::<&str>)?;

    let sep_c = PredefinedMenuItem::separator(app)?;

    // 系统代理/TUN/Mixin 内部使用，不再独立暴露在初始菜单
    // （引擎启动后 rebuild_proxy_menu 会重建菜单，按需添加）
    let system_proxy = CheckMenuItem::with_id(app, "system_proxy", "系统代理", true, false, None::<&str>)?;
    let tun_mode = CheckMenuItem::with_id(app, "tun_mode", "TUN", true, false, None::<&str>)?;
    let mixin = CheckMenuItem::with_id(app, "mixin", "Mixin", true, false, None::<&str>)?;

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
        "engine_toggle" => {
            // 通知 UI 处理启停（UI 的 startEngine/stopEngine 处理完整的启停逻辑）
            emit(app, "tray://engine-toggle", ());
        }
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
        "test_all_speed" => {
            // 在后台对所有节点跑延迟测试，完成后刷新托盘菜单显示速度
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                eprintln!("[KITE] tray: starting speed test...");
                // 拉节点列表
                let client = reqwest::Client::builder().no_proxy()
                    .timeout(std::time::Duration::from_secs(5)).build().unwrap();
                let proxies_res = client.get("http://127.0.0.1:9090/proxies").send().await;
                if let Ok(resp) = proxies_res {
                    if let Ok(text) = resp.text().await {
                        #[derive(serde::Deserialize)]
                        struct P { #[serde(rename = "type")] t: String }
                        #[derive(serde::Deserialize)]
                        struct R { proxies: std::collections::HashMap<String, P> }
                        if let Ok(data) = serde_json::from_str::<R>(&text) {
                            let nodes: Vec<String> = data.proxies.iter()
                                .filter(|(_, p)| matches!(p.t.as_str(), "Shadowsocks" | "Trojan" | "VMess" | "VLESS" | "Hysteria2" | "TUIC"))
                                .map(|(n, _)| n.clone())
                                .collect();
                            // 批量测速（10 个一批）
                            for chunk in nodes.chunks(10) {
                                let futs: Vec<_> = chunk.iter().map(|name| {
                                    let c = client.clone();
                                    let n = name.clone();
                                    async move {
                                        let url = format!("http://127.0.0.1:9090/proxies/{}/delay?url=http://cp.cloudflare.com/generate_204&timeout=3000",
                                            urlencoding::encode(&n));
                                        let _ = c.get(&url).send().await;
                                    }
                                }).collect();
                                futures::future::join_all(futs).await;
                            }
                        }
                    }
                }
                // 测速完成，重新拉数据刷新托盘（这次 history 里有速度了）
                if let Ok(resp) = client.get("http://127.0.0.1:9090/proxies").send().await {
                    if let Ok(text) = resp.text().await {
                        rebuild_proxy_menu(&app2, &text);
                    }
                }
                eprintln!("[KITE] tray: speed test done, menu refreshed");
            });
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
        _ => {
            // 动态节点选择事件（格式: "proxy::<group>::<node>"）
            if id.starts_with("proxy::") {
                let parts: Vec<&str> = id.splitn(3, "::").collect();
                if parts.len() == 3 {
                    let group = parts[1].to_string();
                    let node = parts[2].to_string();
                    let _app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let client = reqwest::Client::builder().no_proxy().build().unwrap();
                        let encoded = urlencoding::encode(&group);
                        let body = format!(r#"{{"name":"{}"}}"#, node.replace('"', "\\\""));
                        let _ = client.put(format!("http://127.0.0.1:9090/proxies/{}", encoded))
                            .header("Content-Type", "application/json")
                            .body(body)
                            .send().await;
                        eprintln!("[KITE] tray: switched {} → {}", group, node);
                    });
                }
            }
        }
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
                let label = if running { "● 已连接" } else { "● 已断开" };
                let _ = handles.status_label.set_text(label);
                let toggle = if running { "关闭代理" } else { "开启代理" };
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

/// 引擎启动后调用：从 mihomo API 拉取"🔰 节点选择"组的节点，
/// 在原有托盘菜单的"出站模式"区域后面插入一个"节点选择"子菜单。
/// 不重建整个菜单——保留模式切换/TUN/Mixin/系统代理等所有原有项。
pub fn rebuild_proxy_menu(app: &AppHandle, groups_json: &str) {
    use tauri::menu::{Menu, MenuItem, CheckMenuItem, PredefinedMenuItem, Submenu};

    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct HistoryEntry {
        delay: u64,
    }

    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct ProxyGroup {
        name: String,
        #[serde(rename = "type")]
        group_type: String,
        all: Option<Vec<String>>,
        now: Option<String>,
        history: Option<Vec<HistoryEntry>>,
    }

    #[derive(serde::Deserialize)]
    struct ProxiesResponse {
        proxies: std::collections::HashMap<String, ProxyGroup>,
    }

    let data: ProxiesResponse = match serde_json::from_str(groups_json) {
        Ok(d) => d,
        Err(e) => { eprintln!("[KITE] rebuild_proxy_menu parse error: {}", e); return; }
    };

    // 找 Selector/URLTest 组 → 按地区做子菜单，每个子菜单列出该地区所有节点
    let Some(tray) = app.tray_by_id("kite-tray") else { return };

    // 收集地区组（URLTest 类型 = 地区自动选择组）+ 从 history 取速度数据
    let mut region_groups: Vec<(&String, &ProxyGroup)> = data.proxies.iter()
        .filter(|(_, g)| g.group_type == "URLTest" && g.name != "♻️ 自动选择")
        .collect();

    // 构建节点延迟映射（从 mihomo 的 history 字段）
    let mut delay_map: std::collections::HashMap<&str, u64> = std::collections::HashMap::new();
    for (name, proxy) in &data.proxies {
        if let Some(history) = &proxy.history {
            if let Some(last) = history.last() {
                if last.delay > 0 {
                    delay_map.insert(name.as_str(), last.delay);
                }
            }
        }
    }
    region_groups.sort_by(|a, b| {
        let sa = a.1.all.as_ref().map(|v| v.len()).unwrap_or(0);
        let sb = b.1.all.as_ref().map(|v| v.len()).unwrap_or(0);
        sb.cmp(&sa) // 节点多的排前面
    });

    // 全局选择器
    let global_selector = data.proxies.get("🔰 节点选择")
        .or_else(|| data.proxies.get("GLOBAL"));
    let global_current = global_selector.and_then(|g| g.now.as_deref()).unwrap_or("DIRECT");

    let ok = (|| -> Result<(), Box<dyn std::error::Error>> {
        let status = MenuItem::with_id(app, "status_label", "● 已连接", false, None::<&str>)?;
        let dashboard = MenuItem::with_id(app, "dashboard", "打开主面板", true, Some("CmdOrCtrl+Shift+D"))?;
        let sep_a = PredefinedMenuItem::separator(app)?;
        // 合并了引擎+系统代理
        let engine_toggle = MenuItem::with_id(app, "engine_toggle", "关闭代理", true, Some("CmdOrCtrl+E"))?;
        let sep_b = PredefinedMenuItem::separator(app)?;

        // 出站模式
        let mode_header = MenuItem::with_id(app, "mode_header", "出站模式", false, None::<&str>)?;
        let mode_rule = CheckMenuItem::with_id(app, "mode_rule", "  规则模式", true, true, None::<&str>)?;
        let mode_global = CheckMenuItem::with_id(app, "mode_global", "  全局模式", true, false, None::<&str>)?;
        let mode_direct = CheckMenuItem::with_id(app, "mode_direct", "  直连模式", true, false, None::<&str>)?;
        let sep_c = PredefinedMenuItem::separator(app)?;

        // ── 节点（一个 Submenu，地区名作为不可点击的 header，节点平铺） ──
        let mut node_items: Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>> = Vec::new();

        // 顶部：测试全部速度
        node_items.push(Box::new(MenuItem::with_id(app, "test_all_speed", "⚡ 测试全部速度", true, None::<&str>)?));
        node_items.push(Box::new(PredefinedMenuItem::separator(app)?));

        for (group_name, group) in &region_groups {
            let nodes = group.all.as_deref().unwrap_or(&[]);
            if nodes.is_empty() { continue; }
            let current = group.now.as_deref().unwrap_or("");
            // 地区 header（disabled = 不可点击，仅作分组标签）
            let header_id = format!("hdr_{}", group_name);
            node_items.push(Box::new(MenuItem::with_id(app, &header_id, &format!("── {} ({}) ──", group_name, nodes.len()), false, None::<&str>)?));
            // 该地区的所有节点（带彩色速度 badge）
            for node_name in nodes {
                let menu_id = format!("proxy::🔰 节点选择::{}", node_name);
                let speed = delay_map.get(node_name.as_str());
                let speed_badge = match speed {
                    Some(d) if *d > 0 && *d < 200 => format!("  🟢 {}ms", d),
                    Some(d) if *d > 0 && *d < 500 => format!("  🟡 {}ms", d),
                    Some(d) if *d > 0 => format!("  🔴 {}ms", d),
                    Some(_) => "  ⚫ timeout".to_string(),
                    None => String::new(),
                };
                let label = if *node_name == current {
                    format!("  ✓ {}{}", node_name, speed_badge)
                } else {
                    format!("    {}{}", node_name, speed_badge)
                };
                node_items.push(Box::new(MenuItem::with_id(app, &menu_id, &label, true, None::<&str>)?));
            }
        }

        let node_refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = node_items.iter().map(|b| b.as_ref()).collect();
        let nodes_menu = Submenu::with_id_and_items(
            app, "nodes_menu",
            &format!("节点 ({})", global_current),
            true, &node_refs
        )?;

        let sep_d = PredefinedMenuItem::separator(app)?;
        let subscriptions = MenuItem::with_id(app, "subscriptions", "订阅管理…", true, None::<&str>)?;
        let reload_config = MenuItem::with_id(app, "reload_config", "重载配置", true, None::<&str>)?;
        let sep_e = PredefinedMenuItem::separator(app)?;
        let quit = MenuItem::with_id(app, "quit", "退出 Kite", true, Some("CmdOrCtrl+Q"))?;

        let menu = Menu::with_items(app, &[
            &status, &dashboard, &sep_a,
            &engine_toggle, &sep_b,
            &mode_header, &mode_rule, &mode_global, &mode_direct, &sep_c,
            &nodes_menu, &sep_d,
            &subscriptions, &reload_config, &sep_e,
            &quit,
        ])?;
        tray.set_menu(Some(menu))?;
        // 彩色 emoji 圆点（🟢🟡🔴）已经在菜单项文字里，macOS 原生渲染彩色
        // NSAttributedString 方案因私有 API 不稳定，暂用 emoji 方案
        eprintln!("[KITE] tray rebuilt: {} regions, current={}", region_groups.len(), global_current);
        Ok(())
    })();

    if let Err(e) = ok {
        eprintln!("[KITE] tray rebuild error: {}", e);
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

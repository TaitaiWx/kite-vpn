//! mihomo 引擎生命周期 + 引擎日志 + 托盘状态同步。

use tauri::{AppHandle, Manager};

use crate::engine::EngineState as EngineAppState;
use crate::system_proxy;
use super::{
    EngineInfo, IpcResult, LogChunk,
    get_config_dir, get_mihomo_path, load_default_config_template, setup_geo_databases,
    sync_tray_engine, sync_tray_system_proxy, update_tray_tooltip,
};

#[tauri::command]
pub async fn check_mihomo(app: AppHandle) -> IpcResult<String> {
    match get_mihomo_path(&app) {
        Ok(path) => IpcResult::ok(path),
        Err(e) => IpcResult::err(e),
    }
}

#[tauri::command]
pub async fn engine_start(app: AppHandle) -> IpcResult<EngineInfo> {
    let config_dir = match get_config_dir(&app) {
        Ok(d) => d,
        Err(e) => return IpcResult::err(e),
    };
    let mihomo_path = match get_mihomo_path(&app) {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e),
    };

    // 复制 GeoIP/GeoSite 规则库到配置目录
    setup_geo_databases(&app, &config_dir);

    // 确保有默认配置文件
    let config_file = config_dir.join("config.yaml");
    if !config_file.exists() {
        let default_config = load_default_config_template(&app);
        let _ = std::fs::write(&config_file, &default_config);
    }

    let config_dir_str = config_dir.to_string_lossy().to_string();
    let state = app.state::<EngineAppState>();
    let mut engine = state.engine.lock().unwrap();

    match engine.start(&mihomo_path, &config_dir_str) {
        Ok(pid) => {
            update_tray_tooltip(&app, "运行中");
            drop(engine);
            sync_tray_engine(&app, true);
            IpcResult::ok(EngineInfo {
                status: "running".to_string(),
                version: None,
                pid: Some(pid),
                error: None,
            })
        }
        Err(e) => IpcResult::err(format!("启动引擎失败: {}", e)),
    }
}

#[tauri::command]
pub async fn engine_stop(app: AppHandle) -> IpcResult<EngineInfo> {
    // 1. 先关系统代理（在停引擎之前，避免流量指向不存在的端口→断网）
    let _ = system_proxy::disable();

    // 2. 停引擎
    {
        let state = app.state::<EngineAppState>();
        let mut engine = state.engine.lock().unwrap();
        let _ = engine.stop(); // stop() 内部已有 killall fallback
    }

    update_tray_tooltip(&app, "已停止");
    sync_tray_engine(&app, false);
    sync_tray_system_proxy(&app, false);
    IpcResult::ok(EngineInfo {
        status: "stopped".to_string(), version: None, pid: None, error: None,
    })
}

#[tauri::command]
pub async fn engine_restart(app: AppHandle) -> IpcResult<EngineInfo> {
    let mihomo_path = match get_mihomo_path(&app) {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e),
    };

    let state = app.state::<EngineAppState>();
    let mut engine = state.engine.lock().unwrap();

    match engine.restart(&mihomo_path) {
        Ok(pid) => IpcResult::ok(EngineInfo {
            status: "running".to_string(), version: None, pid: Some(pid), error: None,
        }),
        Err(e) => IpcResult::err(format!("重启引擎失败: {}", e)),
    }
}

#[tauri::command]
pub async fn engine_get_state(app: AppHandle) -> IpcResult<EngineInfo> {
    let (child_running, pid) = {
        let state = app.state::<EngineAppState>();
        let mut engine = state.engine.lock().unwrap();
        (engine.is_running(), engine.pid())
    }; // MutexGuard 在这里 drop，不跨 await

    // 即使 child process 不在（dev 重编译后丢失），也检查 mihomo API 是否响应
    let api_running = if !child_running {
        let client = reqwest::Client::builder().no_proxy()
            .timeout(std::time::Duration::from_millis(500))
            .build().unwrap();
        client.get("http://127.0.0.1:9090/version").send().await
            .map(|r| r.status().is_success()).unwrap_or(false)
    } else {
        true
    };

    let running = child_running || api_running;
    IpcResult::ok(EngineInfo {
        status: if running { "running" } else { "stopped" }.to_string(),
        version: None, pid, error: None,
    })
}

/// 从 stderr 缓冲读取引擎日志（从 since_index 开始的增量）
#[tauri::command]
pub async fn mihomo_get_logs(since_index: Option<usize>) -> IpcResult<LogChunk> {
    let idx = since_index.unwrap_or(0);
    let lines = crate::engine::read_logs(idx);
    let total = crate::engine::log_count();
    IpcResult::ok(LogChunk { lines, total })
}

/// 前端把当前 engine 状态镜像到托盘（启动时同步、状态变化时刷新）
#[tauri::command]
pub async fn sync_tray_state(
    app: AppHandle,
    engine_running: bool,
    system_proxy: bool,
    mode: String,
    tun_enabled: bool,
    mixin_enabled: bool,
) -> IpcResult<()> {
    crate::tray::update_engine_status(&app, engine_running);
    crate::tray::update_system_proxy_check(&app, system_proxy);
    crate::tray::update_mode_check(&app, &mode);
    crate::tray::update_tun_check(&app, tun_enabled);
    crate::tray::update_mixin_check(&app, mixin_enabled);
    IpcResult::ok(())
}

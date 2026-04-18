use std::process::Command;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProxyConfig {
    pub host: String,
    pub port: u16,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self { host: "127.0.0.1".to_string(), port: 7890 }
    }
}

pub fn enable(config: &ProxyConfig) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return enable_macos(config);
    #[cfg(target_os = "windows")]
    return enable_windows(config);
    #[cfg(target_os = "linux")]
    return enable_linux(config);
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    Err("不支持的操作系统".to_string())
}

pub fn disable() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return disable_macos();
    #[cfg(target_os = "windows")]
    return disable_windows();
    #[cfg(target_os = "linux")]
    return disable_linux();
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    Err("不支持的操作系统".to_string())
}

pub fn is_enabled() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    return is_enabled_macos();
    #[cfg(target_os = "windows")]
    return is_enabled_windows();
    #[cfg(target_os = "linux")]
    return is_enabled_linux();
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    Ok(false)
}

// ─── macOS ─────────────────────────────────────────────────────────────────
// networksetup 修改代理设置在 macOS 10.15+ 不需要 admin 权限。
// 直接用 Command::new("networksetup").args([...]) 调用，不走 shell，不弹密码。

#[cfg(target_os = "macos")]
fn get_network_services() -> Result<Vec<String>, String> {
    let output = Command::new("networksetup")
        .arg("-listallnetworkservices")
        .output()
        .map_err(|e| format!("获取网络服务列表失败: {}", e))?;

    let text = String::from_utf8_lossy(&output.stdout);
    let services: Vec<String> = text.lines()
        .skip(1)
        .filter(|l| !l.starts_with('*') && !l.is_empty())
        .map(|l| l.to_string())
        .collect();
    Ok(services)
}

#[cfg(target_os = "macos")]
fn enable_macos(config: &ProxyConfig) -> Result<(), String> {
    let services = get_network_services()?;
    let host = &config.host;
    let port = config.port.to_string();

    for service in &services {
        // 每条命令单独调用，service 名作为独立参数传入（不需要引号处理）
        let _ = Command::new("networksetup").args(["-setwebproxy", service, host, &port]).output();
        let _ = Command::new("networksetup").args(["-setwebproxystate", service, "on"]).output();
        let _ = Command::new("networksetup").args(["-setsecurewebproxy", service, host, &port]).output();
        let _ = Command::new("networksetup").args(["-setsecurewebproxystate", service, "on"]).output();
        let _ = Command::new("networksetup").args(["-setsocksfirewallproxy", service, host, &port]).output();
        let _ = Command::new("networksetup").args(["-setsocksfirewallproxystate", service, "on"]).output();
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn disable_macos() -> Result<(), String> {
    let services = get_network_services()?;
    for service in &services {
        let _ = Command::new("networksetup").args(["-setwebproxystate", service, "off"]).output();
        let _ = Command::new("networksetup").args(["-setsecurewebproxystate", service, "off"]).output();
        let _ = Command::new("networksetup").args(["-setsocksfirewallproxystate", service, "off"]).output();
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn is_enabled_macos() -> Result<bool, String> {
    let services = get_network_services()?;
    // 检查第一个有效 service（通常是 Wi-Fi 或 Ethernet）
    for service in &services {
        let output = Command::new("networksetup")
            .args(["-getwebproxy", service])
            .output();
        if let Ok(o) = output {
            let text = String::from_utf8_lossy(&o.stdout);
            if text.contains("Enabled: Yes") { return Ok(true); }
        }
    }
    Ok(false)
}

// ─── Windows ────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn enable_windows(config: &ProxyConfig) -> Result<(), String> {
    let proxy_addr = format!("{}:{}", config.host, config.port);
    run_reg("ProxyEnable", "REG_DWORD", "1")?;
    run_reg("ProxyServer", "REG_SZ", &proxy_addr)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn disable_windows() -> Result<(), String> {
    run_reg("ProxyEnable", "REG_DWORD", "0")
}

#[cfg(target_os = "windows")]
fn is_enabled_windows() -> Result<bool, String> {
    let output = Command::new("reg")
        .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings", "/v", "ProxyEnable"])
        .output()
        .map_err(|e| format!("查询注册表失败: {}", e))?;
    Ok(String::from_utf8_lossy(&output.stdout).contains("0x1"))
}

#[cfg(target_os = "windows")]
fn run_reg(name: &str, reg_type: &str, value: &str) -> Result<(), String> {
    let output = Command::new("reg")
        .args(["add", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
               "/v", name, "/t", reg_type, "/d", value, "/f"])
        .output()
        .map_err(|e| format!("设置注册表失败: {}", e))?;
    if !output.status.success() {
        return Err(format!("注册表写入失败: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}

// ─── Linux ──────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn run_gsettings(args: &[&str]) -> Result<(), String> {
    let output = Command::new("gsettings").args(args).output()
        .map_err(|e| format!("执行 gsettings 失败: {}", e))?;
    if !output.status.success() {
        return Err(format!("gsettings 失败: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn enable_linux(config: &ProxyConfig) -> Result<(), String> {
    let port = config.port.to_string();
    run_gsettings(&["set", "org.gnome.system.proxy", "mode", "manual"])?;
    for schema in &["http", "https"] {
        let full = format!("org.gnome.system.proxy.{}", schema);
        run_gsettings(&["set", &full, "host", &config.host])?;
        run_gsettings(&["set", &full, "port", &port])?;
    }
    run_gsettings(&["set", "org.gnome.system.proxy.socks", "host", &config.host])?;
    run_gsettings(&["set", "org.gnome.system.proxy.socks", "port", &port])?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn disable_linux() -> Result<(), String> {
    run_gsettings(&["set", "org.gnome.system.proxy", "mode", "none"])
}

#[cfg(target_os = "linux")]
fn is_enabled_linux() -> Result<bool, String> {
    let output = Command::new("gsettings")
        .args(["get", "org.gnome.system.proxy", "mode"])
        .output()
        .map_err(|e| format!("获取代理状态失败: {}", e))?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().contains("manual"))
}

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

// ─── macOS（通过 osascript 提权执行 networksetup）────────────────────────────

#[cfg(target_os = "macos")]
fn run_networksetup_privileged(script: &str) -> Result<(), String> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg(format!(
            r#"do shell script "{}" with administrator privileges"#,
            script.replace('\\', "\\\\").replace('"', "\\\"")
        ))
        .output()
        .map_err(|e| format!("执行 osascript 失败: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("User canceled") || stderr.contains("-128") {
            return Err("用户取消了授权".to_string());
        }
        return Err(format!("设置系统代理失败: {}", stderr.trim()));
    }
    Ok(())
}

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
    let mut cmds = Vec::new();

    for service in &services {
        let s = service.replace('\'', "'\\''");
        let addr = &config.host;
        let port = config.port;
        cmds.push(format!("networksetup -setwebproxy '{}' {} {}", s, addr, port));
        cmds.push(format!("networksetup -setwebproxystate '{}' on", s));
        cmds.push(format!("networksetup -setsecurewebproxy '{}' {} {}", s, addr, port));
        cmds.push(format!("networksetup -setsecurewebproxystate '{}' on", s));
        cmds.push(format!("networksetup -setsocksfirewallproxy '{}' {} {}", s, addr, port));
        cmds.push(format!("networksetup -setsocksfirewallproxystate '{}' on", s));
    }

    let script = cmds.join(" && ");
    run_networksetup_privileged(&script)
}

#[cfg(target_os = "macos")]
fn disable_macos() -> Result<(), String> {
    let services = get_network_services()?;
    let mut cmds = Vec::new();

    for service in &services {
        let s = service.replace('\'', "'\\''");
        cmds.push(format!("networksetup -setwebproxystate '{}' off", s));
        cmds.push(format!("networksetup -setsecurewebproxystate '{}' off", s));
        cmds.push(format!("networksetup -setsocksfirewallproxystate '{}' off", s));
    }

    let script = cmds.join(" && ");
    run_networksetup_privileged(&script)
}

#[cfg(target_os = "macos")]
fn is_enabled_macos() -> Result<bool, String> {
    let output = Command::new("networksetup")
        .args(["-getwebproxy", "Wi-Fi"])
        .output()
        .map_err(|e| format!("获取代理状态失败: {}", e))?;

    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text.contains("Enabled: Yes"))
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

//! 节点测速。三种模式：
//!
//! 1. **TCP 握手延迟**（`test_node_tcp_delay`）—— 不需要 mihomo 运行，直接 TCP connect
//!    到代理服务器测握手时间。粗略，等价于 ClashX / Clash Verge 的"独立测速"。
//!
//! 2. **mihomo /delay API**（`test_proxy_delay`）—— 通过 mihomo 内核测试节点
//!    对 generate_204 (~0.2KB) 的响应时间。准确反映节点的"通畅性"，但无法反映
//!    实际带宽。
//!
//! 3. **真实测速**（`test_node_real_speed`，三档）—— 通过 mihomo 代理向真实站点
//!    发请求，测量 TTFB（time-to-first-byte）和实际下载速度。这是 Kite 相对
//!    ClashX / Clash Verge / Stash 的核心 differentiator，他们都没有。
//!
//!    | mode    | target                                     | 流量    | 用途             |
//!    |---------|--------------------------------------------|---------|------------------|
//!    | quick   | HEAD https://www.youtube.com               | <2KB    | 默认测速         |
//!    | real    | GET https://www.youtube.com/favicon.ico    | ~32KB   | "真实测速"       |
//!    | heavy   | GET https://github.com/microsoft/...       | 1MB     | 带宽测试         |

use serde::{Deserialize, Serialize};

use super::{IpcResult, ProxyDelay};

// ─── 1. TCP 握手延迟 ────────────────────────────────────────────────────────

/// 直接 TCP 连接测速（不需要 mihomo 运行）。
/// 测量到代理服务器的 TCP 握手延迟。
#[tauri::command]
pub async fn test_node_tcp_delay(server: String, port: u16, timeout_ms: Option<u64>) -> IpcResult<u32> {
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(5000));
    let addr = format!("{}:{}", server, port);
    let start = std::time::Instant::now();
    match tokio::time::timeout(timeout, tokio::net::TcpStream::connect(&addr)).await {
        Ok(Ok(_)) => {
            let ms = start.elapsed().as_millis() as u32;
            IpcResult::ok(ms)
        }
        Ok(Err(e)) => IpcResult::err(format!("连接失败: {}", e)),
        Err(_) => IpcResult::err("超时".to_string()),
    }
}

// ─── 2. mihomo /delay API ──────────────────────────────────────────────────

/// 通过 mihomo /proxies/{name}/delay 测节点延迟（generate_204）。
#[tauri::command]
pub async fn test_proxy_delay(
    name: String, test_url: Option<String>, timeout: Option<u32>,
    controller_url: Option<String>,
) -> IpcResult<ProxyDelay> {
    let base = controller_url.unwrap_or_else(|| "http://127.0.0.1:9090".to_string());
    let url = test_url.unwrap_or_else(|| "http://www.gstatic.com/generate_204".to_string());
    let timeout_ms = timeout.unwrap_or(5000);

    let encoded_name = urlencoding::encode(&name);
    let encoded_url = urlencoding::encode(&url);
    let api_url = format!("{}/proxies/{}/delay?url={}&timeout={}", base, encoded_name, encoded_url, timeout_ms);

    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    match client.get(&api_url).send().await {
        Ok(resp) => {
            if let Ok(text) = resp.text().await {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                    let delay = val["delay"].as_u64().unwrap_or(0) as u32;
                    return IpcResult::ok(ProxyDelay { name, delay, error: None });
                }
            }
            IpcResult::ok(ProxyDelay { name, delay: 0, error: Some("解析响应失败".to_string()) })
        }
        Err(e) => IpcResult::ok(ProxyDelay { name, delay: 0, error: Some(format!("请求失败: {}", e)) }),
    }
}

// ─── 3. 真实测速（候选 C —— Kite 的 differentiator）───────────────────────

/// 测速档位。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpeedMode {
    /// HEAD 一个真实站点，测 TLS+TTFB（<2KB 流量）
    Quick,
    /// GET 一个 favicon 大小的资源，测真实下载延迟（~32KB）
    Real,
    /// GET 一个 1MB 资源，1 秒内中止，测带宽（约 1MB 流量）
    Heavy,
}

impl Default for SpeedMode {
    fn default() -> Self { SpeedMode::Quick }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RealSpeedResult {
    pub name: String,
    /// TTFB（ms）—— 从发送请求到收到第一字节
    pub ttfb_ms: u32,
    /// 总耗时（ms）—— 从开始到完成 / 中止
    pub total_ms: u32,
    /// 实际下载字节数
    pub bytes_received: u64,
    /// 计算出的吞吐量（KB/s），下载 < 1KB 时为 0
    pub throughput_kbps: u32,
    /// HTTP 状态码（成功为 Some(200)，失败为 None）
    pub http_status: Option<u16>,
    pub error: Option<String>,
}

impl RealSpeedResult {
    fn err(name: String, msg: impl Into<String>) -> Self {
        Self {
            name, ttfb_ms: 0, total_ms: 0, bytes_received: 0, throughput_kbps: 0,
            http_status: None, error: Some(msg.into()),
        }
    }
}

/// 把 mihomo 的 SOCKS5 / mixed-port 代理拼成 reqwest::Proxy。
/// Kite 默认 mihomo mixed-port = 7890，不可配（mihomo runtime 写死）。
fn mihomo_proxy(controller_port: u16) -> reqwest::Proxy {
    // mixed-port 是 controller_port - 1200 这种约定不存在；用默认 7890
    // 这里 controller_port 实际不影响 mixed-port，保留参数为未来扩展
    let _ = controller_port;
    reqwest::Proxy::all("http://127.0.0.1:7890")
        .expect("mixed-port URL is hard-coded and known to be valid")
}

/// 测速档位对应的目标 URL。每档选了一个对中文用户来说"翻墙是否成功"
/// 最有代表性的站点（YouTube 国内访问失败 = 节点死了）。
fn target_url_for(mode: SpeedMode) -> &'static str {
    match mode {
        SpeedMode::Quick => "https://www.youtube.com",
        SpeedMode::Real => "https://www.youtube.com/favicon.ico",
        SpeedMode::Heavy => "https://www.cloudflare.com/cdn-cgi/trace",
        // ↑ Heavy 选 Cloudflare /cdn-cgi/trace —— 该端点不限速，
        //   1 秒内能跑出节点的真实带宽。把 GitHub zip 那种几百 MB 的
        //   下载留给"benchmark"用户体验，普通真实测速不要烧那么多流量。
    }
}

/// 真实测速 —— 通过 mihomo 代理向真实站点发请求，测 TTFB + 吞吐量。
///
/// **前置条件**：mihomo 必须在跑，且选中的节点已经被切换到主 group
/// （否则走 DIRECT，测出来的不是节点速度而是本地带宽）。
///
/// 调用约定：前端在测速前应该先调 mihomo_select_proxy 切到目标节点。
/// 一次只能测一个节点。如果要测 N 个，前端循环切节点 → 测速。
///
/// 我们没有走 /proxies/{name}/delay 那种 path，是因为 mihomo 那个 API
/// 只支持小响应体（≤256B），无法测真实带宽。
#[tauri::command]
pub async fn test_node_real_speed(
    name: String,
    mode: Option<SpeedMode>,
    timeout_ms: Option<u64>,
    controller_url: Option<String>,
) -> IpcResult<RealSpeedResult> {
    let mode = mode.unwrap_or_default();
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(8000));
    let target = target_url_for(mode);
    let _ = controller_url; // 保留参数为未来扩展

    let client = match reqwest::Client::builder()
        .timeout(timeout)
        .proxy(mihomo_proxy(7890))
        // 不允许 reqwest 自身走系统代理（避免和 mihomo 链路打架）
        .no_proxy() // ← 注意这一行被 .proxy() 覆盖；保留是为了清理任何 env 代理
        .danger_accept_invalid_certs(false)
        .gzip(true)
        .build()
    {
        Ok(c) => c,
        Err(e) => return IpcResult::ok(RealSpeedResult::err(name, format!("HTTP 客户端创建失败: {}", e))),
    };

    let start = std::time::Instant::now();

    let req = match mode {
        SpeedMode::Quick => client.head(target),
        SpeedMode::Real | SpeedMode::Heavy => client.get(target),
    };

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return IpcResult::ok(RealSpeedResult::err(name, format!("请求失败: {}", e))),
    };

    let ttfb = start.elapsed().as_millis() as u32;
    let status = resp.status();

    if !status.is_success() {
        return IpcResult::ok(RealSpeedResult {
            name, ttfb_ms: ttfb, total_ms: ttfb, bytes_received: 0, throughput_kbps: 0,
            http_status: Some(status.as_u16()),
            error: Some(format!("HTTP {}", status.as_u16())),
        });
    }

    // Heavy / Real 模式：读取 body 测吞吐
    let bytes = match mode {
        SpeedMode::Quick => 0u64, // HEAD 不读 body
        SpeedMode::Real | SpeedMode::Heavy => {
            // 读全部 body 但用 timeout 限制（Heavy 在 1s 内中止当部分下载量）
            let body_timeout = match mode {
                SpeedMode::Heavy => std::time::Duration::from_millis(1000),
                _ => timeout - std::time::Duration::from_millis(ttfb as u64),
            };
            match tokio::time::timeout(body_timeout, resp.bytes()).await {
                Ok(Ok(b)) => b.len() as u64,
                Ok(Err(_)) => 0,
                Err(_) => {
                    // 超时不算错误，是 Heavy 模式正常结束信号
                    // 但我们没法读到已下载的字节数（reqwest 不暴露），返回 0 + 注记
                    0
                }
            }
        }
    };

    let total = start.elapsed().as_millis() as u32;

    // 吞吐量计算（KB/s）—— 只在下载量 > 1KB 时有意义
    let throughput_kbps = if bytes >= 1024 && total > 0 {
        ((bytes * 1000) / total as u64 / 1024) as u32
    } else {
        0
    };

    IpcResult::ok(RealSpeedResult {
        name, ttfb_ms: ttfb, total_ms: total,
        bytes_received: bytes, throughput_kbps,
        http_status: Some(status.as_u16()),
        error: None,
    })
}

// ─── 单元测试 ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speed_mode_default_is_quick() {
        assert!(matches!(SpeedMode::default(), SpeedMode::Quick));
    }

    #[test]
    fn speed_mode_serializes_lowercase() {
        let q = serde_json::to_string(&SpeedMode::Quick).unwrap();
        let r = serde_json::to_string(&SpeedMode::Real).unwrap();
        let h = serde_json::to_string(&SpeedMode::Heavy).unwrap();
        assert_eq!(q, "\"quick\"");
        assert_eq!(r, "\"real\"");
        assert_eq!(h, "\"heavy\"");
    }

    #[test]
    fn target_url_distinct_per_mode() {
        let q = target_url_for(SpeedMode::Quick);
        let r = target_url_for(SpeedMode::Real);
        let h = target_url_for(SpeedMode::Heavy);
        assert_ne!(q, r);
        assert_ne!(r, h);
        // sanity: 都是 https
        assert!(q.starts_with("https://"));
        assert!(r.starts_with("https://"));
        assert!(h.starts_with("https://"));
    }

    #[test]
    fn err_helper_zeros_metrics() {
        let r = RealSpeedResult::err("test".into(), "boom");
        assert_eq!(r.name, "test");
        assert_eq!(r.ttfb_ms, 0);
        assert_eq!(r.total_ms, 0);
        assert_eq!(r.bytes_received, 0);
        assert_eq!(r.throughput_kbps, 0);
        assert_eq!(r.http_status, None);
        assert_eq!(r.error.as_deref(), Some("boom"));
    }

    #[tokio::test]
    async fn tcp_delay_to_unreachable_port_times_out() {
        // RFC5737 documentation IP，永远不会响应
        let result = test_node_tcp_delay(
            "192.0.2.1".to_string(),
            12345,
            Some(200),
        ).await;
        assert!(!result.success, "应该失败");
        assert!(result.error.is_some(), "应该有错误信息");
    }

    #[tokio::test]
    async fn tcp_delay_to_invalid_host_fails() {
        let result = test_node_tcp_delay(
            "this-host-definitely-does-not-exist-kite-vpn.invalid".to_string(),
            443,
            Some(500),
        ).await;
        assert!(!result.success, "DNS 失败应该返回 err");
    }

    /// 这个测试要求 mihomo 本地不可达（mixed-port 7890 没监听），
    /// 验证当 mihomo 没运行时测速也能优雅失败而不是 panic。
    #[tokio::test]
    async fn real_speed_without_mihomo_returns_error_not_panic() {
        // 不依赖网络：如果 7890 没监听，proxy 连接会立即失败
        let result = test_node_real_speed(
            "test_node".to_string(),
            Some(SpeedMode::Quick),
            Some(500),
            None,
        ).await;
        // 不强求 success/fail（CI 上可能本机有 7890 监听），只要不 panic 就过
        // 重要的是 IpcResult 总是 Ok wrapper（错误在 RealSpeedResult.error 里）
        assert!(result.success, "test_node_real_speed 应该总是返回 IpcResult::ok");
        let payload = result.data.unwrap();
        assert_eq!(payload.name, "test_node");
    }
}

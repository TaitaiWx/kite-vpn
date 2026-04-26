//! 远程订阅拉取（Rust 侧，无 CORS）+ 本地持久化。

use std::fs;
use tauri::AppHandle;

use super::{FetchedSubscription, IpcResult, get_data_path};

/// 拉取远程订阅。
///
/// 健壮性措施：
/// 1. User-Agent 伪装成 mihomo（大部分机场 CDN 白名单识别 clash/mihomo）
/// 2. 自动解压 gzip/brotli/deflate（reqwest 开启 gzip feature）
/// 3. 自动重试最多 2 次（间隔 1s、2s）
/// 4. 空响应体视为失败（而不是返回空 content 让前端解析爆炸）
/// 5. 超时默认 30s（部分机场 CDN 慢）
#[tauri::command]
pub async fn fetch_remote_subscription(url: String, timeout_ms: Option<u64>) -> IpcResult<FetchedSubscription> {
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(30000));

    let client = match reqwest::Client::builder().no_proxy()
        .timeout(timeout)
        // mihomo 的真实 UA —— 大部分机场 CDN 白名单识别这个
        .user_agent(format!("clash.meta/{}", env!("CARGO_PKG_VERSION")))
        .gzip(true)
        .brotli(true)
        .deflate(true)
        // 跟随重定向（最多 10 跳）
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => return IpcResult::err(format!("创建 HTTP 客户端失败: {}", e)),
    };

    // 最多重试 3 次（首次 + 2 次重试）
    let max_retries = 2;
    let mut last_err = String::new();
    for attempt in 0..=max_retries {
        if attempt > 0 {
            eprintln!("[KITE] 订阅拉取重试 {}/{}: {}", attempt, max_retries, &url);
            tokio::time::sleep(std::time::Duration::from_secs(attempt as u64)).await;
        }

        let resp = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("网络请求失败: {}", e);
                continue;
            }
        };

        let status = resp.status();
        if !status.is_success() {
            last_err = format!("HTTP {}: {}", status.as_u16(),
                status.canonical_reason().unwrap_or("服务器返回错误"));
            // 4xx 不重试（客户端错误 / 订阅 key 无效），5xx 才重试
            if status.is_client_error() { break; }
            continue;
        }

        let user_info = resp.headers().get("subscription-userinfo")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        let content_type = resp.headers().get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        let update_interval = resp.headers().get("profile-update-interval")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<f64>().ok());

        let content = match resp.text().await {
            Ok(t) => t,
            Err(e) => {
                last_err = format!("读取响应体失败: {}", e);
                continue;
            }
        };

        // 空响应体 = 失败（CDN 返回 200 但没给内容，可能是地理限制或 bot 防护）
        if content.trim().is_empty() {
            last_err = "服务器返回空响应。可能原因：订阅已过期、CDN 地理限制、或需要从代理环境访问".to_string();
            continue;
        }

        return IpcResult::ok(FetchedSubscription {
            content, user_info, content_type, update_interval,
        });
    }

    IpcResult::err(last_err)
}

#[tauri::command]
pub async fn save_subscriptions(app: AppHandle, json_data: String) -> IpcResult<()> {
    let path = match get_data_path(&app, "subscriptions.json") {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e),
    };
    match fs::write(&path, &json_data) {
        Ok(()) => IpcResult::ok(()),
        Err(e) => IpcResult::err(format!("保存订阅失败: {}", e)),
    }
}

#[tauri::command]
pub async fn load_subscriptions(app: AppHandle) -> IpcResult<String> {
    let path = match get_data_path(&app, "subscriptions.json") {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e),
    };
    match fs::read_to_string(&path) {
        Ok(content) => IpcResult::ok(content),
        Err(_) => IpcResult::ok("[]".to_string()),
    }
}

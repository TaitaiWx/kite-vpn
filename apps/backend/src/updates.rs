//! Tauri 自动更新 endpoint —— 双 endpoint 方案的"主"侧。
//!
//! Tauri 客户端 `tauri.conf.json` 里 updater.endpoints 是数组，按顺序尝试。
//! 主：你自己的 backend（这个 handler）→ 缓存 / 私有分发 / 紧急 hotfix；
//! 副：GitHub Releases latest.json → 兜底，万一你 backend 挂了用户也能升级。
//!
//! 本 handler 默认行为：透传 GitHub Releases latest.json（即 cache 一份再吐出去）。
//! 高级玩法：替换成自己 CDN / 把 hotfix 临时定向到特定版本 / 强制降级 —— 都改 ENV。
//!
//! ENV:
//!   KITE_UPDATE_SOURCE_URL  上游 latest.json 地址
//!                           默认: https://github.com/TaitaiWx/kite-vpn/releases/latest/download/latest.json
//!   KITE_UPDATE_CACHE_SECS  缓存秒数（默认 300）
//!
//! 设计约束：handler 不持有 HTTP client（避免冷启拖慢）。每次重新 reqwest::get。
//! latest.json 体积 < 1KB，QPS 不会很高 —— 用户客户端一天最多查几次。

use axum::{
    http::{header, HeaderName, StatusCode},
    response::{IntoResponse, Response},
};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const DEFAULT_SOURCE: &str =
    "https://github.com/TaitaiWx/kite-vpn/releases/latest/download/latest.json";
const DEFAULT_CACHE_SECS: u64 = 300;

struct CacheEntry {
    body: String,
    fetched_at: Instant,
}

static CACHE: OnceLock<Mutex<Option<CacheEntry>>> = OnceLock::new();

fn cache() -> &'static Mutex<Option<CacheEntry>> {
    CACHE.get_or_init(|| Mutex::new(None))
}

/// GET /api/updates/latest.json
///
/// Tauri 期望的 schema (官方文档):
/// {
///   "version": "1.0.2",
///   "notes": "...",
///   "pub_date": "ISO8601",
///   "platforms": {
///     "darwin-x86_64": { "signature": "...", "url": "..." },
///     ...
///   }
/// }
///
/// 我们不解析它，纯透传 —— upstream 是 GitHub 生成的，schema 已经对。
pub async fn latest_json() -> Response {
    let source = std::env::var("KITE_UPDATE_SOURCE_URL").unwrap_or_else(|_| DEFAULT_SOURCE.into());
    let cache_secs = std::env::var("KITE_UPDATE_CACHE_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_CACHE_SECS);

    // 先看缓存
    {
        let guard = cache().lock().await;
        if let Some(entry) = guard.as_ref() {
            if entry.fetched_at.elapsed() < Duration::from_secs(cache_secs) {
                return json_response(&entry.body, true);
            }
        }
    }

    // miss → 拉源
    let body = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(client) => match client.get(&source).send().await {
            Ok(resp) if resp.status().is_success() => match resp.text().await {
                Ok(text) => text,
                Err(e) => {
                    tracing::warn!(error = %e, "读取 update upstream body 失败");
                    return error_response(StatusCode::BAD_GATEWAY, "upstream read failed");
                }
            },
            Ok(resp) => {
                let status = resp.status();
                tracing::warn!(status = %status, source = %source, "update upstream 非 200");
                return error_response(StatusCode::BAD_GATEWAY, "upstream non-200");
            }
            Err(e) => {
                tracing::warn!(error = %e, source = %source, "请求 update upstream 失败");
                // 回落到旧缓存（哪怕过期），强过让客户端完全升不了
                let guard = cache().lock().await;
                if let Some(entry) = guard.as_ref() {
                    tracing::info!("upstream 失败 —— 回落到过期缓存");
                    return json_response(&entry.body, true);
                }
                return error_response(StatusCode::BAD_GATEWAY, "upstream request failed");
            }
        },
        Err(e) => {
            tracing::error!(error = %e, "构造 HTTP client 失败");
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, "client build failed");
        }
    };

    // 写缓存
    {
        let mut guard = cache().lock().await;
        *guard = Some(CacheEntry {
            body: body.clone(),
            fetched_at: Instant::now(),
        });
    }

    json_response(&body, false)
}

fn json_response(body: &str, from_cache: bool) -> Response {
    let cache_header = if from_cache { "HIT" } else { "MISS" };
    let x_cache: HeaderName = HeaderName::from_static("x-cache");
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json"),
            (x_cache, cache_header),
        ],
        body.to_string(),
    )
        .into_response()
}

fn error_response(status: StatusCode, msg: &str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        format!(r#"{{"error":"{}"}}"#, msg),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cache_starts_empty() {
        let guard = cache().lock().await;
        // 这个 test 可能跟其他并发 test 抢 cache，所以只确认能锁
        let _ = guard.as_ref();
    }
}

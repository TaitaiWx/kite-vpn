//! In-process rate limit middleware（tower-governor）。
//!
//! 主要防御目标：
//! - magic-link 邮件滥发：单 IP 5 r/min（key 由 governor 配置自动用 client IP）
//! - bridge webhook 暴力：单 IP 30 r/min（accept bridge token 太长，靠 ratelimit + token 长度兜底）
//!
//! 注意：tower_governor 默认按 IP key，需要 axum 拿到客户端 IP。
//! K8s 部署在 ingress-nginx 后面，需要 ingress 配置 X-Forwarded-For 透传，
//! 然后 axum 通过 `ConnectInfo` 拿到。这里用 governor 的 SmartIpKeyExtractor
//! 自动从 X-Forwarded-For 取（fallback 到 socket addr）。

use std::sync::Arc;
use std::time::Duration;

use axum::{body::Body, http::Request, middleware::Next, response::Response};
use tower_governor::{
    governor::GovernorConfigBuilder, key_extractor::SmartIpKeyExtractor, GovernorLayer,
};

/// 严格档：5 r/min/ip —— 给 /api/auth/request-login 用
pub fn strict_layer() -> GovernorLayer<SmartIpKeyExtractor, governor::middleware::NoOpMiddleware> {
    let conf = Arc::new(
        GovernorConfigBuilder::default()
            .per_second(12) // 12s 攒一个 token
            .burst_size(5)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .expect("strict ratelimit config"),
    );
    GovernorLayer { config: conf }
}

/// 宽松档：30 r/min/ip —— 给一般 API 用
pub fn relaxed_layer() -> GovernorLayer<SmartIpKeyExtractor, governor::middleware::NoOpMiddleware> {
    let conf = Arc::new(
        GovernorConfigBuilder::default()
            .per_second(2)
            .burst_size(30)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .expect("relaxed ratelimit config"),
    );
    GovernorLayer { config: conf }
}

/// （可选）超严格档：1 r/min —— 给 webhook 调试 / dangerous admin op 用
pub fn paranoid_layer() -> GovernorLayer<SmartIpKeyExtractor, governor::middleware::NoOpMiddleware> {
    let conf = Arc::new(
        GovernorConfigBuilder::default()
            .per_second(60)
            .burst_size(1)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .expect("paranoid ratelimit config"),
    );
    GovernorLayer { config: conf }
}

/// noop middleware: 用于 dev / test 关闭 ratelimit
pub async fn passthrough(req: Request<Body>, next: Next) -> Response {
    let _ = Duration::from_millis(0);
    next.run(req).await
}

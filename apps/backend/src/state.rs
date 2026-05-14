//! 全局 app state，通过 axum 的 State extractor 注入各 handler。

use std::sync::Arc;

use crate::{db::Db, mailer::SharedMailer};

#[derive(Clone)]
pub struct AppConfig {
    /// 服务自身公网 URL（拼 magic link 用），例: https://kite.example.com
    pub public_url: String,
    /// magic link 验证后跳转到哪里（前端首页）
    pub frontend_redirect_url: String,
    /// HTTPS 部署时为 true，本地 dev 为 false
    pub cookie_secure: bool,
}

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub mailer: SharedMailer,
    pub config: Arc<AppConfig>,
}

impl AppState {
    pub fn new(db: Db, mailer: SharedMailer, config: AppConfig) -> Self {
        Self {
            db,
            mailer,
            config: Arc::new(config),
        }
    }
}

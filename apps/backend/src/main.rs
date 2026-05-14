//! Kite Backend entry —— axum HTTP server。
//!
//! ENV:
//!   KITE_DATABASE_URL          sqlite:./kite.db （默认）
//!   KITE_BIND                  127.0.0.1:8787 （默认）
//!   KITE_PUBLIC_URL            http://localhost:8787 （默认，prod 必须 HTTPS）
//!   KITE_FRONTEND_REDIRECT_URL http://localhost:1420 （magic link 验证后跳哪）
//!   KITE_COOKIE_SECURE         false （HTTPS 部署设 true）
//!   KITE_MAILER                stdout | smtp （默认 stdout，dev 时用）
//!   KITE_SMTP_HOST / PORT / USER / PASS / FROM_EMAIL / FROM_NAME

use std::sync::Arc;

use kite_backend::{
    build_router, db,
    mailer::{SharedMailer, SmtpConfig, SmtpMailer, StdoutMailer},
    state::{AppConfig, AppState},
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // 加载 .env（如果存在）
    let _ = dotenvy::dotenv();

    // 初始化 tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,kite_backend=debug,tower_http=debug".into()),
        )
        .with_target(false)
        .compact()
        .init();

    let database_url = std::env::var("KITE_DATABASE_URL").unwrap_or_else(|_| "sqlite:./kite.db".into());
    let bind = std::env::var("KITE_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let public_url = std::env::var("KITE_PUBLIC_URL").unwrap_or_else(|_| format!("http://{}", bind));
    let frontend_redirect_url =
        std::env::var("KITE_FRONTEND_REDIRECT_URL").unwrap_or_else(|_| "http://localhost:1420".into());
    let cookie_secure = std::env::var("KITE_COOKIE_SECURE")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false);

    let db = db::connect(&database_url).await?;
    let mailer: SharedMailer = build_mailer()?;

    let config = AppConfig {
        public_url,
        frontend_redirect_url,
        cookie_secure,
    };

    let state = AppState::new(db, mailer, config);
    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(addr = %bind, "kite-backend listening");
    axum::serve(listener, app).await?;
    Ok(())
}

fn build_mailer() -> Result<SharedMailer, Box<dyn std::error::Error + Send + Sync>> {
    let kind = std::env::var("KITE_MAILER").unwrap_or_else(|_| "stdout".into());
    match kind.as_str() {
        "stdout" => Ok(Arc::new(StdoutMailer)),
        "smtp" => {
            let config = SmtpConfig {
                host: std::env::var("KITE_SMTP_HOST")?,
                port: std::env::var("KITE_SMTP_PORT")
                    .unwrap_or_else(|_| "587".into())
                    .parse()?,
                username: std::env::var("KITE_SMTP_USER")?,
                password: std::env::var("KITE_SMTP_PASS")?,
                from_address: std::env::var("KITE_SMTP_FROM_EMAIL")?,
                from_name: std::env::var("KITE_SMTP_FROM_NAME").unwrap_or_else(|_| "Kite".into()),
            };
            Ok(Arc::new(SmtpMailer::new(config)))
        }
        other => Err(format!("未知 KITE_MAILER 类型: {}（应为 stdout / smtp）", other).into()),
    }
}

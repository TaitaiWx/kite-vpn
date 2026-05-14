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
    admin, build_router, db,
    mailer::{SharedMailer, SmtpConfig, SmtpMailer, StdoutMailer},
    nebula::NebulaSupervisor,
    state::{AppConfig, AppState},
    updates,
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

    // 启动时一次性任务：管理员 seed + update signing key 预热
    admin::seed_admin_from_env(&db).await?;
    let _ = updates::load_or_create_signing_key(&db).await?;

    let mailer: SharedMailer = build_mailer()?;

    let config = AppConfig {
        public_url,
        frontend_redirect_url,
        cookie_secure,
    };

    let state = AppState::new(db, mailer, config);
    let app = build_router(state);

    // Nebula lighthouse 子进程 —— 如果 ENV 配了就拉起来，做"一个 systemd service 两件事"。
    // 不配就跳过（dev / 纯后端模式）。
    let mut nebula = NebulaSupervisor::maybe_spawn_from_env()
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(addr = %bind, "kite-backend listening");

    // 同时 await axum 和 nebula。任意一个挂掉就整体退出 →
    // systemd / Docker 重启拉起来（健康自愈）。
    let server = axum::serve(listener, app);
    match nebula.as_mut() {
        Some(nb) => {
            tokio::select! {
                r = server => {
                    r?;
                }
                exit = nb.wait_exit() => {
                    tracing::error!(?exit, "nebula 子进程退出，kite-backend 跟着退");
                }
            }
        }
        None => {
            server.await?;
        }
    }
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

//! 邮件发送 —— trait + 两种实现（stdout dev + SMTP prod）。

use std::sync::Arc;
use async_trait::async_trait;

use crate::error::{AppError, AppResult};

#[async_trait]
pub trait Mailer: Send + Sync {
    /// 发送 magic link 邮件。`link` 完整 URL，例: https://kite.example.com/auth/verify?token=xyz
    async fn send_magic_link(&self, to_email: &str, link: &str) -> AppResult<()>;
}

pub type SharedMailer = Arc<dyn Mailer>;

// ─── Dev impl: 打印到 stdout，不实际发邮件 ─────────────────────────────────

pub struct StdoutMailer;

#[async_trait]
impl Mailer for StdoutMailer {
    async fn send_magic_link(&self, to_email: &str, link: &str) -> AppResult<()> {
        tracing::info!(
            recipient = %to_email,
            link = %link,
            "[DEV-MAILER] would send magic link"
        );
        // 同时打到 stderr，方便 dev 时直接复制
        eprintln!("\n📧 Magic link for {} →\n   {}\n", to_email, link);
        Ok(())
    }
}

// ─── Prod impl: SMTP（lettre） ──────────────────────────────────────────

#[derive(Clone)]
pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub from_address: String,
    pub from_name: String,
}

pub struct SmtpMailer {
    config: SmtpConfig,
}

impl SmtpMailer {
    pub fn new(config: SmtpConfig) -> Self {
        Self { config }
    }
}

#[async_trait]
impl Mailer for SmtpMailer {
    async fn send_magic_link(&self, to_email: &str, link: &str) -> AppResult<()> {
        use lettre::{
            transport::smtp::{authentication::Credentials, AsyncSmtpTransport},
            AsyncTransport, Message, Tokio1Executor,
        };

        let from = format!("{} <{}>", self.config.from_name, self.config.from_address);
        let email = Message::builder()
            .from(from.parse().map_err(|e| AppError::Mailer(format!("from parse: {}", e)))?)
            .to(to_email.parse().map_err(|e| AppError::Mailer(format!("to parse: {}", e)))?)
            .subject("Kite 登录链接")
            .body(format!(
                "点击下方链接登录 Kite（10 分钟内有效，单次使用）:\n\n{}\n\n如果你没有发起这次登录，请忽略此邮件。\n",
                link
            ))
            .map_err(|e| AppError::Mailer(format!("build: {}", e)))?;

        let creds = Credentials::new(self.config.username.clone(), self.config.password.clone());

        let mailer: AsyncSmtpTransport<Tokio1Executor> =
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&self.config.host)
                .map_err(|e| AppError::Mailer(format!("smtp transport: {}", e)))?
                .port(self.config.port)
                .credentials(creds)
                .build();

        mailer
            .send(email)
            .await
            .map_err(|e| AppError::Mailer(format!("send: {}", e)))?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stdout_mailer_does_not_error() {
        let m = StdoutMailer;
        m.send_magic_link("test@example.com", "http://localhost:8080/auth/verify?token=abc")
            .await
            .expect("stdout mailer never fails");
    }
}

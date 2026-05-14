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
            message::{header::ContentType, MultiPart, SinglePart},
            transport::smtp::{authentication::Credentials, AsyncSmtpTransport},
            AsyncTransport, Message, Tokio1Executor,
        };

        let from = format!("{} <{}>", self.config.from_name, self.config.from_address);
        let (plain, html) = render_magic_link_body(link);

        let email = Message::builder()
            .from(from.parse().map_err(|e| AppError::Mailer(format!("from parse: {}", e)))?)
            .to(to_email.parse().map_err(|e| AppError::Mailer(format!("to parse: {}", e)))?)
            .subject("Kite 登录链接")
            .multipart(
                MultiPart::alternative()
                    .singlepart(SinglePart::builder().header(ContentType::TEXT_PLAIN).body(plain))
                    .singlepart(SinglePart::builder().header(ContentType::TEXT_HTML).body(html)),
            )
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

/// 渲染 magic-link 邮件正文（plain + html）。HTML 用 inline style，
/// 避开 Gmail / Outlook 各种过滤器。
fn render_magic_link_body(link: &str) -> (String, String) {
    let plain = format!(
        "点击下方链接登录 Kite（10 分钟内有效，单次使用）:\n\n{}\n\n如果你没有发起这次登录，请忽略此邮件。\n",
        link
    );

    let safe_link = html_escape(link);
    let html = format!(
        r#"<!doctype html>
<html><body style="margin:0;padding:24px;background:#0a0a0a;color:#e5e5e5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#171717;border:1px solid #262626;border-radius:12px;padding:32px;">
    <h2 style="margin:0 0 16px 0;color:#fafafa;font-size:20px;font-weight:600;">Kite 登录</h2>
    <p style="margin:0 0 24px 0;color:#a3a3a3;font-size:14px;line-height:1.6;">
      点击下方按钮登录 —— 10 分钟内有效，单次使用。
    </p>
    <p style="margin:0 0 24px 0;">
      <a href="{safe_link}" style="display:inline-block;background:#3b82f6;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:500;">
        登录 Kite
      </a>
    </p>
    <p style="margin:0 0 8px 0;color:#737373;font-size:12px;">链接无法点击？直接复制：</p>
    <p style="margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#525252;word-break:break-all;">
      {safe_link}
    </p>
    <hr style="border:none;border-top:1px solid #262626;margin:24px 0;">
    <p style="margin:0;color:#525252;font-size:11px;line-height:1.5;">
      没有发起这次登录？忽略即可 —— Kite 不存密码、不发任何敏感数据，无密码登录失败也不会泄露你的账户存在。
    </p>
  </div>
</body></html>"#,
        safe_link = safe_link
    );

    (plain, html)
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
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

    #[test]
    fn html_escape_handles_specials() {
        assert_eq!(html_escape("a&b<c>d\"e'f"), "a&amp;b&lt;c&gt;d&quot;e&#39;f");
    }

    #[test]
    fn render_magic_link_includes_link_in_both_parts() {
        let (plain, html) = render_magic_link_body("https://k.example.com/auth/verify?token=ABC");
        assert!(plain.contains("https://k.example.com/auth/verify?token=ABC"));
        assert!(html.contains("https://k.example.com/auth/verify?token=ABC"));
        assert!(html.contains("Kite 登录"));
    }

    #[test]
    fn render_magic_link_escapes_dangerous_chars_in_link() {
        let (_, html) = render_magic_link_body("https://x.com/?a=<script>");
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;"));
    }
}

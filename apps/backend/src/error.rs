//! 统一错误类型，自动转 HTTP 响应。

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("数据库错误: {0}")]
    Db(#[from] sqlx::Error),

    #[error("迁移错误: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),

    #[error("未授权")]
    Unauthorized,

    #[error("无权访问")]
    Forbidden,

    #[error("资源不存在")]
    NotFound,

    #[error("参数错误: {0}")]
    BadRequest(String),

    #[error("Magic link 已过期或不存在")]
    InvalidMagicLink,

    #[error("Session 已过期")]
    SessionExpired,

    #[error("邮件发送失败: {0}")]
    Mailer(String),

    #[error("内部错误: {0}")]
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            AppError::Unauthorized | AppError::SessionExpired => (StatusCode::UNAUTHORIZED, "unauthorized"),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            AppError::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            AppError::InvalidMagicLink => (StatusCode::UNAUTHORIZED, "invalid_magic_link"),
            AppError::Db(_) | AppError::Migrate(_) | AppError::Internal(_) | AppError::Mailer(_) => {
                tracing::error!(error = ?self, "internal error");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal")
            }
        };

        let body = Json(json!({
            "error": {
                "code": code,
                "message": self.to_string(),
            }
        }));
        (status, body).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;

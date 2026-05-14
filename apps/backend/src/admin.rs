//! Admin 体系 —— 初始管理员 seed + admin 中间件。
//!
//! 设计：
//! - 启动时如果 `KITE_ADMIN_EMAIL` 设了，upsert 该用户并标记 is_admin=1
//! - admin 用户登录方式跟普通用户一样（magic link），不存"密码"
//! - admin 唯一特权：调 admin-only 路由（未来：列用户、强制注销、看 audit log）

use chrono::Utc;
use sqlx::Row;
use uuid::Uuid;

use crate::{
    auth::AuthUser,
    db::Db,
    error::{AppError, AppResult},
    state::AppState,
};

/// 启动时调用：如果 ENV 配了 admin 邮箱，把它种到 DB（已存在就标记 is_admin）。
pub async fn seed_admin_from_env(db: &Db) -> AppResult<()> {
    let Ok(email) = std::env::var("KITE_ADMIN_EMAIL") else {
        tracing::info!("KITE_ADMIN_EMAIL 未设置 —— 跳过 admin seed");
        return Ok(());
    };
    seed_admin(db, &email).await
}

/// 纯函数：把指定邮箱种为 admin。便于测试（不依赖 process-wide env var）。
pub async fn seed_admin(db: &Db, email: &str) -> AppResult<()> {
    let email = email.trim().to_lowercase();
    if email.is_empty() || !email.contains('@') {
        return Err(AppError::Internal(format!(
            "admin email 非法: {:?}",
            email
        )));
    }

    let now = Utc::now().timestamp_millis();
    let existing: Option<(String,)> = sqlx::query_as("SELECT id FROM users WHERE email = ?")
        .bind(&email)
        .fetch_optional(db)
        .await?;

    match existing {
        Some((id,)) => {
            sqlx::query("UPDATE users SET is_admin = 1, updated_at = ? WHERE id = ?")
                .bind(now)
                .bind(&id)
                .execute(db)
                .await?;
            tracing::info!(admin_email = %email, user_id = %id, "已存在用户提升为 admin");
        }
        None => {
            let id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO users (id, email, is_admin, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
            )
            .bind(&id)
            .bind(&email)
            .bind(now)
            .bind(now)
            .execute(db)
            .await?;
            tracing::info!(admin_email = %email, user_id = %id, "已创建初始 admin 用户");
        }
    }
    Ok(())
}

/// 校验 user 是否 admin。非 admin 返回 Forbidden。
pub async fn require_admin(state: &AppState, user: &AuthUser) -> AppResult<()> {
    let row = sqlx::query("SELECT is_admin FROM users WHERE id = ?")
        .bind(&user.user_id)
        .fetch_optional(&state.db)
        .await?;
    let is_admin: i64 = row
        .ok_or(AppError::Unauthorized)?
        .get::<i64, _>("is_admin");
    if is_admin == 0 {
        return Err(AppError::Forbidden);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connect;

    #[tokio::test]
    async fn seed_creates_new_admin() {
        let db = connect("sqlite::memory:").await.unwrap();
        seed_admin(&db, "admin@example.com").await.unwrap();
        let row: (i64,) =
            sqlx::query_as("SELECT is_admin FROM users WHERE email = 'admin@example.com'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(row.0, 1);
    }

    #[tokio::test]
    async fn seed_promotes_existing_user() {
        let db = connect("sqlite::memory:").await.unwrap();
        let now = Utc::now().timestamp_millis();
        sqlx::query("INSERT INTO users (id, email, is_admin, created_at, updated_at) VALUES (?, ?, 0, ?, ?)")
            .bind("user-existing")
            .bind("existing@example.com")
            .bind(now)
            .bind(now)
            .execute(&db)
            .await
            .unwrap();
        seed_admin(&db, "existing@example.com").await.unwrap();
        let row: (i64,) =
            sqlx::query_as("SELECT is_admin FROM users WHERE email = 'existing@example.com'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(row.0, 1);
    }

    #[tokio::test]
    async fn seed_rejects_garbage_email() {
        let db = connect("sqlite::memory:").await.unwrap();
        assert!(seed_admin(&db, "not-an-email").await.is_err());
        assert!(seed_admin(&db, "").await.is_err());
        assert!(seed_admin(&db, "  ").await.is_err());
    }

    #[tokio::test]
    async fn seed_is_idempotent() {
        let db = connect("sqlite::memory:").await.unwrap();
        seed_admin(&db, "admin@example.com").await.unwrap();
        seed_admin(&db, "admin@example.com").await.unwrap();
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM users WHERE email = 'admin@example.com'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(count, 1);
    }
}

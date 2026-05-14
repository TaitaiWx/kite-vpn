//! SQLite 连接池 + 迁移。
//!
//! 单文件 DB，跟 lighthouse 同款"一键部署"哲学。生产环境 backup =
//! systemd timer + sqlite3 .backup 命令。

use sqlx::sqlite::{SqlitePool, SqlitePoolOptions, SqliteConnectOptions};
use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use crate::error::AppResult;

pub type Db = SqlitePool;

/// 初始化 SQLite 连接池 + 跑 migrations。
///
/// `database_url` 形如:
///   - `sqlite:./kite.db`          生产
///   - `sqlite::memory:`           测试
///   - `sqlite:/tmp/kite-test.db`  集成测试
pub async fn connect(database_url: &str) -> AppResult<Db> {
    tracing::info!(url = %database_url, "connecting to database");

    let opts = SqliteConnectOptions::from_str(database_url)
        .map_err(|e| crate::error::AppError::Internal(format!("invalid database_url: {}", e)))?
        // 关键 PRAGMA — Litestream-friendly + 性能
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5))
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(16)
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(opts)
        .await?;

    // 运行 migrations
    sqlx::migrate!("./migrations").run(&pool).await?;

    tracing::info!("database ready");
    Ok(pool)
}

/// 获取数据库文件大小（监控用，未挂在路由上）。
pub async fn file_size(database_url: &str) -> Option<u64> {
    // sqlite::memory: / sqlite::memory? 都返回 0
    if database_url.contains(":memory:") {
        return Some(0);
    }
    let path_str = database_url
        .strip_prefix("sqlite:")
        .unwrap_or(database_url);
    std::fs::metadata(Path::new(path_str)).ok().map(|m| m.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn in_memory_db_initializes() {
        let pool = connect("sqlite::memory:").await.expect("connect ok");
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
            .fetch_one(&pool)
            .await
            .expect("users table queryable");
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn migrations_create_all_tables() {
        let pool = connect("sqlite::memory:").await.unwrap();
        let tables: Vec<(String,)> = sqlx::query_as("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .fetch_all(&pool)
            .await
            .unwrap();
        let names: Vec<&str> = tables.iter().map(|t| t.0.as_str()).collect();
        assert!(names.contains(&"users"));
        assert!(names.contains(&"sessions"));
        assert!(names.contains(&"magic_links"));
        assert!(names.contains(&"backups"));
        assert!(names.contains(&"public_invites"));
        assert!(names.contains(&"cross_mesh_bridges"));
    }
}

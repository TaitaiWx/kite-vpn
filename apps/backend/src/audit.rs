//! Audit log helper —— 每个敏感操作都调一下 `record()` 写一行。
//!
//! 设计：写 audit log 是 best-effort，不能阻断业务路径。所以这里返回 ()。
//! 失败只 tracing::warn，不返回 Err 给上层 handler。

use chrono::Utc;
use serde::Serialize;
use uuid::Uuid;

use crate::db::Db;

#[derive(Debug, Clone)]
pub struct AuditEvent<'a> {
    pub actor_user_id: Option<&'a str>,
    pub actor_email: &'a str,
    pub actor_ip: &'a str,
    pub event_type: &'a str,
    pub target_kind: &'a str,
    pub target_id: &'a str,
}

pub async fn record(db: &Db, event: AuditEvent<'_>) {
    record_with_metadata(db, event, serde_json::json!({})).await;
}

pub async fn record_with_metadata<T: Serialize>(
    db: &Db,
    event: AuditEvent<'_>,
    metadata: T,
) {
    let now = Utc::now().timestamp_millis();
    let id = Uuid::new_v4().to_string();
    let metadata_json =
        serde_json::to_string(&metadata).unwrap_or_else(|_| "{}".to_string());

    let result = sqlx::query(
        r#"
        INSERT INTO audit_log
            (id, actor_user_id, actor_email, actor_ip, event_type,
             target_kind, target_id, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(event.actor_user_id)
    .bind(event.actor_email)
    .bind(event.actor_ip)
    .bind(event.event_type)
    .bind(event.target_kind)
    .bind(event.target_id)
    .bind(&metadata_json)
    .bind(now)
    .execute(db)
    .await;

    if let Err(e) = result {
        tracing::warn!(error = ?e, event = event.event_type, "写 audit log 失败（不阻断业务）");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connect;

    #[tokio::test]
    async fn record_inserts_row() {
        let db = connect("sqlite::memory:").await.unwrap();
        record(
            &db,
            AuditEvent {
                actor_user_id: None,
                actor_email: "test@example.com",
                actor_ip: "127.0.0.1",
                event_type: "auth.login",
                target_kind: "user",
                target_id: "u-123",
            },
        )
        .await;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn record_with_metadata_stores_json() {
        let db = connect("sqlite::memory:").await.unwrap();
        record_with_metadata(
            &db,
            AuditEvent {
                actor_user_id: None,
                actor_email: "",
                actor_ip: "1.2.3.4",
                event_type: "invite.create",
                target_kind: "invite",
                target_id: "slug-ABC",
            },
            serde_json::json!({"peer_name": "laptop"}),
        )
        .await;
        let row: (String,) =
            sqlx::query_as("SELECT metadata_json FROM audit_log WHERE event_type = 'invite.create'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(row.0.contains("laptop"));
    }
}

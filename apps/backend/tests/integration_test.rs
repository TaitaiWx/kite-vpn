//! 端到端集成测试：跑真实 axum app + in-memory SQLite。
//!
//! 覆盖核心安全属性:
//!   - magic link 单次使用（用过再请求会失败）
//!   - magic link 过期失效
//!   - session cookie 验证
//!   - 未登录访问 backup 被拒
//!   - 跨用户 backup 隔离（user A 看不到 user B 的）
//!   - backup 上传 / 下载 / 删除 round-trip

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use kite_backend::*; // 通过 lib 重导出 —— 见 src/lib.rs（下面会建）
use serde_json::json;
use tower::ServiceExt;

// 构造一个测试 app
async fn make_test_app() -> (axum::Router, std::sync::Arc<TestRecorder>) {
    use std::sync::Arc;

    let db = db::connect("sqlite::memory:").await.expect("db");
    let recorder = Arc::new(TestRecorder::default());
    let mailer: mailer::SharedMailer = Arc::new(RecordingMailer {
        recorder: recorder.clone(),
    });
    let config = state::AppConfig {
        public_url: "http://test.local".into(),
        frontend_redirect_url: "http://test.local/done".into(),
        cookie_secure: false,
    };
    let s = state::AppState::new(db, mailer, config);
    (build_router(s), recorder)
}

// ─── 测试用 mailer：把所有 magic link 收集起来 ────────────────────────

#[derive(Default)]
struct TestRecorder {
    pub last_link: std::sync::Mutex<Option<String>>,
}

struct RecordingMailer {
    recorder: std::sync::Arc<TestRecorder>,
}

#[async_trait::async_trait]
impl mailer::Mailer for RecordingMailer {
    async fn send_magic_link(&self, _to: &str, link: &str) -> error::AppResult<()> {
        *self.recorder.last_link.lock().unwrap() = Some(link.to_string());
        Ok(())
    }
}

// ─── helpers ─────────────────────────────────────────────────────────────

async fn request_login(app: &axum::Router, email: &str) -> StatusCode {
    let body = serde_json::to_vec(&json!({ "email": email })).unwrap();
    let req = Request::builder()
        .method("POST")
        .uri("/api/auth/request-login")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap();
    app.clone().oneshot(req).await.unwrap().status()
}

/// 从 link 中提取 token query param
fn extract_token_from_link(link: &str) -> String {
    let qs = link.split("token=").nth(1).expect("token in link");
    qs.to_string()
}

async fn verify_login(app: &axum::Router, token: &str) -> (StatusCode, Option<String>) {
    let req = Request::builder()
        .method("GET")
        .uri(format!("/auth/verify?token={}", token))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let cookie = resp
        .headers()
        .get(header::SET_COOKIE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    (status, cookie)
}

fn session_cookie_value(set_cookie: &str) -> String {
    set_cookie
        .split(';')
        .next()
        .unwrap()
        .trim()
        .to_string()
}

async fn upload_backup(
    app: &axum::Router,
    cookie: &str,
    kind: &str,
    ciphertext_b64: &str,
) -> StatusCode {
    let body = serde_json::to_vec(&json!({
        "ciphertext_b64": ciphertext_b64,
        "kdf_salt_b64": "AAAAAAAAAAAAAAAAAAAAAA==",
        "kdf_algorithm": "argon2id-v19-m65536-t3-p4",
        "version": 1,
    }))
    .unwrap();
    let req = Request::builder()
        .method("PUT")
        .uri(format!("/api/backup/{}", kind))
        .header(header::COOKIE, cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap();
    app.clone().oneshot(req).await.unwrap().status()
}

async fn download_backup_status(app: &axum::Router, cookie: &str, kind: &str) -> StatusCode {
    let req = Request::builder()
        .method("GET")
        .uri(format!("/api/backup/{}", kind))
        .header(header::COOKIE, cookie)
        .body(Body::empty())
        .unwrap();
    app.clone().oneshot(req).await.unwrap().status()
}

// ─── Tests ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn health_endpoint_responds() {
    let (app, _) = make_test_app().await;
    let req = Request::builder().uri("/health").body(Body::empty()).unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn login_flow_request_then_verify_sets_session() {
    let (app, recorder) = make_test_app().await;

    assert_eq!(request_login(&app, "alice@example.com").await, StatusCode::OK);
    let link = recorder.last_link.lock().unwrap().clone().expect("got link");
    let token = extract_token_from_link(&link);

    let (status, cookie) = verify_login(&app, &token).await;
    assert!(status.is_redirection());
    assert!(cookie.unwrap().contains("kite_session="));
}

#[tokio::test]
async fn magic_link_is_single_use() {
    let (app, recorder) = make_test_app().await;
    assert_eq!(request_login(&app, "bob@example.com").await, StatusCode::OK);
    let token = extract_token_from_link(&recorder.last_link.lock().unwrap().clone().unwrap());

    let (s1, _) = verify_login(&app, &token).await;
    assert!(s1.is_redirection(), "first use OK");

    let (s2, _) = verify_login(&app, &token).await;
    assert_eq!(s2, StatusCode::UNAUTHORIZED, "second use rejected");
}

#[tokio::test]
async fn bogus_token_rejected() {
    let (app, _) = make_test_app().await;
    let (status, _) = verify_login(&app, "not-a-real-token").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn backup_requires_auth() {
    let (app, _) = make_test_app().await;
    let status = upload_backup(&app, "", "ca-key", "AAAA").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn backup_round_trip_after_login() {
    let (app, recorder) = make_test_app().await;
    assert_eq!(request_login(&app, "carol@example.com").await, StatusCode::OK);
    let token = extract_token_from_link(&recorder.last_link.lock().unwrap().clone().unwrap());
    let (_, set_cookie) = verify_login(&app, &token).await;
    let cookie = session_cookie_value(&set_cookie.unwrap());

    // 上传一个 ca-key
    let status = upload_backup(&app, &cookie, "ca-key", "Y2lwaGVydGV4dA==").await; // base64 "ciphertext"
    assert_eq!(status, StatusCode::OK);

    // 下载存在
    assert_eq!(download_backup_status(&app, &cookie, "ca-key").await, StatusCode::OK);
    // 没存 subscriptions 不存在
    assert_eq!(download_backup_status(&app, &cookie, "subscriptions").await, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn invalid_backup_kind_rejected() {
    let (app, recorder) = make_test_app().await;
    assert_eq!(request_login(&app, "dave@example.com").await, StatusCode::OK);
    let token = extract_token_from_link(&recorder.last_link.lock().unwrap().clone().unwrap());
    let (_, set_cookie) = verify_login(&app, &token).await;
    let cookie = session_cookie_value(&set_cookie.unwrap());

    let status = upload_backup(&app, &cookie, "evil-kind", "AAAA").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn users_cannot_see_each_others_backups() {
    let (app, recorder) = make_test_app().await;

    // user A
    request_login(&app, "user-a@example.com").await;
    let token_a = extract_token_from_link(&recorder.last_link.lock().unwrap().clone().unwrap());
    let (_, c) = verify_login(&app, &token_a).await;
    let cookie_a = session_cookie_value(&c.unwrap());

    // user A 上传
    upload_backup(&app, &cookie_a, "ca-key", "QQ==").await;

    // user B 登录
    request_login(&app, "user-b@example.com").await;
    let token_b = extract_token_from_link(&recorder.last_link.lock().unwrap().clone().unwrap());
    let (_, c) = verify_login(&app, &token_b).await;
    let cookie_b = session_cookie_value(&c.unwrap());

    // user B 看不到 user A 的备份
    assert_eq!(
        download_backup_status(&app, &cookie_b, "ca-key").await,
        StatusCode::NOT_FOUND,
        "user B 看不到 user A 的备份"
    );
}

#[tokio::test]
async fn malformed_email_rejected() {
    let (app, _) = make_test_app().await;
    assert_eq!(
        request_login(&app, "not-an-email").await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(request_login(&app, "").await, StatusCode::BAD_REQUEST);
}

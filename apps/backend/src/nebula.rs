//! Nebula 子进程托管 —— 让 kite-backend 进程同时把 Nebula lighthouse 跑起来。
//!
//! 用一个 systemd unit / 一个 Docker container 同时跑两件事的代价：
//! kite-backend (PID 1) 起 axum，再 spawn 一个 nebula child，两者生命周期绑定。
//! Nebula 挂了 → backend 退出 → systemd / Docker 重启整体。
//!
//! 触发条件：环境变量 `KITE_NEBULA_BIN` 和 `KITE_NEBULA_CONFIG` 都设置时才启动。
//! 没设置就退化成纯后端进程（dev / 单独跑 backend 时用）。

use std::process::Stdio;
use tokio::process::{Child, Command};

pub struct NebulaSupervisor {
    child: Option<Child>,
}

impl NebulaSupervisor {
    /// 从环境变量读配置，决定要不要拉起 nebula。
    /// 返回 Ok(Some(_)) 表示拉起来了，Ok(None) 表示没配置（dev 模式跳过）。
    pub fn maybe_spawn_from_env() -> Result<Option<Self>, String> {
        let (Ok(bin), Ok(config)) = (
            std::env::var("KITE_NEBULA_BIN"),
            std::env::var("KITE_NEBULA_CONFIG"),
        ) else {
            tracing::info!("KITE_NEBULA_BIN / KITE_NEBULA_CONFIG 未设置 —— 跳过 nebula 启动");
            return Ok(None);
        };

        let child = Command::new(&bin)
            .arg("-config")
            .arg(&config)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("启动 nebula 失败 (bin={}, config={}): {}", bin, config, e))?;

        tracing::info!(pid = child.id(), bin = %bin, config = %config, "nebula 子进程已启动");
        Ok(Some(Self { child: Some(child) }))
    }

    /// 阻塞等 nebula 退出（成功 / 失败都返回）。配合 tokio::select! 用：
    /// nebula 挂了就让整个 backend 也退，让 systemd 拉起来。
    pub async fn wait_exit(&mut self) -> std::io::Result<std::process::ExitStatus> {
        match self.child.as_mut() {
            Some(c) => c.wait().await,
            None => std::future::pending().await,
        }
    }
}

impl Drop for NebulaSupervisor {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.take() {
            // kill_on_drop 已经会处理，这里只是确认日志
            tracing::info!("kite-backend 退出 —— nebula 子进程随之关闭");
            let _ = c.start_kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn no_env_returns_none() {
        // 显式清掉，避免被宿主环境污染
        std::env::remove_var("KITE_NEBULA_BIN");
        std::env::remove_var("KITE_NEBULA_CONFIG");
        let result = NebulaSupervisor::maybe_spawn_from_env().unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn missing_binary_errors() {
        std::env::set_var("KITE_NEBULA_BIN", "/nonexistent/nebula");
        std::env::set_var("KITE_NEBULA_CONFIG", "/nonexistent/config.yaml");
        let result = NebulaSupervisor::maybe_spawn_from_env();
        std::env::remove_var("KITE_NEBULA_BIN");
        std::env::remove_var("KITE_NEBULA_CONFIG");
        assert!(result.is_err());
    }
}

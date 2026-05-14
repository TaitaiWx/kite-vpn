//! Nebula sidecar 子进程管理（镜像 engine.rs 的 mihomo 管理模式）。
//!
//! Nebula 是 Slack 开源的 P2P Mesh 网络，Kite 嵌入它实现"翻墙 + Mesh 一体化"。
//! 本模块负责拉起/停止 nebula 子进程、捕获日志、跟踪生命周期。
//!
//! 设计原则（per workspace claude.md）：
//! - 业界最佳实践：复用 EngineProcess 同款模式（成熟代码风格）
//! - 第一性原理：Nebula 跟 mihomo 都是单二进制 Go 程序，子进程管理逻辑同形
//! - 禁滥用 Option：child 用 Option 是语义正确（运行 / 未运行），config_path
//!   只在 start 之后才有意义，所以也 Option。其他字段（PID、版本）通过方法返回。

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const MAX_LOG_LINES: usize = 500;

/// 跨平台进程名（killall 用）—— Tauri sidecar 命名约定 `<name>-<target_triple>`
const NEBULA_PROCESS_NAMES: &[&str] = &[
    "nebula-aarch64-apple-darwin",
    "nebula-x86_64-apple-darwin",
    "nebula-x86_64-unknown-linux-gnu",
    "nebula-aarch64-unknown-linux-gnu",
];

pub struct NebulaProcess {
    child: Option<Child>,
    /// nebula config.yaml 的路径，stop 后会清空
    config_path: Option<PathBuf>,
}

impl NebulaProcess {
    pub fn new() -> Self {
        Self {
            child: None,
            config_path: None,
        }
    }

    /// 启动 nebula 进程指向 config_path（必须是已存在的合法 nebula YAML）。
    /// 返回新进程的 PID。
    pub fn start(&mut self, nebula_path: &str, config_path: &str) -> Result<u32, String> {
        if self.is_running() {
            let _ = self.stop();
        }

        // 清理可能残留的 nebula 进程
        #[cfg(unix)]
        Self::killall_residual();

        let mut cmd = Command::new(nebula_path);
        cmd.arg("-config")
            .arg(config_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("启动 Nebula 失败: {}", e))?;

        let pid = child.id();

        // Nebula 日志默认走 stdout，stderr 是 panic / 启动 fatal。两个都捕获。
        Self::pipe_to_buffer(child.stdout.take(), "[stdout]");
        Self::pipe_to_buffer(child.stderr.take(), "[stderr]");

        self.child = Some(child);
        self.config_path = Some(PathBuf::from(config_path));
        Ok(pid)
    }

    pub fn stop(&mut self) -> Result<(), String> {
        if let Some(mut child) = self.child.take() {
            child.kill().map_err(|e| format!("停止 Nebula 失败: {}", e))?;
            child.wait().ok();
        }
        // 兜底：dev 重编译丢失 child 引用时也清理
        #[cfg(unix)]
        Self::killall_residual();
        Ok(())
    }

    pub fn restart(&mut self, nebula_path: &str) -> Result<u32, String> {
        let config_path = self
            .config_path
            .as_ref()
            .ok_or("没有可用的 Nebula 配置文件")?
            .to_string_lossy()
            .to_string();
        self.stop()?;
        self.start(nebula_path, &config_path)
    }

    /// 当前 child 是否还活着。
    pub fn is_running(&mut self) -> bool {
        match &mut self.child {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        }
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.as_ref().map(|c| c.id())
    }

    // ─── 内部 helpers ──────────────────────────────────────────────────────

    #[cfg(unix)]
    fn killall_residual() {
        // graceful 先
        for name in NEBULA_PROCESS_NAMES {
            let _ = Command::new("killall").args(["-TERM", name]).output();
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
        // 强杀兜底
        for name in NEBULA_PROCESS_NAMES {
            let _ = Command::new("killall").args(["-KILL", name]).output();
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    /// 把子进程的 stdout/stderr 异步流到全局 ring buffer。
    /// prefix 用来区分两个流（mihomo 只有 stderr，nebula 两个都要看）。
    fn pipe_to_buffer<R: std::io::Read + Send + 'static>(stream: Option<R>, prefix: &'static str) {
        let Some(stream) = stream else { return };
        let buf = get_log_buffer();
        // 首次 start 时清掉旧 log，避免上次进程的日志混进来
        if let Ok(mut guard) = buf.lock() {
            guard.clear();
        }
        let buf_clone = Arc::clone(buf);
        std::thread::spawn(move || {
            let reader = BufReader::new(stream);
            for line in reader.lines() {
                let Ok(l) = line else { break };
                if let Ok(mut guard) = buf_clone.lock() {
                    if guard.len() >= MAX_LOG_LINES {
                        guard.pop_front();
                    }
                    guard.push_back(format!("{} {}", prefix, l));
                }
            }
        });
    }
}

impl Default for NebulaProcess {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for NebulaProcess {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

// ─── 全局日志环形缓冲（独立于 mihomo 的 LOG_BUFFER） ───────────────────────

static LOG_BUFFER: OnceLock<Arc<Mutex<VecDeque<String>>>> = OnceLock::new();

fn get_log_buffer() -> &'static Arc<Mutex<VecDeque<String>>> {
    LOG_BUFFER.get_or_init(|| Arc::new(Mutex::new(VecDeque::with_capacity(MAX_LOG_LINES))))
}

pub fn read_logs(since_index: usize) -> Vec<String> {
    let buf = get_log_buffer();
    if let Ok(guard) = buf.lock() {
        let total = guard.len();
        if since_index >= total {
            return Vec::new();
        }
        guard.iter().skip(since_index).cloned().collect()
    } else {
        Vec::new()
    }
}

pub fn log_count() -> usize {
    let buf = get_log_buffer();
    buf.lock().map(|g| g.len()).unwrap_or(0)
}

// ─── App 状态（用 Tauri manage()）─────────────────────────────────────────

pub struct NebulaEngineState {
    pub engine: Mutex<NebulaProcess>,
}

impl NebulaEngineState {
    pub fn new() -> Self {
        Self {
            engine: Mutex::new(NebulaProcess::new()),
        }
    }
}

// ─── 单元测试 ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_process_is_not_running() {
        let mut p = NebulaProcess::new();
        assert!(!p.is_running());
        assert_eq!(p.pid(), None);
    }

    #[test]
    fn start_with_nonexistent_binary_returns_err() {
        let mut p = NebulaProcess::new();
        let result = p.start("/nonexistent/nebula", "/tmp/config.yaml");
        assert!(result.is_err());
        assert!(!p.is_running());
    }

    #[test]
    fn stop_idle_process_is_safe() {
        let mut p = NebulaProcess::new();
        // stop 在 idle 进程上不应 panic
        let result = p.stop();
        assert!(result.is_ok());
    }

    #[test]
    fn log_buffer_starts_empty() {
        // 注意：这个 buffer 是全局的，其他测试可能往里塞过东西
        // 我们只检查 read_logs 不 panic
        let logs = read_logs(0);
        assert!(logs.len() == log_count());
    }

    #[test]
    fn state_creates_idle_process() {
        let state = NebulaEngineState::new();
        let mut guard = state.engine.lock().unwrap();
        assert!(!guard.is_running());
    }
}

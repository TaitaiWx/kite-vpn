use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

const MAX_LOG_LINES: usize = 500;

pub struct EngineProcess {
    child: Option<Child>,
    config_dir: Option<PathBuf>,
}

impl EngineProcess {
    pub fn new() -> Self {
        Self {
            child: None,
            config_dir: None,
        }
    }

    pub fn start(&mut self, mihomo_path: &str, config_dir: &str) -> Result<u32, String> {
        if self.is_running() {
            let _ = self.stop();
        }

        // 清理可能残留的 mihomo 进程（上次异常退出没 stop 的情况）
        // 用 killall 而不是 pkill，不需要 sudo
        #[cfg(unix)]
        {
            // 先尝试 graceful
            let _ = Command::new("killall").args(["-TERM", "mihomo-aarch64-apple-darwin"]).output();
            let _ = Command::new("killall").args(["-TERM", "mihomo-x86_64-apple-darwin"]).output();
            let _ = Command::new("killall").args(["-TERM", "mihomo-x86_64-unknown-linux-gnu"]).output();
            std::thread::sleep(std::time::Duration::from_millis(300));
            // 如果还没退就强杀
            let _ = Command::new("killall").args(["-KILL", "mihomo-aarch64-apple-darwin"]).output();
            let _ = Command::new("killall").args(["-KILL", "mihomo-x86_64-apple-darwin"]).output();
            std::thread::sleep(std::time::Duration::from_millis(200));
        }

        let mut child = Command::new(mihomo_path)
            .arg("-d")
            .arg(config_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("启动引擎失败: {}", e))?;

        let pid = child.id();

        if let Some(stderr) = child.stderr.take() {
            let buf = get_log_buffer();
            if let Ok(mut guard) = buf.lock() {
                guard.clear();
            }

            let buf_clone = Arc::clone(buf);
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    match line {
                        Ok(l) => {
                            if let Ok(mut guard) = buf_clone.lock() {
                                if guard.len() >= MAX_LOG_LINES {
                                    guard.pop_front();
                                }
                                guard.push_back(l);
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        self.child = Some(child);
        self.config_dir = Some(PathBuf::from(config_dir));
        Ok(pid)
    }

    pub fn stop(&mut self) -> Result<(), String> {
        if let Some(mut child) = self.child.take() {
            child.kill().map_err(|e| format!("停止引擎失败: {}", e))?;
            child.wait().ok();
        }
        // 即使 child 引用丢了（dev 重编译），也用 killall 确保 mihomo 进程被停止
        #[cfg(unix)]
        {
            let _ = Command::new("killall").args(["-TERM", "mihomo-aarch64-apple-darwin"]).output();
            let _ = Command::new("killall").args(["-TERM", "mihomo-x86_64-apple-darwin"]).output();
            let _ = Command::new("killall").args(["-TERM", "mihomo-x86_64-unknown-linux-gnu"]).output();
        }
        Ok(())
    }

    pub fn restart(&mut self, mihomo_path: &str) -> Result<u32, String> {
        let config_dir = self
            .config_dir
            .as_ref()
            .ok_or("没有可用的配置目录")?
            .to_string_lossy()
            .to_string();
        self.stop()?;
        self.start(mihomo_path, &config_dir)
    }

    pub fn is_running(&mut self) -> bool {
        if let Some(child) = &mut self.child {
            matches!(child.try_wait(), Ok(None))
        } else {
            false
        }
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.as_ref().map(|c| c.id())
    }
}

impl Default for EngineProcess {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for EngineProcess {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

// ─── 全局日志缓冲 ───────────────────────────────────────────────────────────

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

// ─── App 状态 ───────────────────────────────────────────────────────────────

pub struct EngineState {
    pub engine: Mutex<EngineProcess>,
}

impl EngineState {
    pub fn new() -> Self {
        Self {
            engine: Mutex::new(EngineProcess::new()),
        }
    }
}

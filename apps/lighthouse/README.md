# Kite Lighthouse

Mesh 网络的"灯塔"服务。部署在公网 VPS 上，帮 Kite 设备发现彼此 + 协助 NAT 穿透。

## 为什么需要 Lighthouse

```
没有 lighthouse:
  ┌────────────┐                    ┌────────────┐
  │ 家里 NAS    │  ╲ NAT             │ 笔记本     │
  │ 内网 IP    │   ✗ 找不到对方  ←─ │ 4G 网络    │
  └────────────┘  ╱                 └────────────┘

有 lighthouse:
  ┌────────────┐    ┌──────────────┐    ┌────────────┐
  │ 家里 NAS    │ ←→ │ Lighthouse   │ ←→ │ 笔记本     │
  │            │    │ VPS 公网 IP   │    │            │
  └────────────┘    └──────────────┘    └────────────┘
       │                  助攻              │
       └──────── NAT 穿透成功后直连 ─────────┘
```

Lighthouse **不转发数据流量** —— 只在节点初次握手时帮忙交换公网地址。NAT 穿透成功后所有流量是 P2P 直连。

## 一键部署

**前置条件**：
- 你的 macOS / Linux 上跑过 Kite 并创建了网络（owner 设备）
- 一台 Linux VPS（Ubuntu 22+ / Debian 12+ / CentOS Stream 9+ 等）
- VPS 的 SSH 公钥已加到 `~/.ssh/authorized_keys`，本地能直接 `ssh user@vps` 进去

**部署**：

```bash
cd /path/to/kite-vpn
./apps/lighthouse/deploy.sh \
  --vps root@your-vps.com \
  --mesh-dir "$HOME/Library/Application Support/com.kitevpn.desktop/mesh"
```

整个过程约 30 秒。脚本会：

1. 用你 Kite 里的 CA 给 lighthouse 签一张证书（**CA 私钥从不出本机**）
2. 上传 nebula 二进制 + 证书 + 配置 + systemd unit 到 VPS
3. 自动开 ufw / firewalld 的 UDP 端口（如果检测到）
4. 启动 `kite-lighthouse.service`
5. 验证服务运行状态

## 选项

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--vps` | 必填 | SSH 目标，例 `root@vps.example.com` |
| `--mesh-dir` | 必填 | 本地 Kite mesh 目录（含 `ca.crt` + `ca.key`） |
| `--ip` | `100.64.0.1` | Lighthouse 在 Mesh 内的虚拟 IP |
| `--port` | `4242` | UDP 监听端口 |
| `--ipv4-only` | off | 默认 IPv6 双栈；老服务器可强制 IPv4 |
| `--skip-firewall` | off | 跳过自动改防火墙规则 |
| `--dry-run` | off | 打印会做的事，不实际操作 VPS |

## Mesh 目录在哪？

| OS | 路径 |
|---|---|
| macOS | `~/Library/Application Support/com.kitevpn.desktop/mesh` |
| Linux | `~/.local/share/com.kitevpn.desktop/mesh` |
| Windows | `%APPDATA%\com.kitevpn.desktop\mesh` |

里面应该有：
```
mesh/
├── ca.crt        ← 必须存在
├── ca.key        ← 必须存在（owner 设备才有）
├── self.crt
├── self.key
├── config.yaml
└── network.json
```

如果 `ca.key` 不在 = 这台不是 owner，不能部署 lighthouse。请在 owner 设备上跑这个脚本。

## IPv6 支持

脚本默认以 IPv6 双栈模式部署（`host: "::"`），同时接受 IPv4 客户端（IPv4-mapped-IPv6）。

**测过的环境**：
- ✅ Ubuntu 22.04 / 24.04（默认 `net.ipv6.bindv6only=0`）
- ✅ Debian 12（默认 dual-stack）
- ✅ Hetzner Cloud / Vultr / DigitalOcean / 阿里云国际版

**坑**：
- 某些 VPS 关了 `net.ipv6.bindv6only=1`，dual-stack 失效 → 用 `--ipv4-only`
- 国内阿里云 / 腾讯云的 IPv6 通常需要单独申请

## 验证

部署完成后，**任意 Kite 设备**启动 Mesh 后跑：

```bash
# Mac / Linux:
ping 100.64.0.1

# Windows PowerShell:
Test-Connection 100.64.0.1
```

通了 = 大功告成。不通的话查：

1. **VPS 防火墙**：阿里云 / Hetzner 控制台的「安全组」里有没有放 UDP 4242
2. **本地启动 Mesh**：Kite → 网络 → 启动 Mesh（绿色 banner 才行）
3. **看日志**：
   ```bash
   ssh root@your-vps.com 'journalctl -u kite-lighthouse -n 30'
   ```

## 卸载

```bash
ssh root@your-vps.com '
  systemctl stop kite-lighthouse
  systemctl disable kite-lighthouse
  rm -rf /etc/kite-lighthouse /var/log/kite-lighthouse
  rm /etc/systemd/system/kite-lighthouse.service
  rm /usr/local/bin/kite-lighthouse
  systemctl daemon-reload
'
```

## 架构注释

| 文件 | 角色 |
|---|---|
| `deploy.sh` | 部署 orchestrator |
| `templates/config.yaml.template` | Nebula lighthouse 配置（模板） |
| `templates/kite-lighthouse.service` | systemd unit（加固过的，无 TUN 权限） |

`templates/` 跟 `deploy.sh` 分离 = 后续 Kite GUI 也能直接渲染同款模板（rule 1：业界最佳实践，模板复用）。

## 未来 v1.5：Kite UI 内嵌部署

预计 v1.5 在 Kite 设置页加一个「Lighthouse 部署」面板：
- 在 UI 里填 VPS IP + SSH key
- Kite 通过 Tauri shell plugin 调本脚本
- 跨平台体验一致

模板共用，逻辑零重复。

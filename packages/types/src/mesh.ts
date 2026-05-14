/**
 * @kite-vpn/types — Mesh network type definitions.
 *
 * Kite 内嵌 Nebula（Slack 开源的 P2P Mesh）作为 sidecar，实现"翻墙 + Mesh
 * 一体化"。本文件定义 Mesh 相关的所有共享类型。
 *
 * 设计原则（per workspace claude.md）：
 * - 禁止滥用 `?` 可选：只在语义上"可能不存在"时用，比如 lastSeenAt 在节点从未
 *   上线过时不存在；name 这种必有字段不用 `?`
 * - 禁止隐藏变量：所有 union / 枚举显式列出可能值
 */

// ---------------------------------------------------------------------------
// Roles & states
// ---------------------------------------------------------------------------

/**
 * Peer 在 Mesh 网络中的角色。
 *
 * - `owner`:  CA 私钥持有者，能签发新证书。每个 Mesh 网络 1 个 owner。
 * - `member`: 普通成员，只能收发流量，不能签证书。
 * - `exit`:   暴露为 exit node，其他 peer 可选择把所有出墙流量经其转发。
 * - `subnet`: 子网路由器，advertise 一个 LAN CIDR（例如家庭 192.168.1.0/24），
 *             让其他 peer 通过它访问那个 LAN。
 * - `lighthouse`: 公网 VPS 上跑的发现服务，不参与数据流量，只帮 peer NAT 穿透。
 *
 * 一个 peer 可以同时是 `member` + `exit` + `subnet`（位掩码语义），但
 * `owner` 和 `lighthouse` 互斥于其他角色。前端用数组表示组合：
 * `roles: ['member', 'exit']`。
 */
export type MeshPeerRole = 'owner' | 'member' | 'exit' | 'subnet' | 'lighthouse'

/**
 * Peer 在线状态 —— 显式枚举，不用 boolean，因为"正在握手"是真实第三态。
 */
export type MeshPeerStatus = 'online' | 'offline' | 'handshaking'

// ---------------------------------------------------------------------------
// Peer
// ---------------------------------------------------------------------------

/**
 * 一个 Mesh 节点。
 *
 * 字段命名规则：camelCase TS 端，Rust 端通过 serde rename 转 snake_case。
 */
export interface MeshPeer {
  /** Stable identifier — 取自证书的 fingerprint (sha256 前 16 hex)。 */
  id: string
  /** 人类可读名称，例：「Mac 笔记本」「家里 NAS」。Owner 设备签发证书时设置。 */
  name: string
  /** 在 Mesh 内的虚拟 IP，例：100.64.0.2。每个 peer 必有，不可选。 */
  meshIp: string
  /** 角色组合，至少 1 个。 */
  roles: MeshPeerRole[]
  /** 当前在线状态。 */
  status: MeshPeerStatus
  /** 最近一次心跳 unix 毫秒时间戳。节点从未上线时为 0（不用 `?` 隐藏空值）。 */
  lastSeenAt: number
  /** 节点公网端点（host:port），NAT 穿透成功后填充。未穿透前为空字符串。 */
  publicEndpoint: string
  /** 证书签发时间 unix 毫秒。用于显示「3 个月前加入」。 */
  enrolledAt: number
  /** 证书过期时间 unix 毫秒。Owner 续签前显示警告。 */
  certExpiresAt: number
  /** subnet 角色时：advertise 的 LAN CIDR，例：「192.168.1.0/24」。其他角色为空字符串。 */
  advertisedSubnet: string
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/**
 * 一个完整的 Mesh 网络。v1 阶段一个 Kite 实例只能加入 1 个网络（v3 支持多网络）。
 */
export interface MeshNetwork {
  /** 网络 ID — 取自 CA 证书 fingerprint。 */
  id: string
  /** 网络名称，例「家庭网络」，owner 设置。 */
  name: string
  /** CIDR 网段，默认 100.64.0.0/10（RFC 6598）。 */
  cidr: string
  /** Lighthouse 公网地址（host:port），node 通过它做发现 + 穿透 fallback。 */
  lighthouseEndpoint: string
  /** 网络创建时间 unix 毫秒。 */
  createdAt: number
  /** 本设备在该网络里的 peer ID（外键到 MeshPeer.id）。 */
  selfPeerId: string
}

// ---------------------------------------------------------------------------
// Enrollment — 新设备加入流程
// ---------------------------------------------------------------------------

/**
 * Owner 设备生成的一次性 enrollment token，用于让新设备加入网络。
 *
 * 工作流：
 *   1. Owner 在 Kite 点「添加设备」→ 生成 token + 上传加密载荷到 lighthouse
 *   2. 新设备装 Kite → 输入 token → 从 lighthouse 取回签好的证书 + 配置
 *   3. Token 一次性使用，过期作废
 */
export interface MeshEnrollmentToken {
  /** Token 字符串本身，base32 编码，约 24 字符，方便用户手抄 / 二维码扫描。 */
  token: string
  /** 这个 token 是给哪个新 peer 名字签发的，例：「我的 iPhone」。 */
  peerName: string
  /** 预设角色，owner 在签发前决定。 */
  roles: MeshPeerRole[]
  /** 预分配的 mesh IP。 */
  meshIp: string
  /** Unix 毫秒过期时间，默认创建后 10 分钟。 */
  expiresAt: number
}

// ---------------------------------------------------------------------------
// ACL — 哪台设备能访问哪台
// ---------------------------------------------------------------------------

/**
 * 一条 ACL 规则。Owner 在 Kite UI 编辑后，重签所有 peer 证书把规则烧进去。
 *
 * 语义：from 中的任意 peer 可以访问 to 中的任意 peer 的 ports（TCP/UDP/ICMP）。
 *
 * 默认（无 ACL）：所有 peer 可以访问彼此所有端口（最宽松，便于 v1 调试）。
 */
export interface MeshAclRule {
  /** UUID，用户重命名规则时保持稳定。 */
  id: string
  /** 描述性名称，例「手机只能访问 NAS 的 SMB」。 */
  name: string
  /** 源 peer ID 列表，空数组表示「任何 peer」。 */
  from: string[]
  /** 目标 peer ID 列表，空数组表示「任何 peer」。 */
  to: string[]
  /** TCP/UDP 端口列表，例 ['22', '80', '443', '5000-5100']，空数组表示「所有端口」。 */
  ports: string[]
  /** 是否允许 ICMP（ping）。Boolean 显式声明，不用 `?`。 */
  allowIcmp: boolean
}

// ---------------------------------------------------------------------------
// Mesh 引擎运行时状态（IPC engine_get_state 用）
// ---------------------------------------------------------------------------

export type MeshEngineStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface MeshEngineState {
  status: MeshEngineStatus
  /** 当前进程的 PID，未运行时为 0（不用 `?` 隐藏空值）。 */
  pid: number
  /** Nebula 版本号，例「v1.9.5」。从二进制读出，加载失败时为空字符串。 */
  version: string
  /** 错误描述，仅 status='error' 时有内容，其他状态为空字符串。 */
  error: string
}

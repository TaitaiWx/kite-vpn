/**
 * Network page — Phase 4 Mesh 控制中心。
 *
 * 三种界面状态：
 *   1. 未加入网络 → 创建 / 加入 入口（首次使用）
 *   2. 已加入但 Mesh 停止 → 设备列表 + 启动按钮
 *   3. 已加入且 Mesh 运行 → 设备列表 + 实时状态 + 邀请新设备
 *
 * 设计原则（per workspace claude.md）:
 * - rule 6: 复用 @/components 已有的 Input / Select / StatusBadge / Tooltip，不重写样式
 * - rule 8: 未加入网络时 network = null（显式），不用 optional
 *
 * NO `any`.
 */

import { useEffect, useState } from 'react'
import {
  Network as NetworkIcon,
  Plus,
  UserPlus,
  Power,
  Copy,
  Trash2,
  Cpu,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import { clsx } from 'clsx'
import type { MeshPeer, MeshPeerRole } from '@kite-vpn/types'
import { useMeshStore } from '@/stores/mesh'
import { toast } from '@/stores/toast'
import { Input } from '@/components/Input'
import { Tooltip } from '@/components/Tooltip'

// ---------------------------------------------------------------------------
// Role display helpers
// ---------------------------------------------------------------------------

const ROLE_LABELS: Record<MeshPeerRole, string> = {
  owner: '主控',
  member: '成员',
  exit: '出口',
  subnet: '子网',
  lighthouse: '中继',
}

const ROLE_COLORS: Record<MeshPeerRole, string> = {
  owner: 'bg-amber-500/15 text-amber-400',
  member: 'bg-blue-500/15 text-blue-400',
  exit: 'bg-violet-500/15 text-violet-400',
  subnet: 'bg-emerald-500/15 text-emerald-400',
  lighthouse: 'bg-rose-500/15 text-rose-400',
}

function RoleBadge({ role }: { role: MeshPeerRole }) {
  return (
    <span className={clsx('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium', ROLE_COLORS[role])}>
      {ROLE_LABELS[role]}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Peer card
// ---------------------------------------------------------------------------

interface PeerCardProps {
  peer: MeshPeer
  onRevoke: () => void
}

function PeerCard({ peer, onRevoke }: PeerCardProps) {
  const online = peer.status === 'online'
  return (
    <div className="bg-surface-1 border border-border rounded-xl p-4 hover:bg-surface-2 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-200 truncate">{peer.name}</span>
            {peer.roles.includes('owner') ? null : (
              <button
                type="button"
                onClick={onRevoke}
                className="text-gray-500 hover:text-rose-400 transition-colors"
                title="撤销此设备"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
          <div className="mt-1 font-mono text-[11px] text-gray-400">{peer.meshIp || '— 待分配'}</div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {online ? (
            <CheckCircle2 size={14} className="text-emerald-400" />
          ) : (
            <XCircle size={14} className="text-gray-500" />
          )}
          <span className={clsx('text-[10px]', online ? 'text-emerald-400' : 'text-gray-500')}>
            {online ? '在线' : '离线'}
          </span>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {peer.roles.map((r) => (
          <RoleBadge key={r} role={r} />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Create network dialog
// ---------------------------------------------------------------------------

interface CreateDialogProps {
  open: boolean
  onClose: () => void
}

function CreateNetworkDialog({ open, onClose }: CreateDialogProps) {
  const createNetwork = useMeshStore((s) => s.createNetwork)
  const [name, setName] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (!open) return null

  const submit = async () => {
    if (!name.trim() || !endpoint.trim()) {
      toast('请填写网络名称和 Lighthouse 地址', 'warning')
      return
    }
    setSubmitting(true)
    const result = await createNetwork(name.trim(), endpoint.trim())
    setSubmitting(false)
    if (result) {
      toast(`网络「${result.name}」创建成功`, 'success')
      onClose()
      setName('')
      setEndpoint('')
    } else {
      toast('创建失败 —— 查看日志', 'error')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-surface-0 border border-border rounded-xl w-[440px] p-5 space-y-4">
        <h3 className="text-base font-semibold text-gray-100">创建 Mesh 网络</h3>
        <p className="text-xs text-gray-400">
          本设备会成为网络的 owner，CA 私钥保留在本地不外传。Lighthouse VPS
          只做节点发现，不存证书。
        </p>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">网络名称</label>
            <Input type="text" value={name} onChange={setName} placeholder="例：我的家庭网络" />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Lighthouse 地址</label>
            <Input
              type="text"
              value={endpoint}
              onChange={setEndpoint}
              placeholder="vps.example.com:4242"
            />
            <p className="text-[10px] text-gray-500 mt-1">
              你的 VPS 公网地址 + 端口（默认 4242）。lighthouse 二进制需要单独部署到 VPS。
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary text-xs py-1.5 px-3">
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="btn-primary text-xs py-1.5 px-3"
          >
            {submitting ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Join network dialog
// ---------------------------------------------------------------------------

interface JoinDialogProps {
  open: boolean
  onClose: () => void
}

function JoinNetworkDialog({ open, onClose }: JoinDialogProps) {
  const joinNetwork = useMeshStore((s) => s.joinNetwork)
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (!open) return null

  const submit = async () => {
    if (!token.trim()) {
      toast('请粘贴邀请码', 'warning')
      return
    }
    setSubmitting(true)
    const result = await joinNetwork(token.trim())
    setSubmitting(false)
    if (result) {
      toast(`已加入网络「${result.name}」`, 'success')
      onClose()
      setToken('')
    } else {
      toast('加入失败 —— 邀请码可能已过期或损坏', 'error')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-surface-0 border border-border rounded-xl w-[480px] p-5 space-y-4">
        <h3 className="text-base font-semibold text-gray-100">加入 Mesh 网络</h3>
        <p className="text-xs text-gray-400">
          粘贴 owner 设备发给你的邀请码（base32 字符串）。邀请码默认 10 分钟过期。
        </p>
        <textarea
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="ABCDEFGH..."
          rows={6}
          className="w-full px-3 py-2 bg-surface-1 border border-border rounded-md text-xs font-mono text-gray-200 focus:outline-none focus:ring-1 focus:ring-primary-500"
        />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary text-xs py-1.5 px-3">
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="btn-primary text-xs py-1.5 px-3"
          >
            {submitting ? '加入中…' : '加入'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Invite peer dialog
// ---------------------------------------------------------------------------

interface InviteDialogProps {
  open: boolean
  onClose: () => void
  /** 默认 IP，下一个可用 100.64.0.N。 */
  defaultIp: string
}

function InvitePeerDialog({ open, onClose, defaultIp }: InviteDialogProps) {
  const generateToken = useMeshStore((s) => s.generateToken)
  const [peerName, setPeerName] = useState('')
  const [meshIp, setMeshIp] = useState(defaultIp)
  const [generated, setGenerated] = useState('')

  useEffect(() => {
    if (open) {
      setMeshIp(defaultIp)
      setGenerated('')
      setPeerName('')
    }
  }, [open, defaultIp])

  if (!open) return null

  const submit = async () => {
    if (!peerName.trim() || !meshIp.trim()) {
      toast('请填写设备名称和内网 IP', 'warning')
      return
    }
    const result = await generateToken(peerName.trim(), ['member'], meshIp.trim())
    if (result) {
      setGenerated(result.token)
    } else {
      toast('生成失败', 'error')
    }
  }

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(generated)
      toast('邀请码已复制', 'success')
    } catch {
      toast('剪贴板不可用 —— 请手动选择文本复制', 'warning')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-surface-0 border border-border rounded-xl w-[520px] p-5 space-y-4">
        <h3 className="text-base font-semibold text-gray-100">邀请新设备</h3>
        {generated ? (
          <>
            <p className="text-xs text-gray-400">
              复制下方邀请码发给新设备。10 分钟内有效，过期需要重新生成。
            </p>
            <div className="relative">
              <textarea
                readOnly
                value={generated}
                rows={6}
                className="w-full px-3 py-2 bg-surface-1 border border-border rounded-md text-[11px] font-mono text-gray-200 break-all"
              />
              <button
                type="button"
                onClick={copyToken}
                className="absolute top-2 right-2 btn-secondary text-xs py-1 px-2 inline-flex items-center gap-1"
              >
                <Copy size={12} />
                复制
              </button>
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className="btn-primary text-xs py-1.5 px-3">
                完成
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-gray-400">填写新设备信息，Kite 会生成一次性加密邀请码。</p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">设备名称</label>
                <Input type="text" value={peerName} onChange={setPeerName} placeholder="例：iPhone / 家里 NAS / 公司笔记本" />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">内网 IP</label>
                <Input type="text" value={meshIp} onChange={setMeshIp} placeholder="100.64.0.2" />
                <p className="text-[10px] text-gray-500 mt-1">
                  100.64.0.0/10 范围内，避免跟现有 peers 冲突。
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="btn-secondary text-xs py-1.5 px-3">
                取消
              </button>
              <button type="button" onClick={submit} className="btn-primary text-xs py-1.5 px-3">
                生成邀请码
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function NetworkPage() {
  const network = useMeshStore((s) => s.network)
  const engine = useMeshStore((s) => s.engine)
  const peers = useMeshStore((s) => s.peers)
  const loaded = useMeshStore((s) => s.loaded)
  const refresh = useMeshStore((s) => s.refresh)
  const startEngine = useMeshStore((s) => s.startEngine)
  const stopEngine = useMeshStore((s) => s.stopEngine)
  const revokePeer = useMeshStore((s) => s.revokePeer)

  const [createOpen, setCreateOpen] = useState(false)
  const [joinOpen, setJoinOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)

  // 首次加载 + 每 30s 自动刷新 peer 列表（轻量级，只拉 IPC 不走网络）
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, 30_000)
    return () => clearInterval(timer)
  }, [refresh])

  // 计算下一个可用 IP：100.64.0.N，N = 当前最大 + 1
  const nextAvailableIp = (() => {
    const taken = peers
      .map((p) => p.meshIp)
      .filter((ip) => ip.startsWith('100.64.0.'))
      .map((ip) => parseInt(ip.split('.')[3] ?? '0', 10))
      .filter((n) => !Number.isNaN(n))
    const maxN = taken.length > 0 ? Math.max(...taken) : 0
    return `100.64.0.${Math.max(2, maxN + 1)}`
  })()

  if (!loaded) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500 text-sm">
        加载中…
      </div>
    )
  }

  // ── 未加入网络：欢迎页 ────────────────────────────────────────────────
  if (!network) {
    return (
      <div className="h-full flex flex-col items-center justify-center px-8 text-center animate-fade-in">
        <div className="w-16 h-16 rounded-2xl bg-primary-500/10 flex items-center justify-center mb-4">
          <NetworkIcon className="w-8 h-8 text-primary-400" />
        </div>
        <h1 className="text-xl font-semibold text-gray-100 mb-2">Mesh 网络</h1>
        <p className="text-sm text-gray-400 max-w-md mb-8">
          把你的设备（笔记本 / NAS / 手机 / 云端）拉到一个加密的虚拟内网。
          出差时一样可以访问家里的 NAS，安全且开箱即用。
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="btn-primary text-sm py-2 px-4 inline-flex items-center gap-2"
          >
            <Plus size={16} />
            创建网络（owner）
          </button>
          <button
            type="button"
            onClick={() => setJoinOpen(true)}
            className="btn-secondary text-sm py-2 px-4 inline-flex items-center gap-2"
          >
            <UserPlus size={16} />
            加入现有网络
          </button>
        </div>
        <CreateNetworkDialog open={createOpen} onClose={() => setCreateOpen(false)} />
        <JoinNetworkDialog open={joinOpen} onClose={() => setJoinOpen(false)} />
      </div>
    )
  }

  // ── 已加入网络：控制面板 ─────────────────────────────────────────────
  const meshRunning = engine.status === 'running'
  const isOwner = peers.some((p) => p.roles.includes('owner'))

  return (
    <div className="h-full flex flex-col animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border">
        <div>
          <h1 className="text-base font-bold text-gray-100 tracking-tight">{network.name}</h1>
          <p className="text-[11px] text-gray-400 mt-0.5">
            {network.cidr} · {peers.length} 设备 · Lighthouse {network.lighthouseEndpoint}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isOwner && (
            <Tooltip text="生成一次性邀请码让新设备加入网络">
              <button
                type="button"
                onClick={() => setInviteOpen(true)}
                className="btn-secondary text-xs py-1.5 px-3 inline-flex items-center gap-1.5"
              >
                <UserPlus size={14} />
                邀请设备
              </button>
            </Tooltip>
          )}
          <button
            type="button"
            onClick={() => (meshRunning ? void stopEngine() : void startEngine())}
            className={clsx(
              'text-xs py-1.5 px-3 inline-flex items-center gap-1.5',
              meshRunning ? 'btn-secondary' : 'btn-primary',
            )}
          >
            <Power size={14} />
            {meshRunning ? '停止 Mesh' : '启动 Mesh'}
          </button>
        </div>
      </div>

      {/* Engine status banner */}
      <div className={clsx(
        'px-6 py-2 border-b border-border flex items-center gap-2 text-xs',
        meshRunning ? 'bg-emerald-500/5' : 'bg-surface-1',
      )}>
        <Cpu size={12} className={meshRunning ? 'text-emerald-400' : 'text-gray-500'} />
        <span className={meshRunning ? 'text-emerald-400' : 'text-gray-400'}>
          Nebula 引擎 {meshRunning ? '运行中' : '已停止'}
          {engine.pid > 0 && ` · PID ${engine.pid}`}
        </span>
        {engine.error && (
          <span className="text-rose-400 ml-2">· {engine.error}</span>
        )}
      </div>

      {/* Peers grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {peers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-400">
            <NetworkIcon className="w-10 h-10 mb-3" />
            <span className="text-sm">还没有设备</span>
            {isOwner && (
              <button
                type="button"
                onClick={() => setInviteOpen(true)}
                className="btn-primary text-xs py-1.5 px-3 mt-4 inline-flex items-center gap-1.5"
              >
                <UserPlus size={14} />
                邀请第一台设备
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {peers.map((peer) => (
              <PeerCard
                key={peer.id}
                peer={peer}
                onRevoke={() => {
                  if (confirm(`撤销「${peer.name}」？此操作不可撤销。`)) {
                    void revokePeer(peer.id)
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>

      <InvitePeerDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        defaultIp={nextAvailableIp}
      />
    </div>
  )
}

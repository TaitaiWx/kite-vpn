/**
 * 跨 Mesh 互联 section (G 功能)。
 *
 * 角色 A: 创建 bridge invite → 把 redeem_url 发给角色 B（OOB）。
 * 角色 B: 粘贴 redeem_url + 本地 peer → 后端两边自动协调，落 bridge 记录。
 *
 * v1: backend 只登记信任关系；客户端拿到 bridge 后由 mesh 模块（v1.1）
 *     在本地 Nebula firewall 加白 + 签限定 IP 证书。
 */

import { useEffect, useState } from 'react'
import { Network as NetIcon, Plus, Trash2, Workflow, Loader2, ShieldCheck } from 'lucide-react'
import { useAccountStore } from '@/stores/account'
import { toast } from '@/stores/toast'
import { Input } from '@/components/Input'
import { Tooltip } from '@/components/Tooltip'
import { SettingsSection, SettingsRow, TextInput } from '@/pages/settings-shared'
import { meshApplyBridges } from '@/lib/ipc'

const DIRECTIONS = [
  { value: 'in', label: '入站 (对方可访问本 peer)' },
  { value: 'out', label: '出站 (本 peer 可访问对方)' },
  { value: 'both', label: '双向' },
] as const

export function BridgesSection() {
  const state = useAccountStore((s) => s.state)
  const bridges = useAccountStore((s) => s.bridges)
  const loading = useAccountStore((s) => s.loading)
  const createBridgeInvite = useAccountStore((s) => s.createBridgeInvite)
  const redeemBridge = useAccountStore((s) => s.redeemBridge)
  const loadBridges = useAccountStore((s) => s.loadBridges)
  const revokeBridge = useAccountStore((s) => s.revokeBridge)

  // 创建 bridge invite 表单
  const [localPeerId, setLocalPeerId] = useState('')
  const [remoteEmailHint, setRemoteEmailHint] = useState('')
  const [direction, setDirection] = useState<string>('both')
  const [ttlHours, setTtlHours] = useState(72)

  // 赎回 redeem_url
  const [redeemUrl, setRedeemUrl] = useState('')
  const [redeemPeerId, setRedeemPeerId] = useState('')
  const [redeemCaFp, setRedeemCaFp] = useState('')

  useEffect(() => {
    if (state.loggedIn) void loadBridges()
  }, [state.loggedIn, loadBridges])

  if (!state.loggedIn) return null

  const handleCreate = async () => {
    if (!localPeerId.trim()) {
      toast('请填本地 peer（Mesh IP / cert fingerprint）', 'warning')
      return
    }
    const created = await createBridgeInvite({
      localPeerId: localPeerId.trim(),
      remoteOwnerEmailHint: remoteEmailHint.trim(),
      direction,
      ttlHours,
    })
    if (created) {
      try {
        await navigator.clipboard.writeText(created.redeemUrl)
        toast('redeem URL 已复制 — 发给对方（OOB 渠道）', 'success')
      } catch {
        toast('redeem URL 已生成，请手动复制', 'success')
      }
      setLocalPeerId('')
      setRemoteEmailHint('')
    }
  }

  const handleRedeem = async () => {
    if (!redeemUrl.trim() || !redeemPeerId.trim()) {
      toast('redeem_url 和 local_peer_id 都必填', 'warning')
      return
    }
    const result = await redeemBridge({
      redeemUrl: redeemUrl.trim(),
      localPeerId: redeemPeerId.trim(),
      localCaFingerprint: redeemCaFp.trim(),
    })
    if (result) {
      toast(`bridge 已建立 ↔ ${result.remoteOwnerEmail}`, 'success')
      setRedeemUrl('')
      setRedeemPeerId('')
      setRedeemCaFp('')
    }
  }

  return (
    <SettingsSection
      icon={<NetIcon size={16} />}
      title="跨 Mesh 互联"
      description="把自己 Mesh 的某个 peer 单独授权给另一个 Mesh —— 不打通全网"
    >
      {/* ── 创建 bridge invite (Owner A) ─────────────────────────── */}
      <SettingsRow
        label="本地 peer"
        description="自己网络里要暴露的 peer，例 100.64.0.5"
        help="只暴露这一台，其他 peer 对方仍访问不到。可以是 mesh IP 或 cert fingerprint。"
      >
        <TextInput value={localPeerId} onChange={setLocalPeerId} placeholder="100.64.0.5" className="w-40" />
      </SettingsRow>

      <SettingsRow
        label="对方邮箱（hint）"
        description="UI 提示用 — 实际安全由 bridge_token 保证"
        help="例 friend@example.com。仅作 owner 自己分辨多个 bridge invite 用，不参与验证。"
      >
        <TextInput
          value={remoteEmailHint}
          onChange={setRemoteEmailHint}
          placeholder="friend@example.com"
          className="w-56"
        />
      </SettingsRow>

      <SettingsRow
        label="方向"
        description="选择流量方向"
        help="in: 对方能访问你的 peer / out: 你的 peer 能访问对方 / both: 双向。NAS 共享通常用 in。"
      >
        <select
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
          className="text-xs py-1.5 px-2 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900"
        >
          {DIRECTIONS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
      </SettingsRow>

      <SettingsRow
        label="有效期 (小时)"
        description="超期 token 自动失效"
        help="默认 72h (3 天)，最长 720h (30 天)。"
      >
        <Input
          type="text"
          value={String(ttlHours)}
          onChange={(v) => setTtlHours(Number(v) || 72)}
          className="w-24"
        />
      </SettingsRow>

      <SettingsRow
        label="生成 redeem URL"
        description="点击生成 → URL 复制到剪贴板"
        help="redeem URL 包含 backend host + bridge_token。对方在他的 Kite 里粘进 'redeem' 框，他的 backend 会自动调你的 backend 完成协调。"
      >
        <Tooltip text="bridge_token 是 32 字节随机，过期 / 一次性。攻击者拿到 URL 但没有 owner cert 也建不起 bridge。">
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={loading}
            className="btn-primary text-xs py-1.5 px-3 inline-flex items-center gap-1"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            生成 redeem URL
          </button>
        </Tooltip>
      </SettingsRow>

      {/* ── 应用到本机 firewall ───────────────────────────────────── */}
      <SettingsRow
        label="应用到本机 Nebula 防火墙"
        description="把 active bridges 写到 config.yaml firewall 规则里"
        help="客户端会用每个 bridge 的 remote_ca_fingerprint 做 ca_sha 限定，自动放行对方 mesh CA 签发的证书过来的流量。不会自动重启 Nebula —— 用 'Mesh → 重启 Mesh' 应用。"
      >
        <Tooltip text="不会自动重启 nebula。规则落到 ~/Library/Application Support/com.kitevpn.desktop/mesh/config.yaml 和 bridges.json。">
          <button
            type="button"
            onClick={async () => {
              const r = await meshApplyBridges()
              if (r.success) toast(`已应用 ${r.data ?? 0} 条 bridge 到 firewall`, 'success')
              else toast(r.error ?? '应用失败', 'error')
            }}
            disabled={loading || bridges.length === 0}
            className="btn-secondary text-xs py-1.5 px-3 inline-flex items-center gap-1"
          >
            <ShieldCheck size={12} />
            应用 firewall 规则
          </button>
        </Tooltip>
      </SettingsRow>

      {/* ── 列出本人 bridge ──────────────────────────────────────── */}
      {bridges.length > 0 && (
        <div className="mt-2 border-t border-gray-200 dark:border-gray-700 pt-3">
          <div className="text-xs text-gray-500 mb-2">已建立的 bridge</div>
          <div className="space-y-1">
            {bridges.map((b) => (
              <div
                key={b.id}
                className="flex items-center justify-between text-xs px-3 py-2 bg-gray-50 dark:bg-gray-800/40 rounded"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="font-mono">
                    {b.localPeerId} ↔ {b.remotePeerId || '(pending)'} · {b.direction}
                  </span>
                  <span className="text-gray-500">
                    {b.status} · {b.remoteBackendUrl || '(no remote)'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void revokeBridge(b.id)}
                  disabled={loading || b.status === 'revoked'}
                  className="text-rose-400 hover:text-rose-300 disabled:opacity-30"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── 角色 B：赎回 ──────────────────────────────────────────── */}
      <div className="mt-3 border-t border-gray-200 dark:border-gray-700 pt-3">
        <div className="text-xs text-gray-500 mb-2">收到对方的 redeem URL？</div>
        <SettingsRow
          label="redeem URL"
          description="粘贴对方给你的 redeem URL"
          help="形如 https://their-backend.example.com/api/bridges/accept?token=xxx。本地 backend 会调对方 backend 完成 webhook 协调。"
          vertical
        >
          <Input
            type="text"
            value={redeemUrl}
            onChange={setRedeemUrl}
            placeholder="https://their-backend.example.com/api/bridges/accept?token=..."
            className="w-full"
          />
        </SettingsRow>
        <SettingsRow
          label="本地 peer"
          description="自己网络里要拿出来配对的 peer"
          help="例如 100.64.0.7 —— 这台 peer 会跟对方那台建立信任关系。"
        >
          <TextInput value={redeemPeerId} onChange={setRedeemPeerId} placeholder="100.64.0.7" className="w-40" />
        </SettingsRow>
        <SettingsRow
          label="本地 CA fingerprint (可选)"
          description="自己 Mesh 的 CA fingerprint，传给对方用作白名单"
          help="形如 ed25519:abc123... 。空也可以，后续 v1.1 客户端协议会自动算。"
          vertical
        >
          <div className="flex gap-2">
            <Input
              type="text"
              value={redeemCaFp}
              onChange={setRedeemCaFp}
              placeholder="ed25519:..."
              className="flex-1"
            />
            <button
              type="button"
              onClick={() => void handleRedeem()}
              disabled={loading || !redeemUrl.trim() || !redeemPeerId.trim()}
              className="btn-secondary text-xs py-1.5 px-3 inline-flex items-center gap-1"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <Workflow size={12} />}
              建立 bridge
            </button>
          </div>
        </SettingsRow>
      </div>
    </SettingsSection>
  )
}

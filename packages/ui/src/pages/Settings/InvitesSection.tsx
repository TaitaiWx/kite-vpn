/**
 * 公网邀请 section (F 功能) —— owner 视角 + 受邀人视角。
 *
 * Owner: 输入设备名 / Mesh IP / passphrase / TTL → 生成 public_url，发给受邀人。
 * 受邀人: 粘贴 public_url + passphrase → 自动下载加密 payload → 本地解密 → 加入网络。
 *
 * 设计原则 (per workspace claude.md):
 * - rule 6: 复用 SettingsRow / Input / TextInput / Tooltip 开箱即用
 * - rule 3: 每个操作都有 tooltip 解释零知识架构
 */

import { useEffect, useState } from 'react'
import { Mail, Plus, Trash2, Inbox, Loader2 } from 'lucide-react'
import { useAccountStore } from '@/stores/account'
import { toast } from '@/stores/toast'
import { Input } from '@/components/Input'
import { Tooltip } from '@/components/Tooltip'
import { SettingsSection, SettingsRow, TextInput } from '@/pages/settings-shared'

export function InvitesSection() {
  const state = useAccountStore((s) => s.state)
  const invites = useAccountStore((s) => s.invites)
  const loading = useAccountStore((s) => s.loading)
  const createInvite = useAccountStore((s) => s.createInvite)
  const loadInvites = useAccountStore((s) => s.loadInvites)
  const revokeInvite = useAccountStore((s) => s.revokeInvite)
  const consumeInvite = useAccountStore((s) => s.consumeInvite)

  // 创建 invite 表单
  const [peerName, setPeerName] = useState('')
  const [meshIp, setMeshIp] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [ttlHours, setTtlHours] = useState(168) // 7 天

  // 受邀人模式
  const [inviteUrl, setInviteUrl] = useState('')
  const [consumePassphrase, setConsumePassphrase] = useState('')

  useEffect(() => {
    if (state.loggedIn) void loadInvites()
  }, [state.loggedIn, loadInvites])

  if (!state.loggedIn) return null

  const handleCreate = async () => {
    if (!peerName.trim() || !meshIp.trim() || passphrase.length < 8) {
      toast('请填完设备名 / Mesh IP，并设置 ≥8 字符 passphrase', 'warning')
      return
    }
    const created = await createInvite({
      peerName: peerName.trim(),
      meshIp: meshIp.trim(),
      passphrase,
      ttlHours,
    })
    if (created) {
      try {
        await navigator.clipboard.writeText(created.publicUrl)
        toast(`邀请已创建，URL 已复制 ✨ 别忘了通过另一渠道发送 passphrase`, 'success')
      } catch {
        toast('邀请已创建，请手动复制 URL', 'success')
      }
      setPeerName('')
      setMeshIp('')
      setPassphrase('')
    }
  }

  const handleConsume = async () => {
    const parsed = parseInviteUrl(inviteUrl.trim())
    if (!parsed) {
      toast('URL 格式错误，应为 https://kite.example.com/invite/<slug>', 'error')
      return
    }
    if (!consumePassphrase) {
      toast('请输入 passphrase', 'warning')
      return
    }
    const result = await consumeInvite(parsed.serverUrl, parsed.slug, consumePassphrase)
    if (result) {
      toast(`已加入 ${result.networkName}（${result.meshIp}）`, 'success')
      setInviteUrl('')
      setConsumePassphrase('')
    }
  }

  return (
    <SettingsSection
      icon={<Mail size={16} />}
      title="公网邀请链接"
      description="把你的 Mesh 邀请打成短 URL —— 零知识加密，passphrase 永不上传"
    >
      {/* ── 创建邀请 ───────────────────────────────────────────────── */}
      <SettingsRow
        label="设备名称"
        description="给被邀请的那台设备起个名字（仅 hint）"
        help="UI 显示用，例 my-iphone / dad-laptop。不参与加密。"
      >
        <TextInput value={peerName} onChange={setPeerName} placeholder="my-iphone" className="w-48" />
      </SettingsRow>

      <SettingsRow
        label="Mesh 内网 IP"
        description="给新设备分配的 Mesh IP，例 100.64.0.3"
        help="必须在你 mesh 的 CIDR 内（默认 100.64.0.0/10）。已被占用的 IP 会导致路由冲突。"
      >
        <TextInput value={meshIp} onChange={setMeshIp} placeholder="100.64.0.3" className="w-40" />
      </SettingsRow>

      <SettingsRow
        label="加密 passphrase"
        description="加密 enrollment payload 用 — 务必通过另一渠道告诉受邀人"
        help="Argon2id 派生 key + AES-GCM 加密。服务端只看到 ciphertext，passphrase 永不上传。建议 ≥12 字符 + 高熵。"
        vertical
      >
        <Input
          type="password"
          value={passphrase}
          onChange={setPassphrase}
          placeholder="至少 8 字符"
          className="w-full"
        />
      </SettingsRow>

      <SettingsRow
        label="有效期（小时）"
        description="超期未消费的邀请自动失效"
        help="默认 168h（7 天）。最长 720h（30 天）。"
      >
        <Input
          type="text"
          value={String(ttlHours)}
          onChange={(v) => setTtlHours(Number(v) || 168)}
          className="w-24"
        />
      </SettingsRow>

      <SettingsRow
        label="生成"
        description="点击生成 → URL 自动复制到剪贴板"
        help="生成时客户端在本地用 nebula-cert 签新证书 + Argon2id KDF + AES-GCM 加密，上传到 backend。原始私钥立即从你的设备删除。"
      >
        <Tooltip text="生成后 passphrase 务必通过另一渠道（IM / 当面）告诉对方。同渠道发 = 失去零知识保护。">
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={loading}
            className="btn-primary text-xs py-1.5 px-3 inline-flex items-center gap-1"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            生成邀请
          </button>
        </Tooltip>
      </SettingsRow>

      {/* ── 列出已发邀请 ───────────────────────────────────────────── */}
      {invites.length > 0 && (
        <div className="mt-2 border-t border-gray-200 dark:border-gray-700 pt-3">
          <div className="text-xs text-gray-500 mb-2">已发出的邀请</div>
          <div className="space-y-1">
            {invites.map((inv) => (
              <div
                key={inv.slug}
                className="flex items-center justify-between text-xs px-3 py-2 bg-gray-50 dark:bg-gray-800/40 rounded"
              >
                <div className="flex flex-col">
                  <span className="font-mono">{inv.slug}</span>
                  <span className="text-gray-500">
                    {inv.peerNameHint || '(no hint)'} ·{' '}
                    {inv.consumedAt
                      ? `已消费 (${inv.consumerEmail || 'anon'})`
                      : `${Math.max(0, Math.floor((inv.expiresAt - Date.now()) / 3600000))}h 后过期`}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void revokeInvite(inv.slug)}
                  disabled={loading || inv.consumedAt !== null}
                  className="text-rose-400 hover:text-rose-300 disabled:opacity-30"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── 受邀人：消费 invite URL ───────────────────────────────── */}
      <div className="mt-3 border-t border-gray-200 dark:border-gray-700 pt-3">
        <div className="text-xs text-gray-500 mb-2">收到别人的邀请？</div>
        <SettingsRow
          label="邀请 URL"
          description="粘贴形如 https://kite.example.com/invite/ABC123 的链接"
          help="该 URL 是公网可访问的落地页。passphrase 永远不在 URL 里，而是通过另一渠道（IM / 当面）告诉你。"
          vertical
        >
          <Input
            type="text"
            value={inviteUrl}
            onChange={setInviteUrl}
            placeholder="https://kite.example.com/invite/ABC123"
            className="w-full"
          />
        </SettingsRow>
        <SettingsRow
          label="passphrase"
          description="发邀请的人通过另一渠道告诉你的"
          help="客户端用同款 Argon2id KDF + AES-GCM 解密 enrollment payload，本地写 cert + key。Backend 看不到明文。"
          vertical
        >
          <div className="flex gap-2">
            <Input
              type="password"
              value={consumePassphrase}
              onChange={setConsumePassphrase}
              placeholder="passphrase"
              className="flex-1"
            />
            <button
              type="button"
              onClick={() => void handleConsume()}
              disabled={loading || !inviteUrl.trim() || !consumePassphrase}
              className="btn-secondary text-xs py-1.5 px-3 inline-flex items-center gap-1"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <Inbox size={12} />}
              加入网络
            </button>
          </div>
        </SettingsRow>
      </div>
    </SettingsSection>
  )
}

// ─── 辅助 ─────────────────────────────────────────────────────────────────

function parseInviteUrl(url: string): { serverUrl: string; slug: string } | null {
  try {
    const u = new URL(url)
    const match = u.pathname.match(/^\/invite\/([A-Z2-9]+)\/?$/i)
    if (!match) return null
    const serverUrl = `${u.protocol}//${u.host}`
    return { serverUrl, slug: match[1]! }
  } catch {
    return null
  }
}

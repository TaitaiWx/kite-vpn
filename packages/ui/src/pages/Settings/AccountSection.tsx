/**
 * 账户 section（Settings 页内）—— Phase 5 backend 集成 UI。
 *
 * 三个状态:
 *  - 未配置后端 URL: 引导用户填后端地址
 *  - 已配置但未登录: magic link 流程
 *  - 已登录: 显示当前 email + 备份/恢复 CA / 登出
 *
 * 设计原则（per workspace claude.md）:
 * - rule 6: 复用 Settings 的 ToggleSwitch / SettingsRow / TextInput / Input
 * - rule 3: 每个操作都有 tooltip 解释零知识架构
 */

import { useEffect, useState } from 'react'
import { UserCircle, LogIn, LogOut, Cloud, CloudDownload, KeyRound, Loader2 } from 'lucide-react'
import { useAccountStore } from '@/stores/account'
import { toast } from '@/stores/toast'
import { Input } from '@/components/Input'
import { Tooltip } from '@/components/Tooltip'
import { SettingsSection, SettingsRow, TextInput } from '@/pages/settings-shared'

export function AccountSection() {
  const state = useAccountStore((s) => s.state)
  const loading = useAccountStore((s) => s.loading)
  const lastError = useAccountStore((s) => s.lastError)
  const refresh = useAccountStore((s) => s.refresh)
  const setServer = useAccountStore((s) => s.setServer)
  const requestLogin = useAccountStore((s) => s.requestLogin)
  const verifyLogin = useAccountStore((s) => s.verifyLogin)
  const logout = useAccountStore((s) => s.logout)
  const backupCaKey = useAccountStore((s) => s.backupCaKey)
  const restoreCaKey = useAccountStore((s) => s.restoreCaKey)

  const [serverDraft, setServerDraft] = useState('')
  const [emailDraft, setEmailDraft] = useState('')
  const [tokenDraft, setTokenDraft] = useState('')
  const [backupPassphrase, setBackupPassphrase] = useState('')
  const [restorePassphrase, setRestorePassphrase] = useState('')
  const [magicLinkSent, setMagicLinkSent] = useState(false)

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (state.serverUrl && !serverDraft) setServerDraft(state.serverUrl)
    if (state.email && !emailDraft) setEmailDraft(state.email)
  }, [state, serverDraft, emailDraft])

  const handleSetServer = async () => {
    const ok = await setServer(serverDraft)
    if (ok) toast('后端地址已保存', 'success')
    else toast(useAccountStore.getState().lastError || '保存失败', 'error')
  }

  const handleRequestLogin = async () => {
    if (!emailDraft.trim()) {
      toast('请填写邮箱', 'warning')
      return
    }
    const ok = await requestLogin(emailDraft.trim())
    if (ok) {
      setMagicLinkSent(true)
      toast('登录邮件已发出 —— 邮箱里拿到 token 后粘贴下方', 'success')
    } else {
      toast(useAccountStore.getState().lastError || '发邮件失败', 'error')
    }
  }

  const handleVerifyToken = async () => {
    if (!tokenDraft.trim()) {
      toast('请粘贴邮件里的 token', 'warning')
      return
    }
    const ok = await verifyLogin(tokenDraft.trim())
    if (ok) {
      setMagicLinkSent(false)
      setTokenDraft('')
      toast('登录成功 ✨', 'success')
    } else {
      toast(useAccountStore.getState().lastError || 'token 验证失败', 'error')
    }
  }

  const handleLogout = async () => {
    await logout()
    toast('已登出', 'info')
  }

  const handleBackup = async () => {
    if (backupPassphrase.length < 8) {
      toast('passphrase 至少 8 字符', 'warning')
      return
    }
    const summary = await backupCaKey(backupPassphrase)
    if (summary) {
      toast(`CA 私钥已加密备份（${summary.bytes} 字节）`, 'success')
      setBackupPassphrase('')
    } else {
      toast(useAccountStore.getState().lastError || '备份失败', 'error')
    }
  }

  const handleRestore = async () => {
    if (!restorePassphrase) {
      toast('请输入备份时设的 passphrase', 'warning')
      return
    }
    if (!confirm('确定恢复 CA 私钥？这会覆盖本机现有的 ca.key 文件。')) return
    const ok = await restoreCaKey(restorePassphrase)
    if (ok) {
      toast('CA 私钥已恢复到本机', 'success')
      setRestorePassphrase('')
    } else {
      toast(useAccountStore.getState().lastError || '恢复失败', 'error')
    }
  }

  // ─── 渲染 ─────────────────────────────────────────────────────────────

  return (
    <SettingsSection
      icon={<UserCircle size={16} />}
      title="账户"
      description="Kite Backend — 零知识备份 + 跨设备同步"
    >
      {/* 后端地址 */}
      <SettingsRow
        label="后端地址"
        description={state.serverUrl ? `当前: ${state.serverUrl}` : '尚未配置 —— 部署 kite-backend 后填这里'}
        help="你的 Kite Backend 公网地址（https://...）。Backend 用零知识架构：你的 passphrase 永远不上传，服务端只保存加密 blob，被黑也解不出明文。部署: apps/backend/deploy.sh"
        vertical
      >
        <div className="flex gap-2">
          <TextInput
            value={serverDraft}
            onChange={setServerDraft}
            placeholder="https://kite.example.com"
            className="flex-1"
          />
          <button
            type="button"
            onClick={() => void handleSetServer()}
            disabled={loading || !serverDraft.trim()}
            className="btn-primary text-xs py-1.5 px-3"
          >
            保存
          </button>
        </div>
      </SettingsRow>

      {state.serverUrl && !state.loggedIn && (
        <>
          {/* 登录 */}
          <SettingsRow
            label="邮箱"
            description={magicLinkSent ? '已发邮件，去邮箱拿 token' : '用 magic link 登录，无密码'}
            help="Kite Backend 不存密码 —— 每次登录由邮件触发一次性 token，10 分钟有效。这是 Slack / Notion / Vercel 都在用的无密码方案。"
            vertical
          >
            <div className="flex gap-2">
              <Input
                type="text"
                value={emailDraft}
                onChange={setEmailDraft}
                placeholder="you@example.com"
                className="flex-1"
              />
              <button
                type="button"
                onClick={() => void handleRequestLogin()}
                disabled={loading || !emailDraft.trim()}
                className="btn-secondary text-xs py-1.5 px-3 inline-flex items-center gap-1"
              >
                {loading ? <Loader2 size={12} className="animate-spin" /> : <LogIn size={12} />}
                发送链接
              </button>
            </div>
          </SettingsRow>

          {magicLinkSent && (
            <SettingsRow
              label="粘贴 token"
              description="从邮件里复制 ?token=xxx 后面那一串"
              help="后端发的邮件里有个 magic link，例: https://kite.example.com/auth/verify?token=ABCD1234。把 token 参数的值（即 ABCD1234）复制粘贴到这里。"
              vertical
            >
              <div className="flex gap-2">
                <Input
                  type="text"
                  value={tokenDraft}
                  onChange={setTokenDraft}
                  placeholder="ABCD..."
                  className="flex-1"
                />
                <button
                  type="button"
                  onClick={() => void handleVerifyToken()}
                  disabled={loading || !tokenDraft.trim()}
                  className="btn-primary text-xs py-1.5 px-3"
                >
                  验证
                </button>
              </div>
            </SettingsRow>
          )}
        </>
      )}

      {state.loggedIn && (
        <>
          <SettingsRow
            label="当前账户"
            description={state.email}
            help="已登录到 Kite Backend。session 30 天有效，过期重新走 magic link。"
          >
            <Tooltip text="登出会清除本机 session cookie，并通知后端把当前 user 所有 session 失效。本机已下载的 CA 备份不会删。">
              <button
                type="button"
                onClick={() => void handleLogout()}
                disabled={loading}
                className="btn-secondary text-xs py-1.5 px-3 inline-flex items-center gap-1"
              >
                <LogOut size={12} />
                登出
              </button>
            </Tooltip>
          </SettingsRow>

          {/* 备份 CA */}
          <SettingsRow
            label="备份 CA 私钥"
            description="设 passphrase 后，CA 私钥本地加密 → 上传到后端"
            help="【重要】CA 私钥是 Mesh 网络的根权限，丢了网络就锁死。备份流程：你设个 passphrase，Kite 在本地用 Argon2id(passphrase)=key + AES-256-GCM(key)=ciphertext，只把 ciphertext 上传。服务端绝对解不开。passphrase 自己记好，丢了就解不回来了。"
            vertical
          >
            <div className="flex gap-2">
              <Input
                type="password"
                value={backupPassphrase}
                onChange={setBackupPassphrase}
                placeholder="至少 8 字符的 passphrase"
                className="flex-1"
              />
              <button
                type="button"
                onClick={() => void handleBackup()}
                disabled={loading || backupPassphrase.length < 8}
                className="btn-primary text-xs py-1.5 px-3 inline-flex items-center gap-1"
              >
                {loading ? <Loader2 size={12} className="animate-spin" /> : <Cloud size={12} />}
                上传
              </button>
            </div>
          </SettingsRow>

          {/* 恢复 CA */}
          <SettingsRow
            label="恢复 CA 私钥"
            description="新机器换机用：输入同一个 passphrase 把 CA 拉回本地"
            help="只在新设备需要 —— 用备份时设的同一个 passphrase。Kite 下载 ciphertext + salt，本地 Argon2id 还原 key 解 AES，把 ca.key 写回。从此你的新设备就有 owner 权限了。"
            vertical
          >
            <div className="flex gap-2">
              <Input
                type="password"
                value={restorePassphrase}
                onChange={setRestorePassphrase}
                placeholder="备份时设的 passphrase"
                className="flex-1"
              />
              <button
                type="button"
                onClick={() => void handleRestore()}
                disabled={loading || !restorePassphrase}
                className="btn-secondary text-xs py-1.5 px-3 inline-flex items-center gap-1"
              >
                {loading ? <Loader2 size={12} className="animate-spin" /> : <CloudDownload size={12} />}
                下载并解密
              </button>
            </div>
          </SettingsRow>

          <SettingsRow
            label="安全提示"
            description="CA 私钥是 Mesh 的根权限 — 务必记好 passphrase"
            help="passphrase 没法 reset —— Kite 后端绝对不知道它。建议：写在 1Password / Bitwarden 里，或者抄一份放保险柜。"
          >
            <KeyRound size={16} className="text-amber-400" />
          </SettingsRow>
        </>
      )}

      {lastError && (
        <div className="mt-3 px-3 py-2 bg-rose-500/10 border border-rose-500/30 rounded-md text-xs text-rose-400">
          {lastError}
        </div>
      )}
    </SettingsSection>
  )
}

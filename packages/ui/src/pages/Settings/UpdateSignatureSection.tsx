/**
 * 更新签名验证 section —— 展示 backend transport pubkey 状态 + 手动验签。
 *
 * Tauri 自带 updater 验 .tar.gz minisign。这套是补充的"latest.json"层验签：
 * 防止 backend cache / 中间人篡改元数据（比如改 URL 指向恶意 binary）。
 */

import { useEffect } from 'react'
import { ShieldCheck, RefreshCw, KeySquare, Loader2 } from 'lucide-react'
import { useAccountStore } from '@/stores/account'
import { toast } from '@/stores/toast'
import { SettingsSection, SettingsRow } from '@/pages/settings-shared'

export function UpdateSignatureSection() {
  const state = useAccountStore((s) => s.state)
  const updatePubkey = useAccountStore((s) => s.updatePubkey)
  const lastUpdateCheck = useAccountStore((s) => s.lastUpdateCheck)
  const loading = useAccountStore((s) => s.loading)
  const fetchUpdatePubkey = useAccountStore((s) => s.fetchUpdatePubkey)
  const checkUpdateSigned = useAccountStore((s) => s.checkUpdateSigned)

  useEffect(() => {
    // 登录且尚未缓存 pubkey 时，自动拉一次
    if (state.loggedIn && !updatePubkey) {
      void fetchUpdatePubkey()
    }
  }, [state.loggedIn, updatePubkey, fetchUpdatePubkey])

  if (!state.serverUrl) return null

  const handleFetchPubkey = async () => {
    const info = await fetchUpdatePubkey()
    if (info) toast('已缓存 backend update pubkey', 'success')
  }

  const handleCheckSigned = async () => {
    const result = await checkUpdateSigned()
    if (!result) return
    if (result.signatureValid) {
      toast('latest.json 签名验证通过 ✅', 'success')
    } else if (!result.pubkeyCached) {
      toast('本机没缓存 backend pubkey —— 先点 "拉取 pubkey"', 'warning')
    } else {
      toast('⚠️ 签名验证失败 —— backend 响应可能被篡改！客户端会自动回落到 GitHub fallback。', 'error')
    }
  }

  const pubkeyShort = updatePubkey ? `${updatePubkey.slice(0, 16)}...${updatePubkey.slice(-8)}` : '(未缓存)'

  return (
    <SettingsSection
      icon={<ShieldCheck size={16} />}
      title="更新签名验证"
      description="ed25519 transport 签名 —— 防 backend cache 被篡改"
    >
      <SettingsRow
        label="Backend transport pubkey"
        description={pubkeyShort}
        help="backend 启动时生成的 ed25519 公钥（base64），首次登录后自动 fetch 缓存到本机 account.json。每次响应 /api/updates/latest.json 都附 X-Kite-Signature header，客户端用此 pubkey 验签。"
      >
        <button
          type="button"
          onClick={() => void handleFetchPubkey()}
          disabled={loading}
          className="btn-secondary text-xs py-1.5 px-3 inline-flex items-center gap-1"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <KeySquare size={12} />}
          重新拉取 pubkey
        </button>
      </SettingsRow>

      <SettingsRow
        label="测试签名验证"
        description={
          lastUpdateCheck
            ? `${lastUpdateCheck.signatureValid ? '✅ 通过' : '❌ 失败'} · ${
                lastUpdateCheck.fromCache ? 'backend cache HIT' : 'fresh'
              }`
            : '点击下面按钮试一次'
        }
        help="拉一次 backend /api/updates/latest.json，验签结果会显示在 toast 里。签名不通过不代表更新有问题（Tauri 还有第二层 minisign 验签），但说明 backend transport 层不可信，应该回落 GitHub。"
      >
        <button
          type="button"
          onClick={() => void handleCheckSigned()}
          disabled={loading}
          className="btn-primary text-xs py-1.5 px-3 inline-flex items-center gap-1"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          验签一次
        </button>
      </SettingsRow>
    </SettingsSection>
  )
}

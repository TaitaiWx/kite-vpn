/**
 * Account store — Phase 5 backend 集成。
 *
 * 管理本地账户状态: 后端 URL / 当前 email / session 状态。
 * 加密 / 解密在 Rust 侧做（passphrase 永不离开 Rust 内存）。
 *
 * 设计原则（per workspace claude.md）:
 * - 禁用 `?`: 未配置时 serverUrl='' email=''（显式空字符串）
 */

import { create } from 'zustand'
import type {
  AccountState,
  BackupSummary,
  CreateInviteRequest,
  CreatedInvite,
  InviteRow,
  ConsumedInvite,
  CreateBridgeInviteRequest,
  CreatedBridgeInvite,
  RedeemBridgeRequest,
  RedeemedBridge,
  BridgeRow,
  UpdatePubkeyInfo,
  SignedUpdateCheck,
} from '@/lib/ipc'
import {
  accountGetState,
  accountSetServer,
  accountRequestLogin,
  accountRememberEmail,
  accountVerifyLogin,
  accountLogout,
  accountBackupCaKey,
  accountRestoreCaKey,
  accountCreateInvite,
  accountListInvites,
  accountRevokeInvite,
  accountConsumeInvite,
  accountCreateBridgeInvite,
  accountRedeemBridge,
  accountListBridges,
  accountRevokeBridge,
  accountFetchUpdatePubkey,
  accountCheckUpdateSigned,
} from '@/lib/ipc'

interface AccountStore {
  state: AccountState
  loading: boolean
  lastError: string

  invites: InviteRow[]
  bridges: BridgeRow[]
  updatePubkey: string
  lastUpdateCheck: SignedUpdateCheck | null

  refresh: () => Promise<void>
  setServer: (url: string) => Promise<boolean>
  requestLogin: (email: string) => Promise<boolean>
  verifyLogin: (token: string) => Promise<boolean>
  logout: () => Promise<void>
  backupCaKey: (passphrase: string) => Promise<BackupSummary | null>
  restoreCaKey: (passphrase: string) => Promise<boolean>

  // F: 公网邀请
  createInvite: (request: CreateInviteRequest) => Promise<CreatedInvite | null>
  loadInvites: () => Promise<void>
  revokeInvite: (slug: string) => Promise<boolean>
  consumeInvite: (serverUrl: string, slug: string, passphrase: string) => Promise<ConsumedInvite | null>

  // G: 跨 Mesh
  createBridgeInvite: (request: CreateBridgeInviteRequest) => Promise<CreatedBridgeInvite | null>
  redeemBridge: (request: RedeemBridgeRequest) => Promise<RedeemedBridge | null>
  loadBridges: () => Promise<void>
  revokeBridge: (id: string) => Promise<boolean>

  // 更新签名验证
  fetchUpdatePubkey: () => Promise<UpdatePubkeyInfo | null>
  checkUpdateSigned: () => Promise<SignedUpdateCheck | null>
}

const INITIAL_STATE: AccountState = {
  serverUrl: '',
  email: '',
  loggedIn: false,
}

export const useAccountStore = create<AccountStore>()((set, get) => ({
  state: INITIAL_STATE,
  loading: false,
  lastError: '',
  invites: [],
  bridges: [],
  updatePubkey: '',
  lastUpdateCheck: null,

  refresh: async () => {
    const result = await accountGetState()
    if (result.success && result.data) {
      set({ state: result.data, lastError: '' })
    }
  },

  setServer: async (url) => {
    set({ loading: true, lastError: '' })
    const result = await accountSetServer(url)
    set({ loading: false })
    if (result.success && result.data) {
      set({ state: result.data })
      return true
    }
    set({ lastError: result.error ?? '配置后端失败' })
    return false
  },

  requestLogin: async (email) => {
    set({ loading: true, lastError: '' })
    const remember = await accountRememberEmail(email)
    if (!remember.success) {
      set({ loading: false, lastError: remember.error ?? '保存邮箱失败' })
      return false
    }
    const result = await accountRequestLogin(email)
    set({ loading: false })
    if (result.success) {
      await get().refresh()
      return true
    }
    set({ lastError: result.error ?? '请求邮件失败' })
    return false
  },

  verifyLogin: async (token) => {
    set({ loading: true, lastError: '' })
    const result = await accountVerifyLogin(token)
    set({ loading: false })
    if (result.success && result.data) {
      set({ state: result.data })
      return true
    }
    set({ lastError: result.error ?? '验证 token 失败' })
    return false
  },

  logout: async () => {
    set({ loading: true })
    await accountLogout()
    set({ loading: false })
    await get().refresh()
  },

  backupCaKey: async (passphrase) => {
    set({ loading: true, lastError: '' })
    const result = await accountBackupCaKey(passphrase)
    set({ loading: false })
    if (result.success && result.data) {
      return result.data
    }
    set({ lastError: result.error ?? '备份失败' })
    return null
  },

  restoreCaKey: async (passphrase) => {
    set({ loading: true, lastError: '' })
    const result = await accountRestoreCaKey(passphrase)
    set({ loading: false })
    if (result.success) return true
    set({ lastError: result.error ?? '恢复失败' })
    return false
  },

  // ─── F: 公网邀请 ──────────────────────────────────────────────────────

  createInvite: async (request) => {
    set({ loading: true, lastError: '' })
    const result = await accountCreateInvite(request)
    set({ loading: false })
    if (result.success && result.data) {
      void get().loadInvites()
      return result.data
    }
    set({ lastError: result.error ?? '创建邀请失败' })
    return null
  },

  loadInvites: async () => {
    const result = await accountListInvites()
    if (result.success && result.data) {
      set({ invites: result.data })
    }
  },

  revokeInvite: async (slug) => {
    set({ loading: true, lastError: '' })
    const result = await accountRevokeInvite(slug)
    set({ loading: false })
    if (result.success) {
      void get().loadInvites()
      return true
    }
    set({ lastError: result.error ?? '撤销失败' })
    return false
  },

  consumeInvite: async (serverUrl, slug, passphrase) => {
    set({ loading: true, lastError: '' })
    const result = await accountConsumeInvite(serverUrl, slug, passphrase)
    set({ loading: false })
    if (result.success && result.data) return result.data
    set({ lastError: result.error ?? '消费邀请失败' })
    return null
  },

  // ─── G: 跨 Mesh ───────────────────────────────────────────────────────

  createBridgeInvite: async (request) => {
    set({ loading: true, lastError: '' })
    const result = await accountCreateBridgeInvite(request)
    set({ loading: false })
    if (result.success && result.data) {
      void get().loadBridges()
      return result.data
    }
    set({ lastError: result.error ?? '创建 bridge invite 失败' })
    return null
  },

  redeemBridge: async (request) => {
    set({ loading: true, lastError: '' })
    const result = await accountRedeemBridge(request)
    set({ loading: false })
    if (result.success && result.data) {
      void get().loadBridges()
      return result.data
    }
    set({ lastError: result.error ?? '赎回 bridge 失败' })
    return null
  },

  loadBridges: async () => {
    const result = await accountListBridges()
    if (result.success && result.data) {
      set({ bridges: result.data })
    }
  },

  revokeBridge: async (id) => {
    set({ loading: true, lastError: '' })
    const result = await accountRevokeBridge(id)
    set({ loading: false })
    if (result.success) {
      void get().loadBridges()
      return true
    }
    set({ lastError: result.error ?? '撤销 bridge 失败' })
    return false
  },

  // ─── 更新签名验证 ─────────────────────────────────────────────────────

  fetchUpdatePubkey: async () => {
    const result = await accountFetchUpdatePubkey()
    if (result.success && result.data) {
      set({ updatePubkey: result.data.pubkeyB64 })
      return result.data
    }
    set({ lastError: result.error ?? '拿 update pubkey 失败' })
    return null
  },

  checkUpdateSigned: async () => {
    const result = await accountCheckUpdateSigned()
    if (result.success && result.data) {
      set({ lastUpdateCheck: result.data })
      return result.data
    }
    set({ lastError: result.error ?? '检查更新失败' })
    return null
  },
}))

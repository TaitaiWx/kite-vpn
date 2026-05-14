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
import type { AccountState, BackupSummary } from '@/lib/ipc'
import {
  accountGetState,
  accountSetServer,
  accountRequestLogin,
  accountRememberEmail,
  accountVerifyLogin,
  accountLogout,
  accountBackupCaKey,
  accountRestoreCaKey,
} from '@/lib/ipc'

interface AccountStore {
  state: AccountState
  loading: boolean
  lastError: string

  refresh: () => Promise<void>
  setServer: (url: string) => Promise<boolean>
  requestLogin: (email: string) => Promise<boolean>
  verifyLogin: (token: string) => Promise<boolean>
  logout: () => Promise<void>
  backupCaKey: (passphrase: string) => Promise<BackupSummary | null>
  restoreCaKey: (passphrase: string) => Promise<boolean>
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
}))

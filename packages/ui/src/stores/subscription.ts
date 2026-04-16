import { create } from 'zustand'
import type { Subscription, SubscriptionStatus, SubscriptionUserInfo, MergeStrategy } from '@kite-vpn/types'
import {
  saveSubscriptions as ipcSave,
  loadSubscriptions as ipcLoad,
  writeConfig as ipcWriteConfig,
  fetchRemoteSubscription,
  mihomoReloadConfig,
} from '@/lib/ipc'
import {
  parseSubscriptionContent,
  mergeSubscriptions,
  generateMihomoConfig,
  generateId,
  DEFAULT_ENGINE_CONFIG,
  DEFAULT_RULES,
  generateAppRuleProviders,
  generateAppRules,
  generateAppProxyGroups,
} from '@kite-vpn/core'
import type { ProxyGroupConfig } from '@kite-vpn/types'
import { toast } from '@/stores/toast'

// ---------------------------------------------------------------------------
// Store 类型
// ---------------------------------------------------------------------------

interface SubscriptionStore {
  subscriptions: Subscription[]
  loaded: boolean
  updatingAll: boolean
  hasRealData: boolean
  mergeStrategy: MergeStrategy

  load: () => Promise<void>
  persist: () => Promise<void>

  addSubscription: (name: string, url: string) => Promise<void>
  removeSubscription: (id: string) => Promise<void>
  updateSubscription: (id: string, patch: Partial<Pick<Subscription, 'name' | 'url' | 'updateIntervalHours'>>) => void
  toggleSubscription: (id: string) => void
  setSubscriptionStatus: (id: string, status: SubscriptionStatus, error?: string) => void

  refreshSubscription: (id: string) => Promise<void>
  refreshAll: () => Promise<void>
  applyConfig: () => Promise<void>
}

// ---------------------------------------------------------------------------
// userinfo header 解析
// ---------------------------------------------------------------------------

function parseUserInfoHeader(header: string): SubscriptionUserInfo | undefined {
  const map = new Map<string, string>()
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    const key = pair.slice(0, eq).trim()
    const val = pair.slice(eq + 1).trim()
    if (key && val) map.set(key, val)
  }
  const upload = Number(map.get('upload')) || 0
  const download = Number(map.get('download')) || 0
  const total = Number(map.get('total')) || 0
  const expireStr = map.get('expire')
  const expire = expireStr ? new Date(Number(expireStr) * 1000) : undefined
  return { upload, download, total, expire }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSubscriptionStore = create<SubscriptionStore>()((set, get) => ({
  subscriptions: [],
  loaded: false,
  updatingAll: false,
  hasRealData: false,
  mergeStrategy: {
    deduplication: 'by_server',
    nameConflict: 'rename',
    groupBy: 'region',
    regionGroupMode: 'url-test',
    excludePatterns: [],
    includePatterns: [],
    renameRules: [],
  },

  load: async () => {
    if (get().loaded) return
    const result = await ipcLoad()
    const real = (result.success && result.data) ? result.data : []
    set({ subscriptions: real, loaded: true, hasRealData: real.length > 0 })
  },

  persist: async () => {
    const { subscriptions } = get()
    await ipcSave(subscriptions)
  },

  addSubscription: async (name, url) => {
    const newSub: Subscription = {
      id: generateId(), name, url, enabled: true,
      nodes: [], updateIntervalHours: 12, status: 'idle',
    }
    set((s) => ({ subscriptions: [...s.subscriptions, newSub], hasRealData: true }))
    await get().persist()
    await get().refreshSubscription(newSub.id)
  },

  removeSubscription: async (id) => {
    set((s) => ({ subscriptions: s.subscriptions.filter((sub) => sub.id !== id) }))
    await get().persist()
  },

  updateSubscription: (id, patch) => {
    set((s) => ({
      subscriptions: s.subscriptions.map((sub) =>
        sub.id === id ? { ...sub, ...patch } : sub,
      ),
    }))
    void get().persist()
  },

  toggleSubscription: (id) => {
    set((s) => ({
      subscriptions: s.subscriptions.map((sub) =>
        sub.id === id ? { ...sub, enabled: !sub.enabled } : sub,
      ),
    }))
    void get().persist()
  },

  setSubscriptionStatus: (id, status, error) =>
    set((s) => ({
      subscriptions: s.subscriptions.map((sub) =>
        sub.id === id
          ? {
              ...sub, status,
              error: error ?? (status === 'success' ? undefined : sub.error),
              ...(status === 'success' ? { lastUpdate: new Date() } : {}),
            }
          : sub,
      ),
    })),

  // 通过 Rust IPC 拉取（无 CORS），然后用 core 解析
  refreshSubscription: async (id) => {
    const { subscriptions, setSubscriptionStatus, persist } = get()
    const sub = subscriptions.find((s) => s.id === id)
    if (!sub) return

    setSubscriptionStatus(id, 'updating')

    const result = await fetchRemoteSubscription(sub.url)
    if (!result.success || !result.data) {
      const msg = result.error ?? '拉取失败'
      setSubscriptionStatus(id, 'error', msg)
      toast(`${sub.name}: ${msg}`, 'error')
      return
    }

    try {
      const nodes = parseSubscriptionContent(result.data.content)
      const userInfo = result.data.user_info
        ? parseUserInfoHeader(result.data.user_info)
        : undefined

      set((s) => ({
        subscriptions: s.subscriptions.map((item) =>
          item.id === id
            ? {
                ...item, nodes,
                status: 'success' as const,
                lastUpdate: new Date(),
                error: undefined,
                userInfo: userInfo ?? item.userInfo,
                updateIntervalHours: result.data!.update_interval ?? item.updateIntervalHours,
              }
            : item,
        ),
      }))

      toast(`${sub.name}: 更新成功，${nodes.length} 个节点`, 'success')
      await persist()
    } catch (e) {
      const msg = e instanceof Error ? e.message : '解析失败'
      setSubscriptionStatus(id, 'error', msg)
      toast(`${sub.name}: ${msg}`, 'error')
    }
  },

  refreshAll: async () => {
    const { subscriptions, refreshSubscription } = get()
    set({ updatingAll: true })

    const enabled = subscriptions.filter((s) => s.enabled)
    const concurrency = 3
    for (let i = 0; i < enabled.length; i += concurrency) {
      const batch = enabled.slice(i, i + concurrency)
      await Promise.allSettled(batch.map((s) => refreshSubscription(s.id)))
    }

    set({ updatingAll: false })
    await get().applyConfig()
  },

  applyConfig: async () => {
    const { subscriptions, mergeStrategy } = get()
    const enabledSubs = subscriptions.filter((s) => s.enabled && s.nodes.length > 0)
    if (enabledSubs.length === 0) return

    const mergeResult = mergeSubscriptions(
      enabledSubs.map((s) => ({ sourceId: s.id, sourceName: s.name, nodes: s.nodes })),
      mergeStrategy,
    )

    // 生成 app 分类规则（参照 ClashConfigProxy）
    const nodeNames = mergeResult.nodes.map((n) => n.name)
    const appGroups: ProxyGroupConfig[] = generateAppProxyGroups(nodeNames)
    const appRules = generateAppRules()
    const appRuleProviders = generateAppRuleProviders()

    // 合并分组：merger 生成的区域分组 + app 分类分组
    const allGroups = [...mergeResult.groups, ...appGroups]

    // 合并规则：app 规则在前（优先级高），通用规则在后
    const allRules = [...appRules, ...DEFAULT_RULES]

    const yaml = generateMihomoConfig({
      engineConfig: DEFAULT_ENGINE_CONFIG,
      nodes: mergeResult.nodes,
      groups: allGroups,
      rules: allRules,
      ruleProviders: appRuleProviders,
    })

    const writeResult = await ipcWriteConfig(yaml)
    if (!writeResult.success) {
      toast(`写入配置失败: ${writeResult.error ?? '未知错误'}`, 'error')
      return
    }

    // 写入成功后通知 mihomo 重载配置（如果引擎在运行）
    const reloadResult = await mihomoReloadConfig(writeResult.data ?? undefined)
    if (reloadResult.success) {
      toast(`配置已应用：${mergeResult.nodes.length} 个节点，${mergeResult.groups.length} 个分组`, 'success')
    } else {
      toast(`配置已写入，但引擎重载失败（引擎可能未启动）`, 'warning')
    }
  },
}))

// ── 订阅自动刷新 timer ──
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null

export function startAutoRefresh() {
  if (autoRefreshTimer) return
  autoRefreshTimer = setInterval(() => {
    const { subscriptions, refreshSubscription } = useSubscriptionStore.getState()
    const now = Date.now()
    for (const sub of subscriptions) {
      if (!sub.enabled || sub.status === 'updating') continue
      const lastMs = sub.lastUpdate ? new Date(sub.lastUpdate).getTime() : 0
      const intervalMs = (sub.updateIntervalHours || 12) * 3600_000
      if (now - lastMs > intervalMs) {
        void refreshSubscription(sub.id)
      }
    }
  }, 60_000) // 每分钟检查一次
}

export function stopAutoRefresh() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null }
}

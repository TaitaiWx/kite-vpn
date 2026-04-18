import { create } from 'zustand'
import type { EngineState, TrafficStats, ProxyMode } from '@kite-vpn/types'
import {
  engineStart as ipcEngineStart,
  engineStop as ipcEngineStop,
  engineRestart as ipcEngineRestart,
  engineGetState as ipcGetState,
  setProxyMode as ipcSetMode,
  enableSystemProxy as ipcEnableProxy,
  disableSystemProxy as ipcDisableProxy,
  getSystemProxyStatus as ipcProxyStatus,
  mihomoGetVersion,
} from '@/lib/ipc'

// ---------------------------------------------------------------------------
// Store 类型
// ---------------------------------------------------------------------------

export interface TrafficSnapshot {
  time: number
  up: number
  down: number
}

interface EngineStore {
  state: EngineState
  traffic: TrafficStats
  mode: ProxyMode
  systemProxy: boolean
  trafficHistory: TrafficSnapshot[]
  watchdogTimer: ReturnType<typeof setInterval> | null

  setState: (state: EngineState) => void
  setTraffic: (traffic: TrafficStats) => void
  tickUptime: (delta: number) => void

  startEngine: () => Promise<void>
  stopEngine: () => Promise<void>
  restartEngine: () => Promise<void>
  fetchState: () => Promise<void>
  changeMode: (mode: ProxyMode) => Promise<void>
  toggleSystemProxy: () => Promise<void>
  fetchSystemProxyStatus: () => Promise<void>
  startWatchdog: () => void
  stopWatchdog: () => void
}

const MAX_HISTORY = 60

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useEngineStore = create<EngineStore>()((set, get) => ({
  state: { status: 'stopped' },
  traffic: { uploadSpeed: 0, downloadSpeed: 0, uploadTotal: 0, downloadTotal: 0, activeConnections: 0 },
  mode: 'rule',
  systemProxy: false,
  trafficHistory: [],
  watchdogTimer: null,

  setState: (state) => set({ state }),

  setTraffic: (traffic) =>
    set((prev) => {
      const snapshot: TrafficSnapshot = { time: Date.now(), up: traffic.uploadSpeed, down: traffic.downloadSpeed }
      const history = [...prev.trafficHistory, snapshot]
      const trimmed = history.length > MAX_HISTORY ? history.slice(-MAX_HISTORY) : history
      return { traffic, trafficHistory: trimmed }
    }),

  tickUptime: (delta) =>
    set((prev) => {
      if (prev.state.status !== 'running') return prev
      return { state: { ...prev.state, uptime: (prev.state.uptime ?? 0) + delta } }
    }),

  startEngine: async () => {
    set({ state: { status: 'starting' } })

    // ① 启动前：用最新订阅数据重新生成 config.yaml（确保模板/规则/端口都是最新的）
    try {
      const { useSubscriptionStore } = await import('./subscription')
      await useSubscriptionStore.getState().applyConfig()
    } catch { /* 没有订阅也不阻塞启动 */ }

    // ② 启动引擎
    const result = await ipcEngineStart()
    if (result.success && result.data) {
      set({ state: result.data })
      get().startWatchdog()

      // ③ 等 mihomo API 就绪（最多等 5 秒）再确认状态
      let apiReady = false
      for (let i = 0; i < 10; i++) {
        await new Promise<void>((r) => setTimeout(r, 500))
        const v = await mihomoGetVersion()
        if (v.success && v.data) {
          set((prev) => ({
            state: { ...prev.state, status: 'running', version: v.data }
          }))
          apiReady = true
          break
        }
      }
      if (!apiReady) {
        set({ state: { status: 'error', error: 'mihomo API 未响应（端口可能被占用）' } })
        return
      }

      // ④ 桌面端：自动开启系统代理（不弹密码）
      try {
        const proxyResult = await ipcEnableProxy()
        if (proxyResult.success) set({ systemProxy: true })
      } catch { /* ignore */ }

      // ⑤ 重建托盘菜单（加入代理节点切换子菜单）
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('rebuild_tray_with_proxies')
      } catch { /* ignore */ }

      // ⑤ Android：自动开启 VPN 服务
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        const w = window as Record<string, unknown>
        const meta = w['__TAURI_INTERNALS__'] as Record<string, unknown> | undefined
        if (meta?.['platform'] === 'android') {
          try {
            const { invoke } = await import('@tauri-apps/api/core')
            await invoke('start_vpn', { proxyPort: 7890, dnsPort: 1053 })
          } catch { /* ignore */ }
        }
      }
    } else {
      set({ state: { status: 'error', error: result.error ?? '启动失败' } })
    }
  },

  stopEngine: async () => {
    get().stopWatchdog()
    set({ state: { status: 'stopping' } })

    // 先关系统代理（停引擎前关，避免流量指向不存在的端口→断网）
    try {
      await ipcDisableProxy()
      set({ systemProxy: false })
    } catch { /* ignore */ }

    // Android: 停 VPN 服务
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      const w = window as Record<string, unknown>
      const meta = w['__TAURI_INTERNALS__'] as Record<string, unknown> | undefined
      if (meta?.['platform'] === 'android') {
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          await invoke('stop_vpn')
        } catch { /* ignore */ }
      }
    }

    const result = await ipcEngineStop()
    if (result.success && result.data) {
      set({ state: result.data })
    } else {
      set({ state: { status: 'stopped' } })
    }
  },

  restartEngine: async () => {
    set({ state: { status: 'starting' } })
    const result = await ipcEngineRestart()
    if (result.success && result.data) {
      set({ state: result.data })
    } else {
      set({ state: { status: 'error', error: result.error ?? '重启失败' } })
    }
  },

  fetchState: async () => {
    const result = await ipcGetState()
    if (result.success && result.data) {
      set({ state: result.data })
      // 如果引擎已经在跑但没有 version 字段，主动拉一次
      if (result.data.status === 'running' && !result.data.version) {
        const v = await mihomoGetVersion()
        if (v.success && v.data) {
          set((prev) => ({ state: { ...prev.state, version: v.data } }))
        }
        get().startWatchdog()
      }
    }
  },

  changeMode: async (mode) => {
    set({ mode })
    await ipcSetMode(mode)
  },

  toggleSystemProxy: async () => {
    const current = get().systemProxy
    if (current) {
      const result = await ipcDisableProxy()
      if (result.success) set({ systemProxy: false })
    } else {
      const result = await ipcEnableProxy()
      if (result.success) set({ systemProxy: true })
    }
  },

  fetchSystemProxyStatus: async () => {
    const result = await ipcProxyStatus()
    if (result.success && result.data !== undefined) {
      set({ systemProxy: result.data })
    }
  },

  startWatchdog: () => {
    get().stopWatchdog()
    let crashCount = 0
    const timer = setInterval(async () => {
      const prev = get().state
      if (prev.status !== 'running') return

      const result = await ipcGetState()
      if (result.success && result.data && result.data.status !== 'running') {
        crashCount++
        // 自动重启：最多尝试 3 次，避免死循环
        if (crashCount <= 3) {
          console.error(`[KITE] 引擎崩溃 #${crashCount}，自动重启…`)
          set({ state: { status: 'starting' } })
          const restart = await ipcEngineStart()
          if (restart.success && restart.data) {
            set({ state: restart.data })
            return // 重启成功，继续监控
          }
        }
        set({ state: { status: 'error', error: `引擎进程已退出（已尝试重启 ${crashCount} 次）` } })
        get().stopWatchdog()
      }
    }, 5000)
    set({ watchdogTimer: timer })
  },

  stopWatchdog: () => {
    const timer = get().watchdogTimer
    if (timer) {
      clearInterval(timer)
      set({ watchdogTimer: null })
    }
  },
}))

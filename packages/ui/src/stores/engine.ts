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
    const result = await ipcEngineStart()
    if (result.success && result.data) {
      set({ state: result.data })
      get().startWatchdog()
      // 启动后获取 mihomo 版本
      setTimeout(async () => {
        const versionResult = await mihomoGetVersion()
        if (versionResult.success && versionResult.data) {
          set((prev) => ({
            state: { ...prev.state, version: versionResult.data }
          }))
        }
      }, 1000)
    } else {
      set({ state: { status: 'error', error: result.error ?? '启动失败' } })
    }
  },

  stopEngine: async () => {
    get().stopWatchdog()
    set({ state: { status: 'stopping' } })
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
    const timer = setInterval(async () => {
      const prev = get().state
      if (prev.status !== 'running') return

      const result = await ipcGetState()
      if (result.success && result.data && result.data.status !== 'running') {
        set({ state: { status: 'error', error: '引擎进程已退出' } })
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

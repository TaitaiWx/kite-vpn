/**
 * Mesh store — Phase 4。
 *
 * 管理本地 Mesh 网络状态：当前网络元数据、引擎运行状态、peers 列表。
 *
 * 设计原则（per workspace claude.md）：
 * - 业界最佳实践：zustand pattern，跟 engine.ts / subscription.ts 保持一致
 * - 禁滥用 `?`：未加入网络时 network=null（显式 null），不用 `?: MeshNetwork`
 * - 设计不放内存：所有持久状态都通过 IPC 持久化在 Rust 侧（network.json）
 */

import { create } from 'zustand'
import type {
  MeshNetwork,
  MeshPeer,
  MeshPeerRole,
  MeshEngineState,
  MeshEnrollmentToken,
} from '@kite-vpn/types'
import {
  meshGetEngineState,
  meshStart as ipcMeshStart,
  meshStop as ipcMeshStop,
  meshGetNetwork,
  meshCreateNetwork as ipcCreateNetwork,
  meshGenerateEnrollmentToken,
  meshJoinNetwork as ipcJoinNetwork,
  meshListPeers,
  meshRevokePeer as ipcRevokePeer,
} from '@/lib/ipc'

interface MeshStore {
  // ── State ───────────────────────────────────────────────────
  /** 当前网络。null 表示尚未加入任何网络。 */
  network: MeshNetwork | null
  /** Mesh 引擎状态。 */
  engine: MeshEngineState
  /** 已知 peers 列表。 */
  peers: MeshPeer[]
  /** 是否首次拉取过状态（避免 UI 闪烁）。 */
  loaded: boolean
  /** 最近一次操作错误（用于 UI 显示），无错误时为空字符串。 */
  lastError: string

  // ── Actions ─────────────────────────────────────────────────
  /** 从 Rust 侧拉所有状态（启动时 + 关键操作后调用）。 */
  refresh: () => Promise<void>

  /** 启动 nebula 子进程。前提：已加入网络。 */
  startEngine: () => Promise<void>
  stopEngine: () => Promise<void>

  /** Owner 端：创建新网络。 */
  createNetwork: (name: string, lighthouseEndpoint: string) => Promise<MeshNetwork | null>

  /** Owner 端：生成 enrollment token 邀请新设备。 */
  generateToken: (
    peerName: string,
    roles: MeshPeerRole[],
    meshIp: string,
  ) => Promise<MeshEnrollmentToken | null>

  /** 新设备：用 token 加入现有网络。 */
  joinNetwork: (token: string) => Promise<MeshNetwork | null>

  /** Owner 端：撤销 peer 邀请。 */
  revokePeer: (peerId: string) => Promise<void>
}

const STOPPED_ENGINE: MeshEngineState = {
  status: 'stopped',
  pid: 0,
  version: '',
  error: '',
}

export const useMeshStore = create<MeshStore>()((set, get) => ({
  network: null,
  engine: STOPPED_ENGINE,
  peers: [],
  loaded: false,
  lastError: '',

  refresh: async () => {
    const [networkRes, engineRes, peersRes] = await Promise.all([
      meshGetNetwork(),
      meshGetEngineState(),
      meshListPeers(),
    ])
    const network = (networkRes.success && networkRes.data) ? networkRes.data : null
    const engine = (engineRes.success && engineRes.data) ? engineRes.data : STOPPED_ENGINE
    const peers = (peersRes.success && peersRes.data) ? peersRes.data : []
    set({ network, engine, peers, loaded: true })
  },

  startEngine: async () => {
    const result = await ipcMeshStart()
    if (result.success && result.data) {
      set({ engine: result.data, lastError: '' })
    } else {
      set({ lastError: result.error ?? '启动 Mesh 失败' })
    }
  },

  stopEngine: async () => {
    const result = await ipcMeshStop()
    if (result.success && result.data) {
      set({ engine: result.data, lastError: '' })
    } else {
      set({ lastError: result.error ?? '停止 Mesh 失败' })
    }
  },

  createNetwork: async (name, lighthouseEndpoint) => {
    const result = await ipcCreateNetwork(name, lighthouseEndpoint)
    if (result.success && result.data) {
      set({ network: result.data, lastError: '' })
      await get().refresh()
      return result.data
    }
    set({ lastError: result.error ?? '创建网络失败' })
    return null
  },

  generateToken: async (peerName, roles, meshIp) => {
    const result = await meshGenerateEnrollmentToken(peerName, roles, meshIp)
    if (result.success && result.data) {
      set({ lastError: '' })
      await get().refresh()
      return result.data
    }
    set({ lastError: result.error ?? '生成邀请码失败' })
    return null
  },

  joinNetwork: async (token) => {
    const result = await ipcJoinNetwork(token)
    if (result.success && result.data) {
      set({ network: result.data, lastError: '' })
      await get().refresh()
      return result.data
    }
    set({ lastError: result.error ?? '加入网络失败' })
    return null
  },

  revokePeer: async (peerId) => {
    const result = await ipcRevokePeer(peerId)
    if (result.success) {
      set({ lastError: '' })
      await get().refresh()
    } else {
      set({ lastError: result.error ?? '撤销失败' })
    }
  },
}))

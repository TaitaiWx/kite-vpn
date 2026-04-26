/**
 * Health monitoring store — auto-reconnect + disconnect alerts.
 *
 * Periodically tests the currently-active proxy node(s) by calling
 * `mihomo /proxies/{name}/delay`. On consecutive failures:
 *
 *   - Threshold A (`failuresBeforeAlert`): send native notification
 *   - Threshold B (`failuresBeforeSwitch`): auto-switch to lowest-latency
 *     healthy alternative within the same group
 *
 * Architecture decision: this lives in the React WebView (not Rust)
 * because Tauri keeps WebView JS running even when the window is hidden.
 * Putting it in Rust would require an IPC event bus to surface state to
 * the UI for the (rare) case where the user has the window open. Frontend
 * polling is simpler and works for the personal-multi-device wedge.
 *
 * Default config can be overridden via AppConfig.healthCheck.
 */

import { create } from 'zustand'
import type { HealthCheckConfig } from '@kite-vpn/types'
import { mihomoGetProxies, testProxyDelay, mihomoSelectProxy } from '@/lib/ipc'
import { notifyDisconnect, notifyAutoSwitch } from '@/lib/notify'

// Default config — applied when AppConfig.healthCheck is absent. Tuned for
// "personal翻墙" usage: not too aggressive (don't spam notifications when
// you put your laptop to sleep), not too lazy (catch real outages within ~2 min).
export const DEFAULT_HEALTH_CONFIG: HealthCheckConfig = {
  enabled: true,
  alertOnDisconnect: true,
  autoReconnect: true,
  intervalMs: 30_000,
  timeoutMs: 5_000,
  failuresBeforeAlert: 2,
  failuresBeforeSwitch: 3,
  unhealthyLatencyMs: 3_000,
}

// ─── mihomo /proxies response shape (subset we use) ───────────────────

interface MihomoProxyEntry {
  name: string
  type: string
  /** For url-test/select groups, the currently-routing proxy name. */
  now?: string
  /** Members of a group (empty for plain nodes). */
  all?: string[]
  history?: Array<{ time: string; delay: number }>
}

interface MihomoProxiesResponse {
  proxies: Record<string, MihomoProxyEntry>
}

/**
 * "Active route" = one (group, leaf-node) pair where leaf is what's
 * actually serving traffic. We resolve groups recursively because real
 * Clash configs nest groups (e.g. Proxy → Auto Select → JP Region → JP-1).
 */
interface ActiveRoute {
  group: string
  leafNode: string
}

function resolveActiveRoutes(resp: MihomoProxiesResponse): ActiveRoute[] {
  const proxies = resp.proxies
  const routes: ActiveRoute[] = []
  // Identify "main" groups — ones a user would think of as a top-level
  // selectable group. Heuristic: it's a select/url-test group, has > 0
  // members, and is referenced by GLOBAL or appears at top of /proxies.
  for (const [name, entry] of Object.entries(proxies)) {
    if (entry.type !== 'Selector' && entry.type !== 'URLTest' && entry.type !== 'Fallback') continue
    if (!entry.now) continue
    if (entry.now === 'DIRECT' || entry.now === 'REJECT') continue
    if (name === 'GLOBAL') continue // GLOBAL is mihomo's bookkeeping, not a user route

    // Resolve `now` to a leaf — follow if it's another group
    let leaf = entry.now
    let depth = 0
    while (depth < 10) {
      const child = proxies[leaf]
      if (!child) break
      if (child.type !== 'Selector' && child.type !== 'URLTest' && child.type !== 'Fallback') break
      if (!child.now || child.now === 'DIRECT' || child.now === 'REJECT') break
      leaf = child.now
      depth++
    }
    if (proxies[leaf]) {
      routes.push({ group: name, leafNode: leaf })
    }
  }
  return routes
}

// ─── Store ────────────────────────────────────────────────────────────

interface HealthStore {
  config: HealthCheckConfig
  monitoring: boolean
  /** node name -> consecutive failure count */
  failures: Map<string, number>
  /** node name -> last successful delay in ms (for diagnostics) */
  lastDelay: Map<string, number>
  /** when monitoring last ran */
  lastTickAt: number
  timer: ReturnType<typeof setInterval> | null

  setConfig: (cfg: Partial<HealthCheckConfig>) => void
  start: () => void
  stop: () => void
  /** Trigger one manual tick (for testing / UI button). */
  tickNow: () => Promise<void>
  /** Reset all state (call when engine stops). */
  reset: () => void
}

export const useHealthStore = create<HealthStore>()((set, get) => ({
  config: DEFAULT_HEALTH_CONFIG,
  monitoring: false,
  failures: new Map(),
  lastDelay: new Map(),
  lastTickAt: 0,
  timer: null,

  setConfig: (patch) => {
    set((s) => ({ config: { ...s.config, ...patch } }))
    // If interval changed and we're running, restart with the new cadence
    const { monitoring } = get()
    if (monitoring) {
      get().stop()
      get().start()
    }
  },

  start: () => {
    const { config, timer } = get()
    if (timer) return
    if (!config.enabled) return

    set({ monitoring: true })
    // Run an immediate tick so the user gets fast feedback after engine start
    void get().tickNow()
    const id = setInterval(() => {
      void get().tickNow()
    }, config.intervalMs)
    set({ timer: id })
  },

  stop: () => {
    const { timer } = get()
    if (timer) clearInterval(timer)
    set({ timer: null, monitoring: false })
  },

  reset: () => {
    get().stop()
    set({
      failures: new Map(),
      lastDelay: new Map(),
      lastTickAt: 0,
    })
  },

  tickNow: async () => {
    const { config, failures: prevFailures, lastDelay: prevLastDelay } = get()
    if (!config.enabled) return

    set({ lastTickAt: Date.now() })

    // 1. Get the current routing state from mihomo
    const proxiesResult = await mihomoGetProxies()
    if (!proxiesResult.success || !proxiesResult.data) return // engine probably gone

    let parsed: MihomoProxiesResponse
    try {
      parsed = JSON.parse(proxiesResult.data) as MihomoProxiesResponse
    } catch {
      return
    }

    const routes = resolveActiveRoutes(parsed)
    if (routes.length === 0) return // nothing actively routing yet

    // Use *new* maps so React-friendly state diffs work
    const failures = new Map(prevFailures)
    const lastDelay = new Map(prevLastDelay)

    for (const { group, leafNode } of routes) {
      const result = await testProxyDelay(
        leafNode,
        'http://cp.cloudflare.com/generate_204',
        config.timeoutMs,
      )

      const ok = result.success
        && result.data != null
        && result.data.delay > 0
        && result.data.delay < config.unhealthyLatencyMs

      if (ok && result.data) {
        failures.set(leafNode, 0)
        lastDelay.set(leafNode, result.data.delay)
        continue
      }

      // Failure path
      const next = (failures.get(leafNode) ?? 0) + 1
      failures.set(leafNode, next)

      if (next === config.failuresBeforeAlert && config.alertOnDisconnect) {
        const reason = result.success
          ? `延迟过高 (>${config.unhealthyLatencyMs}ms)`
          : '连接超时'
        void notifyDisconnect(leafNode, reason)
      }

      if (next >= config.failuresBeforeSwitch && config.autoReconnect) {
        const switched = await tryAutoSwitch(parsed, group, leafNode, config)
        if (switched) {
          // Reset failure count for the failed node so a future re-select
          // doesn't immediately bounce us off again
          failures.set(leafNode, 0)
        }
      }
    }

    set({ failures, lastDelay })
  },
}))

// ─── Auto-switch logic ───────────────────────────────────────────────

/**
 * Find a healthy backup in the same group and switch to it. Returns true
 * iff we actually switched. We pick by lowest recent delay; if mihomo
 * has no history for any sibling, we just pick the first non-failed one.
 */
async function tryAutoSwitch(
  resp: MihomoProxiesResponse,
  group: string,
  failedNode: string,
  config: HealthCheckConfig,
): Promise<boolean> {
  const groupEntry = resp.proxies[group]
  if (!groupEntry) return false
  // Only Selector groups support manual selection. URLTest auto-selects.
  if (groupEntry.type !== 'Selector') return false

  const candidates = (groupEntry.all ?? [])
    .filter((n) => n !== failedNode && n !== 'DIRECT' && n !== 'REJECT')

  if (candidates.length === 0) return false

  // Score candidates by recent delay (lower is better, 0/missing = unknown)
  const scored = candidates.map((name) => {
    const entry = resp.proxies[name]
    const last = entry?.history?.[entry.history.length - 1]
    const delay = (last && last.delay > 0) ? last.delay : Number.MAX_SAFE_INTEGER
    return { name, delay }
  })
  scored.sort((a, b) => a.delay - b.delay)

  // Skip candidates whose recent delay also exceeds the unhealthy threshold
  const target = scored.find((c) => c.delay < config.unhealthyLatencyMs) ?? scored[0]
  if (!target) return false

  const result = await mihomoSelectProxy(group, target.name)
  if (!result.success) return false

  void notifyAutoSwitch(failedNode, target.name, group)
  return true
}

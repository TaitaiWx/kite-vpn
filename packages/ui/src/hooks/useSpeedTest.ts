/**
 * useSpeedTest — extracts batch speed-test orchestration from Proxies.tsx.
 *
 * Three test modes (matches the Rust `SpeedMode` enum):
 *
 * - **quick**:  Uses `mihomo /delay` (or TCP fallback when engine is off).
 *               Fast, parallelizable, batched 10 at a time. This is the
 *               default mode and what Kite has always done.
 *
 * - **real**:   Uses `test_node_real_speed` mode=real (HTTP GET ~32KB).
 *               Records TTFB. Requires switching the active proxy node
 *               before each test, so it's *sequential* and slower.
 *
 * - **heavy**:  Same as `real` but with mode=heavy (1MB GET, 1s abort).
 *               Records throughput in KB/s. Used to measure actual bandwidth.
 *
 * For real/heavy modes, the hook switches `groupName` to each node,
 * runs the test, and restores the originally-selected node when done.
 */

import { useCallback, useState } from 'react'
import type { ProxyNode, SpeedMode } from '@kite-vpn/types'
import {
  testProxyDelay,
  testNodeTcpDelay,
  testNodeRealSpeed,
  mihomoSelectProxy,
} from '@/lib/ipc'

const QUICK_BATCH_SIZE = 10
const QUICK_TIMEOUT_MS = 3000
const QUICK_TCP_TIMEOUT_MS = 2000
const REAL_TIMEOUT_MS = 5000
const HEAVY_TIMEOUT_MS = 8000
const REAL_BATCH_SIZE = 5
const HEAVY_BATCH_SIZE = 3

/** Per-node measurement update from a test run. */
export interface NodeMeasurement {
  /** Node name (matches `ProxyNode.name`) */
  name: string
  /** ms — for quick mode this is mihomo /delay; for real/heavy this is total_ms */
  latency: number
  /** Whether the test reached the target */
  alive: boolean
  /** Real-speed TTFB (ms), only set in real/heavy mode */
  ttfbMs?: number
  /** Real-speed throughput (KB/s), only set in heavy mode */
  throughputKbps?: number
}

/**
 * Filter out subscription "info pseudo-nodes" (流量、Expire、Reset 等)
 * that some 机场 inject into the proxy list.
 */
function isRealNode(n: ProxyNode): boolean {
  return !/^\d+[\s.]*[GMKT]?i?B?\s*\||Traffic|Expire|Reset/i.test(n.name)
}

interface UseSpeedTestOptions {
  /** All loaded nodes (we filter by `isRealNode` and by `groupName` membership). */
  nodes: ProxyNode[]
  /** Engine status — quick mode falls back to TCP when engine is not running. */
  engineRunning: boolean
  /** Currently active group, used to scope which nodes get tested. */
  groupName: string
  /** Currently-selected node in the group, restored after real/heavy run. */
  currentlySelected: string | undefined
  /** Names of nodes that belong to the active group (passed in to avoid re-deriving) */
  groupNodeNames: Set<string>
  /** Called for every batch with measurements; UI applies them incrementally. */
  onBatchUpdate: (updates: NodeMeasurement[]) => void
}

interface UseSpeedTestResult {
  testing: boolean
  /** Current progress (0..1) — only meaningful during a sequential run. */
  progress: number
  runTest: (mode: SpeedMode) => Promise<void>
}

export function useSpeedTest(opts: UseSpeedTestOptions): UseSpeedTestResult {
  const [testing, setTesting] = useState(false)
  const [progress, setProgress] = useState(0)

  const runTest = useCallback(
    async (mode: SpeedMode) => {
      if (testing) return
      setTesting(true)
      setProgress(0)

      try {
        const realNodes = opts.nodes
          .filter(isRealNode)
          .filter((n) => opts.groupNodeNames.has(n.name))

        if (realNodes.length === 0) {
          setTesting(false)
          return
        }

        if (mode === 'quick') {
          await runQuick(realNodes, opts)
        } else {
          // real | heavy — sequential, with active-node switching
          await runReal(realNodes, mode, opts, setProgress)
        }
      } finally {
        setTesting(false)
        setProgress(0)
      }
    },
    // We intentionally exclude opts because parent re-creates it every render;
    // testing is the gate we care about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [testing, opts.engineRunning, opts.groupName, opts.currentlySelected],
  )

  return { testing, progress, runTest }
}

// ─── Quick mode (parallel batches via mihomo /delay or TCP fallback) ───

async function runQuick(realNodes: ProxyNode[], opts: UseSpeedTestOptions): Promise<void> {
  const useApi = opts.engineRunning

  for (let i = 0; i < realNodes.length; i += QUICK_BATCH_SIZE) {
    const batch = realNodes.slice(i, i + QUICK_BATCH_SIZE)
    const results = await Promise.allSettled(
      useApi
        ? batch.map((n) =>
            testProxyDelay(n.name, 'http://cp.cloudflare.com/generate_204', QUICK_TIMEOUT_MS),
          )
        : batch.map((n) => testNodeTcpDelay(n.server, n.port, QUICK_TCP_TIMEOUT_MS)),
    )

    const updates: NodeMeasurement[] = []
    for (let j = 0; j < batch.length; j++) {
      const n = batch[j]!
      const r = results[j]!
      if (r.status === 'fulfilled' && r.value.success && r.value.data != null) {
        const delay = useApi
          ? (r.value.data as { delay: number }).delay
          : (r.value.data as number)
        updates.push({ name: n.name, latency: delay, alive: delay > 0 })
      } else {
        updates.push({ name: n.name, latency: 0, alive: false })
      }
    }
    opts.onBatchUpdate(updates)
  }
}

// ─── Real / Heavy mode (sequential, switches active proxy per node) ────

async function runReal(
  realNodes: ProxyNode[],
  mode: 'real' | 'heavy',
  opts: UseSpeedTestOptions,
  setProgress: (p: number) => void,
): Promise<void> {
  if (!opts.engineRunning) {
    // Real/Heavy can't run without mihomo — UI should prevent this state but
    // we double-guard to avoid silent garbage results.
    return
  }

  const restoreTarget = opts.currentlySelected
  const timeout = mode === 'heavy' ? HEAVY_TIMEOUT_MS : REAL_TIMEOUT_MS
  const batchSize = mode === 'heavy' ? HEAVY_BATCH_SIZE : REAL_BATCH_SIZE
  const total = realNodes.length

  for (let i = 0; i < total; i += batchSize) {
    const batch = realNodes.slice(i, i + batchSize)
    const updates: NodeMeasurement[] = []

    // Within a batch, still sequential — we have a single active node at a time.
    // Why batch at all? So we can flush UI updates more often (every 3-5 nodes
    // instead of every 1 — fewer re-renders) and so onBatchUpdate stays
    // semantically consistent across modes.
    for (const n of batch) {
      // 1. Switch active proxy to this node (in the group we're testing)
      const sel = await mihomoSelectProxy(opts.groupName, n.name)
      if (!sel.success) {
        updates.push({ name: n.name, latency: 0, alive: false })
        continue
      }

      // 2. Brief wait so mihomo's rule engine actually picks up the new selection
      //    (~80ms is empirically enough; mihomo internal switch is sub-frame)
      await sleep(80)

      // 3. Run the real-speed test
      const r = await testNodeRealSpeed(n.name, mode, timeout)
      if (r.success && r.data && r.data.error == null) {
        updates.push({
          name: n.name,
          latency: r.data.totalMs,
          alive: r.data.totalMs > 0,
          ttfbMs: r.data.ttfbMs,
          throughputKbps: mode === 'heavy' ? r.data.throughputKbps : undefined,
        })
      } else {
        updates.push({ name: n.name, latency: 0, alive: false })
      }
    }

    opts.onBatchUpdate(updates)
    setProgress(Math.min(1, (i + batch.length) / total))
  }

  // Restore the originally-selected node so the user isn't left on a random one.
  if (restoreTarget && opts.groupNodeNames.has(restoreTarget)) {
    await mihomoSelectProxy(opts.groupName, restoreTarget)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

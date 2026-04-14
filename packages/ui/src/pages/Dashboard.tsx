/**
 * Dashboard — overview page with stat cards, real-time traffic chart,
 * and quick-status summary.
 *
 * NO `any` types used anywhere.
 */

import { useEffect, useRef } from 'react'
import {
  ArrowUp,
  ArrowDown,
  Activity,
  Clock,
  Globe,
  Shield,
  Cpu,
  Wifi,
} from 'lucide-react'
import { useEngineStore } from '@/stores/engine'
import { StatusBadge } from '@/components/StatusBadge'
import { TrafficChart } from '@/components/TrafficChart'
import { formatSpeed, formatBytes, formatDuration } from '@/lib/format'
import { getMockTraffic, mihomoGetConnections } from '@/lib/ipc'
import { useSubscriptionStore } from '@/stores/subscription'

// ---------------------------------------------------------------------------
// Stat card component
// ---------------------------------------------------------------------------

interface StatCardProps {
  label: string
  value: string
  subValue?: string
  icon: React.ReactNode
  color: 'blue' | 'emerald' | 'violet' | 'amber'
}

const COLOR_MAP: Record<StatCardProps['color'], { accent: string; glow: string; iconBg: string }> = {
  blue: { accent: 'text-blue-400', glow: 'shadow-blue-500/10', iconBg: 'bg-blue-500/10' },
  emerald: { accent: 'text-emerald-400', glow: 'shadow-emerald-500/10', iconBg: 'bg-emerald-500/10' },
  violet: { accent: 'text-violet-400', glow: 'shadow-violet-500/10', iconBg: 'bg-violet-500/10' },
  amber: { accent: 'text-amber-400', glow: 'shadow-amber-500/10', iconBg: 'bg-amber-500/10' },
} as const

function StatCard({ label, value, subValue, icon, color }: StatCardProps) {
  const c = COLOR_MAP[color]

  return (
    <div className={`card-glass p-4 flex flex-col gap-3 ${c.glow}`}>
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">{label}</span>
        <div className={`flex items-center justify-center h-8 w-8 rounded-xl ${c.iconBg}`}>
          <span className={c.accent}>{icon}</span>
        </div>
      </div>
      <div>
        <p className="text-2xl font-bold text-gray-900 dark:text-white tracking-tight">{value}</p>
        {subValue && (
          <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">{subValue}</p>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Quick-status info row
// ---------------------------------------------------------------------------

interface InfoItemProps {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
}

function InfoItem({ icon, label, value }: InfoItemProps) {
  return (
    <div className="flex items-center gap-3 py-2.5 px-3">
      <span className="text-gray-400 dark:text-gray-500 flex-shrink-0">{icon}</span>
      <span className="text-sm text-gray-500 dark:text-gray-400 flex-shrink-0">{label}</span>
      <span className="text-sm font-medium text-gray-900 dark:text-gray-100 ml-auto truncate max-w-[200px] text-right">
        {value}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dashboard page
// ---------------------------------------------------------------------------

export function Dashboard() {
  const { traffic, state, mode, systemProxy, setTraffic, tickUptime, startEngine } = useEngineStore()
  const loadSubs = useSubscriptionStore((s) => s.load)
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const trafficIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const prevTotalsRef = useRef<{ up: number; down: number }>({ up: 0, down: 0 })

  useEffect(() => {
    void loadSubs()
  }, [loadSubs])

  // 流量轮询：通过 /connections 的 total 差值算速度（避免 /traffic 流式端点问题）
  useEffect(() => {
    trafficIntervalRef.current = setInterval(() => {
      if (state.status === 'running') {
        void (async () => {
          const connResult = await mihomoGetConnections()

          if (connResult.success && connResult.data) {
            try {
              const data = JSON.parse(connResult.data) as {
                connections?: unknown[]
                uploadTotal?: number
                downloadTotal?: number
              }
              const uploadTotal = data.uploadTotal ?? 0
              const downloadTotal = data.downloadTotal ?? 0
              const activeConnections = (data.connections as unknown[])?.length ?? 0

              const prev = prevTotalsRef.current
              const uploadSpeed = prev.up > 0 ? Math.max(0, uploadTotal - prev.up) : 0
              const downloadSpeed = prev.down > 0 ? Math.max(0, downloadTotal - prev.down) : 0
              prevTotalsRef.current = { up: uploadTotal, down: downloadTotal }

              setTraffic({ uploadSpeed, downloadSpeed, uploadTotal, downloadTotal, activeConnections })
              return
            } catch { /* ignore */ }
          }

          setTraffic(getMockTraffic())
        })()
      }
    }, 1_000)

    tickIntervalRef.current = setInterval(() => {
      tickUptime(1)
    }, 1_000)

    return () => {
      if (trafficIntervalRef.current) clearInterval(trafficIntervalRef.current)
      if (tickIntervalRef.current) clearInterval(tickIntervalRef.current)
    }
  }, [state.status, setTraffic, tickUptime])

  const modeLabels: Record<string, string> = {
    rule: '规则模式',
    global: '全局代理',
    direct: '直连模式',
  }

  return (
    <div className="animate-fade-in space-y-4 p-4">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white tracking-tight">仪表盘</h1>
          <p className="text-[13px] text-gray-400 mt-0.5">实时流量监控与状态总览</p>
        </div>
        <StatusBadge status={state.status} size="lg" />
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="上传速度"
          value={formatSpeed(traffic.uploadSpeed)}
          subValue={`总计 ${formatBytes(traffic.uploadTotal)}`}
          icon={<ArrowUp size={18} />}
          color="emerald"
        />
        <StatCard
          label="下载速度"
          value={formatSpeed(traffic.downloadSpeed)}
          subValue={`总计 ${formatBytes(traffic.downloadTotal)}`}
          icon={<ArrowDown size={18} />}
          color="blue"
        />
        <StatCard
          label="活跃连接"
          value={String(traffic.activeConnections)}
          subValue="当前并发连接数"
          icon={<Activity size={18} />}
          color="violet"
        />
        <StatCard
          label="运行时间"
          value={formatDuration(state.uptime ?? 0)}
          subValue={state.version ? `引擎 v${state.version}` : '引擎未启动'}
          icon={<Clock size={18} />}
          color="amber"
        />
      </div>

      {/* Traffic chart */}
      <div className="card-glass p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[13px] font-semibold text-gray-800 dark:text-gray-200">实时流量</h2>
          <span className="text-[11px] text-gray-400">最近 60 秒</span>
        </div>
        <TrafficChart height={240} />
      </div>

      {/* Quick status */}
      <div className="card-glass divide-y divide-border">
        <div className="px-5 py-3.5">
          <h2 className="text-[13px] font-semibold text-gray-800 dark:text-gray-200">快速概览</h2>
        </div>

        <InfoItem
          icon={<Globe size={16} />}
          label="代理模式"
          value={
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary-500" />
              {modeLabels[mode] ?? mode}
            </span>
          }
        />

        <InfoItem
          icon={<Shield size={16} />}
          label="系统代理"
          value={
            <span
              className={
                systemProxy
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-gray-400 dark:text-gray-500'
              }
            >
              {systemProxy ? '已开启' : '已关闭'}
            </span>
          }
        />

        <InfoItem
          icon={<Wifi size={16} />}
          label="当前配置"
          value="Default Profile"
        />

        <InfoItem
          icon={<Cpu size={16} />}
          label="引擎版本"
          value={state.version ? `mihomo v${state.version}` : '未运行'}
        />

        <InfoItem
          icon={<Activity size={16} />}
          label="PID"
          value={state.pid ? String(state.pid) : '—'}
        />
      </div>
    </div>
  )
}

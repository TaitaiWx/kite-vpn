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
  LayoutDashboard,
  BarChart3,
  Info,
} from 'lucide-react'
import { useEngineStore } from '@/stores/engine'
import { StatusBadge } from '@/components/StatusBadge'
import { TrafficChart } from '@/components/TrafficChart'
import { formatSpeed, formatBytes, formatDuration } from '@/lib/format'
import { mihomoGetConnections } from '@/lib/ipc'
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

  // 流量轮询：每秒尝试从 mihomo API 拉数据（不依赖引擎状态判断）
  useEffect(() => {
    trafficIntervalRef.current = setInterval(() => {
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
        // API 不响应时保持当前值（不清零，避免闪烁）
      })()
    }, 1_000)

    tickIntervalRef.current = setInterval(() => {
      tickUptime(1)
    }, 1_000)

    return () => {
      if (trafficIntervalRef.current) clearInterval(trafficIntervalRef.current)
      if (tickIntervalRef.current) clearInterval(tickIntervalRef.current)
    }
  }, [setTraffic, tickUptime])

  const modeLabels: Record<string, string> = {
    rule: '规则模式',
    global: '全局代理',
    direct: '直连模式',
  }

  return (
    <div className="h-full flex flex-col animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700/50 flex-shrink-0">
        <div>
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">仪表盘</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">实时流量监控与状态总览</p>
        </div>
        <StatusBadge status={state.status} size="lg" />
      </div>

      {/* 左右布局：桌面端有左侧导航，移动端直接滚 */}
      <div className="flex-1 overflow-hidden flex">
        {/* 左侧导航（移动端隐藏） */}
        <nav className="w-32 flex-shrink-0 border-r border-border py-4 px-2 space-y-0.5 hidden sm:block">
          {[
            { id: 'overview', icon: <LayoutDashboard size={14} />, label: '概览' },
            { id: 'traffic', icon: <BarChart3 size={14} />, label: '实时流量' },
            { id: 'status', icon: <Info size={14} />, label: '快速状态' },
          ].map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              onClick={(e) => {
                e.preventDefault()
                document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] text-gray-500 hover:text-gray-200 hover:bg-surface-2 transition-colors"
            >
              <span className="text-gray-400">{item.icon}</span>
              <span>{item.label}</span>
            </a>
          ))}
        </nav>

        {/* 右侧内容 */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
      {/* Stat cards */}
      <div id="overview" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
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
      <div id="traffic" className="card-glass p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[13px] font-semibold text-gray-800 dark:text-gray-200">实时流量</h2>
          <span className="text-[11px] text-gray-400">最近 60 秒</span>
        </div>
        <TrafficChart height={240} />
      </div>

      {/* Quick status */}
      <div id="status" className="card-glass divide-y divide-border">
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
          value={
            state.version
              ? `mihomo v${state.version}`
              : state.status === 'running'
                ? <span className="text-gray-400">获取中…</span>
                : <span className="text-gray-400">启动后显示</span>
          }
        />

        <InfoItem
          icon={<Activity size={16} />}
          label="PID"
          value={
            state.pid
              ? String(state.pid)
              : <span className="text-gray-400">{state.status === 'running' ? '—' : '未启动'}</span>
          }
        />
      </div>

      {/* Bottom spacing */}
      <div className="h-4" />
        </div>
      </div>
    </div>
  )
}

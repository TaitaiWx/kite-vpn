/**
 * TrafficChart — Real-time upload/download traffic visualisation.
 *
 * Renders a recharts AreaChart with gradient fills, maintaining a rolling
 * window of 60 data points.  Fully typed — no `any` anywhere.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import type { TooltipProps } from 'recharts'
import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent'
import { useEngineStore } from '@/stores/engine'
import { formatSpeed } from '@/lib/format'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TrafficDataPoint {
  /** Index / time label for the X axis */
  time: string
  /** Upload speed in bytes/sec */
  upload: number
  /** Download speed in bytes/sec */
  download: number
}

interface TrafficChartProps {
  /** Maximum number of data points visible at once (default 60) */
  maxPoints?: number
  /** Height of the chart container in pixels (default 260) */
  height?: number
  /** Classname applied to the wrapper div */
  className?: string
}

// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------

function ChartTooltip({ active, payload }: TooltipProps<ValueType, NameType>) {
  if (!active || !payload || payload.length === 0) return null

  const upload = payload.find((p) => p.dataKey === 'upload')
  const download = payload.find((p) => p.dataKey === 'download')

  const uploadValue = typeof upload?.value === 'number' ? upload.value : 0
  const downloadValue = typeof download?.value === 'number' ? download.value : 0

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-[#242438] px-3 py-2 shadow-lg text-xs">
      <div className="flex items-center gap-2 mb-1">
        <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
        <span className="text-gray-500 dark:text-gray-400">上传</span>
        <span className="ml-auto font-medium text-gray-900 dark:text-gray-100">
          {formatSpeed(uploadValue)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-full bg-blue-500" />
        <span className="text-gray-500 dark:text-gray-400">下载</span>
        <span className="ml-auto font-medium text-gray-900 dark:text-gray-100">
          {formatSpeed(downloadValue)}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Y-axis tick formatter
// ---------------------------------------------------------------------------

function formatYAxisTick(value: number): string {
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(0)}M`
  if (value >= 1_024) return `${(value / 1_024).toFixed(0)}K`
  if (value === 0) return '0'
  return `${value}`
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TrafficChart({
  maxPoints = 60,
  height = 260,
  className = '',
}: TrafficChartProps) {
  const traffic = useEngineStore((s) => s.traffic)

  const [data, setData] = useState<TrafficDataPoint[]>(() => {
    const initial: TrafficDataPoint[] = []
    for (let i = 0; i < maxPoints; i++) {
      initial.push({ time: '', upload: 0, download: 0 })
    }
    return initial
  })

  // Use a ref to keep the counter stable across renders
  const counterRef = useRef(0)

  const pushDataPoint = useCallback(
    (upload: number, download: number) => {
      counterRef.current += 1
      const label = `${counterRef.current}s`

      setData((prev) => {
        const next = [...prev, { time: label, upload, download }]
        if (next.length > maxPoints) {
          return next.slice(next.length - maxPoints)
        }
        return next
      })
    },
    [maxPoints],
  )

  // Push a new data point every second based on current traffic
  useEffect(() => {
    const interval = setInterval(() => {
      pushDataPoint(traffic.uploadSpeed, traffic.downloadSpeed)
    }, 1_000)
    return () => clearInterval(interval)
  }, [traffic.uploadSpeed, traffic.downloadSpeed, pushDataPoint])

  return (
    <div className={`w-full ${className}`}>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart
          data={data}
          margin={{ top: 8, right: 8, left: -12, bottom: 0 }}
        >
          <defs>
            <linearGradient id="gradientUpload" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity={0.35} />
              <stop offset="95%" stopColor="#10b981" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="gradientDownload" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.35} />
              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.02} />
            </linearGradient>
          </defs>

          <CartesianGrid
            strokeDasharray="3 3"
            stroke="currentColor"
            className="text-gray-200 dark:text-gray-700/50"
            vertical={false}
          />

          <XAxis
            dataKey="time"
            tick={{ fontSize: 10, fill: '#9ca3af' }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={40}
          />

          <YAxis
            tickFormatter={formatYAxisTick}
            tick={{ fontSize: 10, fill: '#9ca3af' }}
            axisLine={false}
            tickLine={false}
            width={48}
          />

          <Tooltip
            content={<ChartTooltip />}
            cursor={{
              stroke: '#6b7280',
              strokeWidth: 1,
              strokeDasharray: '4 4',
            }}
          />

          <Area
            type="monotone"
            dataKey="upload"
            stroke="#10b981"
            strokeWidth={1.5}
            fill="url(#gradientUpload)"
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 3, fill: '#10b981', strokeWidth: 0 }}
          />

          <Area
            type="monotone"
            dataKey="download"
            stroke="#3b82f6"
            strokeWidth={1.5}
            fill="url(#gradientDownload)"
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 3, fill: '#3b82f6', strokeWidth: 0 }}
          />
        </AreaChart>
      </ResponsiveContainer>

      {/* Legend */}
      <div className="flex items-center justify-center gap-6 mt-2 text-xs text-gray-500 dark:text-gray-400">
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
          <span>上传</span>
          <span className="font-medium text-gray-700 dark:text-gray-300 ml-1">
            {formatSpeed(traffic.uploadSpeed)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-blue-500" />
          <span>下载</span>
          <span className="font-medium text-gray-700 dark:text-gray-300 ml-1">
            {formatSpeed(traffic.downloadSpeed)}
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * Logs page — real-time log viewer with color-coded entries by level,
 * level filter dropdown, auto-scroll toggle, and clear button.
 *
 * NO `any` types — fully typed with @kite-vpn/types.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  Trash2,
  ArrowDownToLine,
  Pause,
  Filter,
  ChevronDown,
  AlertTriangle,
  AlertCircle,
  Info,
  Bug,
  ScrollText,
} from 'lucide-react'
import { clsx } from 'clsx'
import type { LogEntry } from '@kite-vpn/types'
import { mihomoGetLogs } from '@/lib/ipc'
import { useEngineStore } from '@/stores/engine'

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

/** Log levels that the user can filter on (excluding 'silent'). */
type FilterableLevel = 'debug' | 'info' | 'warning' | 'error'

const ALL_LEVELS: readonly FilterableLevel[] = ['debug', 'info', 'warning', 'error'] as const

interface LevelVisual {
  readonly label: string
  readonly textColor: string
  readonly bgColor: string
  readonly badgeBg: string
  readonly icon: React.ReactNode
}

const LEVEL_VISUALS: Record<FilterableLevel, LevelVisual> = {
  debug: {
    label: 'DEBUG',
    textColor: 'text-gray-500 dark:text-gray-400',
    bgColor: '',
    badgeBg: 'bg-gray-100 text-gray-600 dark:bg-gray-700/50 dark:text-gray-400',
    icon: <Bug className="h-3.5 w-3.5" />,
  },
  info: {
    label: 'INFO',
    textColor: 'text-blue-600 dark:text-blue-400',
    bgColor: '',
    badgeBg: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
    icon: <Info className="h-3.5 w-3.5" />,
  },
  warning: {
    label: 'WARN',
    textColor: 'text-yellow-600 dark:text-yellow-400',
    bgColor: 'bg-yellow-50/50 dark:bg-yellow-500/[0.03]',
    badgeBg: 'bg-yellow-50 text-yellow-700 dark:bg-yellow-500/10 dark:text-yellow-400',
    icon: <AlertTriangle className="h-3.5 w-3.5" />,
  },
  error: {
    label: 'ERROR',
    textColor: 'text-red-600 dark:text-red-400',
    bgColor: 'bg-red-50/50 dark:bg-red-500/[0.03]',
    badgeBg: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
    icon: <AlertCircle className="h-3.5 w-3.5" />,
  },
} as const

const LEVEL_PRIORITY: Record<FilterableLevel, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
} as const

const MAX_LOG_ENTRIES = 1000

// ---------------------------------------------------------------------------
// Timestamp formatting (HH:MM:SS.mmm)
// ---------------------------------------------------------------------------

function formatTimestamp(isoString: string): string {
  const d = new Date(isoString)
  if (Number.isNaN(d.getTime())) return '--:--:--'

  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  const seconds = String(d.getSeconds()).padStart(2, '0')
  const millis = String(d.getMilliseconds()).padStart(3, '0')

  return `${hours}:${minutes}:${seconds}.${millis}`
}

// ---------------------------------------------------------------------------
// Level filter dropdown
// ---------------------------------------------------------------------------

interface LevelFilterProps {
  value: FilterableLevel
  onChange: (level: FilterableLevel) => void
}

function LevelFilter({ value, onChange }: LevelFilterProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Close dropdown on click outside
  useEffect(() => {
    if (!open) return

    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        e.target instanceof Node &&
        !containerRef.current.contains(e.target)
      ) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const visual = LEVEL_VISUALS[value]

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={clsx(
          'btn-secondary text-xs py-1.5 px-3 gap-1.5',
          open && 'ring-2 ring-primary-400',
        )}
      >
        <Filter className="h-3.5 w-3.5" />
        <span>
          {visual.label}
          <span className="text-gray-400 dark:text-gray-500 ml-0.5">+</span>
        </span>
        <ChevronDown
          className={clsx('h-3 w-3 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 w-36 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-[#242438] shadow-lg py-1 animate-fade-in">
          {ALL_LEVELS.map((level) => {
            const lv = LEVEL_VISUALS[level]
            const isActive = level === value

            return (
              <button
                key={level}
                type="button"
                onClick={() => {
                  onChange(level)
                  setOpen(false)
                }}
                className={clsx(
                  'w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors',
                  'hover:bg-gray-50 dark:hover:bg-white/5',
                  isActive && 'bg-primary-50 dark:bg-primary-500/10',
                )}
              >
                <span className={lv.textColor}>{lv.icon}</span>
                <span
                  className={clsx(
                    isActive
                      ? 'text-primary-700 dark:text-primary-400 font-medium'
                      : 'text-gray-700 dark:text-gray-300',
                  )}
                >
                  {lv.label}+
                </span>
                {isActive && (
                  <span className="ml-auto text-primary-500 text-[10px]">✓</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Single log entry row
// ---------------------------------------------------------------------------

interface LogRowProps {
  entry: LogEntry
  index: number
}

function LogRow({ entry, index }: LogRowProps) {
  const level = entry.type as FilterableLevel
  const visual = LEVEL_VISUALS[level] ?? LEVEL_VISUALS.info

  return (
    <div
      className={clsx(
        'flex items-start gap-3 px-4 py-1.5 font-mono text-[12px] leading-relaxed',
        'border-b border-gray-100/50 dark:border-gray-800/50',
        'hover:bg-gray-50/50 dark:hover:bg-white/[0.02] transition-colors',
        visual.bgColor,
      )}
    >
      {/* Line number */}
      <span className="text-[10px] text-gray-300 dark:text-gray-600 w-8 text-right flex-shrink-0 pt-0.5 select-none">
        {index + 1}
      </span>

      {/* Timestamp */}
      <span className="text-gray-400 dark:text-gray-500 flex-shrink-0 w-24">
        {formatTimestamp(entry.timestamp)}
      </span>

      {/* Level badge */}
      <span
        className={clsx(
          'inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider flex-shrink-0 w-14 text-center',
          visual.badgeBg,
        )}
      >
        {visual.label}
      </span>

      {/* Payload */}
      <span
        className={clsx(
          'flex-1 break-all whitespace-pre-wrap select-text',
          visual.textColor,
          level === 'debug' && 'opacity-70',
        )}
      >
        {entry.payload}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function Logs() {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [filterLevel, setFilterLevel] = useState<FilterableLevel>('info')
  const [autoScroll, setAutoScroll] = useState(true)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(autoScroll)

  // Keep ref in sync for use in interval callbacks
  autoScrollRef.current = autoScroll

  const engineStatus = useEngineStore((s) => s.state.status)
  const logIndexRef = useRef(0)

  useEffect(() => {
    logIndexRef.current = 0
    setEntries([])
  }, [engineStatus])

  // 日志轮询：不依赖 engineStatus，直接尝试从 API 拉
  useEffect(() => {
    const interval = setInterval(() => {
      void (async () => {
        const result = await mihomoGetLogs(logIndexRef.current.toString())
        if (result.success && result.data) {
          const chunk = result.data as unknown as { lines: string[]; total: number }
          if (chunk.lines && chunk.lines.length > 0) {
            logIndexRef.current = chunk.total
            const newEntries: LogEntry[] = chunk.lines.map((line) => {
              let type: LogEntry['type'] = 'info'
              if (line.includes('level=error') || line.includes('ERR')) type = 'error'
              else if (line.includes('level=warn') || line.includes('WRN')) type = 'warning'
              else if (line.includes('level=debug') || line.includes('DBG')) type = 'debug'
              return { type, payload: line, timestamp: new Date().toISOString() }
            })
            setEntries((prev) => {
              const next = [...prev, ...newEntries]
              return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next
            })
          }
        }
      })()
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScrollRef.current && scrollContainerRef.current) {
      const container = scrollContainerRef.current
      container.scrollTop = container.scrollHeight
    }
  }, [entries])

  // Handle manual scroll — disable auto-scroll if user scrolled up
  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current) return
    const container = scrollContainerRef.current
    const isAtBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 40

    if (autoScrollRef.current && !isAtBottom) {
      setAutoScroll(false)
    }
  }, [])

  // Clear all entries
  const handleClear = useCallback(() => {
    setEntries([])
  }, [])

  // Toggle auto-scroll
  const toggleAutoScroll = useCallback(() => {
    setAutoScroll((prev) => {
      const next = !prev
      if (next && scrollContainerRef.current) {
        const container = scrollContainerRef.current
        container.scrollTop = container.scrollHeight
      }
      return next
    })
  }, [])

  // Filter entries by minimum log level
  const filteredEntries = useMemo(() => {
    const minPriority = LEVEL_PRIORITY[filterLevel]
    return entries.filter((entry) => {
      const entryLevel = entry.type as FilterableLevel
      const entryPriority = LEVEL_PRIORITY[entryLevel]
      return entryPriority !== undefined && entryPriority >= minPriority
    })
  }, [entries, filterLevel])

  // Level counts for display
  const levelCounts = useMemo(() => {
    const counts: Record<FilterableLevel, number> = {
      debug: 0,
      info: 0,
      warning: 0,
      error: 0,
    }
    for (const entry of entries) {
      const level = entry.type as FilterableLevel
      if (level in counts) {
        counts[level]++
      }
    }
    return counts
  }, [entries])

  return (
    <div className="h-full flex flex-col animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700/50 flex-shrink-0">
        <div>
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">日志</h1>
          <div className="flex items-center gap-3 mt-0.5">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {filteredEntries.length} 条日志
              {filteredEntries.length !== entries.length && (
                <span className="text-gray-300 dark:text-gray-600">
                  {' '}
                  (共 {entries.length})
                </span>
              )}
            </span>

            {/* Mini level counts */}
            <div className="flex items-center gap-2">
              {levelCounts.error > 0 && (
                <span className="inline-flex items-center gap-0.5 text-[10px] text-red-500">
                  <AlertCircle className="h-3 w-3" />
                  {levelCounts.error}
                </span>
              )}
              {levelCounts.warning > 0 && (
                <span className="inline-flex items-center gap-0.5 text-[10px] text-yellow-500">
                  <AlertTriangle className="h-3 w-3" />
                  {levelCounts.warning}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Level filter */}
          <LevelFilter value={filterLevel} onChange={setFilterLevel} />

          {/* Auto-scroll toggle */}
          <button
            type="button"
            onClick={toggleAutoScroll}
            className={clsx(
              'btn-secondary text-xs py-1.5 px-3',
              autoScroll
                ? 'ring-2 ring-primary-400 dark:ring-primary-500'
                : '',
            )}
            title={autoScroll ? '自动滚动已开启' : '自动滚动已关闭'}
          >
            {autoScroll ? (
              <ArrowDownToLine className="h-3.5 w-3.5 text-primary-500" />
            ) : (
              <Pause className="h-3.5 w-3.5" />
            )}
            <span>{autoScroll ? '自动滚动' : '已暂停'}</span>
          </button>

          {/* Clear */}
          <button
            type="button"
            onClick={handleClear}
            className="btn-secondary text-xs py-1.5 px-3"
            disabled={entries.length === 0}
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>清空</span>
          </button>
        </div>
      </div>

      {/* Log entries */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto bg-white dark:bg-[#1a1a2a]"
      >
        {filteredEntries.length > 0 ? (
          filteredEntries.map((entry, index) => (
            <LogRow
              key={`${entry.timestamp}-${index}`}
              entry={entry}
              index={index}
            />
          ))
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 dark:text-gray-500">
            <ScrollText className="h-10 w-10 mb-3 opacity-50" />
            <span className="text-sm">暂无日志</span>
            <span className="text-xs mt-1 opacity-60">
              {entries.length > 0
                ? '当前过滤条件下没有匹配的日志'
                : '日志将会实时显示在这里'}
            </span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-6 py-2 border-t border-gray-200 dark:border-gray-700/50 bg-gray-50 dark:bg-[#1a1a2e] text-[11px] text-gray-500 dark:text-gray-400 flex-shrink-0">
        <span>
          过滤级别: {LEVEL_VISUALS[filterLevel].label}+
        </span>
        <div className="flex items-center gap-3">
          <span className="text-gray-400 dark:text-gray-500">
            缓冲: {entries.length} / {MAX_LOG_ENTRIES}
          </span>
          {autoScroll && (
            <span className="inline-flex items-center gap-1 text-primary-500">
              <ArrowDownToLine className="h-3 w-3" />
              自动滚动
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

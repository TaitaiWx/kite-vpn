/**
 * Formatting utilities for the Kite UI.
 *
 * All functions are pure and side-effect-free.
 * NO `any` types — every value is explicitly typed.
 */

// ---------------------------------------------------------------------------
// Speed formatting
// ---------------------------------------------------------------------------

interface SpeedUnit {
  readonly threshold: number
  readonly suffix: string
  readonly divisor: number
}

const SPEED_UNITS: readonly SpeedUnit[] = [
  { threshold: 1_073_741_824, suffix: 'GB/s', divisor: 1_073_741_824 },
  { threshold: 1_048_576, suffix: 'MB/s', divisor: 1_048_576 },
  { threshold: 1_024, suffix: 'KB/s', divisor: 1_024 },
] as const

/**
 * Format a speed value in bytes-per-second to a human-readable string.
 *
 * @example
 * formatSpeed(1_500_000) // "1.43 MB/s"
 * formatSpeed(512)       // "512 B/s"
 * formatSpeed(0)         // "0 B/s"
 */
export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 0) return '0 B/s'

  for (const unit of SPEED_UNITS) {
    if (bytesPerSec >= unit.threshold) {
      const value = bytesPerSec / unit.divisor
      return `${value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : value.toFixed(0)} ${unit.suffix}`
    }
  }

  return `${Math.round(bytesPerSec)} B/s`
}

// ---------------------------------------------------------------------------
// Byte size formatting
// ---------------------------------------------------------------------------

interface ByteUnit {
  readonly threshold: number
  readonly suffix: string
  readonly divisor: number
}

const BYTE_UNITS: readonly ByteUnit[] = [
  { threshold: 1_099_511_627_776, suffix: 'TB', divisor: 1_099_511_627_776 },
  { threshold: 1_073_741_824, suffix: 'GB', divisor: 1_073_741_824 },
  { threshold: 1_048_576, suffix: 'MB', divisor: 1_048_576 },
  { threshold: 1_024, suffix: 'KB', divisor: 1_024 },
] as const

/**
 * Format a byte count to a human-readable string.
 *
 * @example
 * formatBytes(1_500_000_000) // "1.40 GB"
 * formatBytes(456_000)       // "445 KB"
 * formatBytes(0)             // "0 B"
 */
export function formatBytes(bytes: number): string {
  if (bytes < 0) return '0 B'

  for (const unit of BYTE_UNITS) {
    if (bytes >= unit.threshold) {
      const value = bytes / unit.divisor
      return `${value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : value.toFixed(0)} ${unit.suffix}`
    }
  }

  return `${Math.round(bytes)} B`
}

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

interface DurationPart {
  readonly value: number
  readonly suffix: string
}

/**
 * Format a duration given in seconds to a human-readable string.
 *
 * @example
 * formatDuration(9000)  // "2h 30m"
 * formatDuration(312)   // "5m 12s"
 * formatDuration(45)    // "45s"
 * formatDuration(0)     // "0s"
 */
export function formatDuration(seconds: number): string {
  if (seconds < 0) return '0s'

  const totalSeconds = Math.floor(seconds)

  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const secs = totalSeconds % 60

  const parts: DurationPart[] = [
    { value: days, suffix: 'd' },
    { value: hours, suffix: 'h' },
    { value: minutes, suffix: 'm' },
    { value: secs, suffix: 's' },
  ]

  // Find the first non-zero part and take at most 2 parts from there
  const firstNonZero = parts.findIndex((p) => p.value > 0)

  if (firstNonZero === -1) return '0s'

  const relevantParts = parts.slice(firstNonZero, firstNonZero + 2)

  return relevantParts
    .filter((p) => p.value > 0)
    .map((p) => `${p.value}${p.suffix}`)
    .join(' ')
}

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

/**
 * Format a `Date` or ISO-8601 date string to a locale-friendly display string.
 *
 * @example
 * formatDate(new Date()) // "2025-01-15 14:30:05"
 * formatDate("2025-01-15T06:30:05.000Z") // "2025-01-15 14:30:05" (local tz)
 */
export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date

  if (Number.isNaN(d.getTime())) return '—'

  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hours = String(d.getHours()).padStart(2, '0')
  const mins = String(d.getMinutes()).padStart(2, '0')
  const secs = String(d.getSeconds()).padStart(2, '0')

  return `${year}-${month}-${day} ${hours}:${mins}:${secs}`
}

// ---------------------------------------------------------------------------
// Relative time formatting
// ---------------------------------------------------------------------------

interface RelativeUnit {
  readonly threshold: number
  readonly divisor: number
  readonly label: string
  readonly pluralLabel: string
}

const RELATIVE_UNITS: readonly RelativeUnit[] = [
  { threshold: 86_400, divisor: 86_400, label: '天前', pluralLabel: '天前' },
  { threshold: 3_600, divisor: 3_600, label: '小时前', pluralLabel: '小时前' },
  { threshold: 60, divisor: 60, label: '分钟前', pluralLabel: '分钟前' },
] as const

/**
 * Format a `Date` or ISO string as a relative time string (Chinese).
 *
 * @example
 * formatRelativeTime(new Date(Date.now() - 60_000)) // "1 分钟前"
 */
export function formatRelativeTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date

  if (Number.isNaN(d.getTime())) return '—'

  const diffSeconds = Math.floor((Date.now() - d.getTime()) / 1_000)

  if (diffSeconds < 0) return '刚刚'
  if (diffSeconds < 60) return '刚刚'

  for (const unit of RELATIVE_UNITS) {
    if (diffSeconds >= unit.threshold) {
      const value = Math.floor(diffSeconds / unit.divisor)
      return `${value} ${unit.label}`
    }
  }

  return '刚刚'
}

// ---------------------------------------------------------------------------
// Latency color helpers
// ---------------------------------------------------------------------------

export type LatencyLevel = 'fast' | 'medium' | 'slow' | 'timeout' | 'untested'

/**
 * Classify a latency value into a semantic level.
 *
 * - `undefined` → untested
 * - `0`         → timeout (test failed)
 * - `< 200ms`   → fast (green)
 * - `< 500ms`   → medium (yellow)
 * - `>= 500ms`  → slow (red)
 */
export function getLatencyLevel(latency: number | undefined): LatencyLevel {
  if (latency === undefined) return 'untested'
  if (latency <= 0) return 'timeout'
  if (latency < 200) return 'fast'
  if (latency < 500) return 'medium'
  return 'slow'
}

const LATENCY_COLORS: Record<LatencyLevel, string> = {
  fast: 'text-green-500',
  medium: 'text-yellow-500',
  slow: 'text-red-500',
  timeout: 'text-red-500',
  untested: 'text-gray-400',
} as const

const LATENCY_DOT_COLORS: Record<LatencyLevel, string> = {
  fast: 'bg-green-500',
  medium: 'bg-yellow-500',
  slow: 'bg-red-500',
  timeout: 'bg-red-500',
  untested: 'bg-gray-400',
} as const

/**
 * Get the Tailwind CSS text-color class for a given latency value.
 */
export function getLatencyColorClass(latency: number | undefined): string {
  return LATENCY_COLORS[getLatencyLevel(latency)]
}

/**
 * Get the Tailwind CSS background-color class for a latency dot indicator.
 */
export function getLatencyDotClass(latency: number | undefined): string {
  return LATENCY_DOT_COLORS[getLatencyLevel(latency)]
}

/**
 * Format latency as a display string.
 *
 * @example
 * formatLatency(42)        // "42ms"
 * formatLatency(0)         // "timeout"
 * formatLatency(undefined) // "—"
 */
export function formatLatency(latency: number | undefined): string {
  if (latency === undefined) return '—'
  if (latency <= 0) return 'timeout'
  return `${Math.round(latency)}ms`
}

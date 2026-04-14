/**
 * StatusBadge — a reusable badge that displays the engine's current status
 * with a color-coded, optionally animated dot indicator.
 *
 * - green  + pulse  → running
 * - yellow + pulse  → starting / stopping
 * - red             → error
 * - gray            → stopped
 *
 * NO `any` types used anywhere.
 */

import { clsx } from 'clsx'
import type { EngineStatus } from '@kite-vpn/types'

// ---------------------------------------------------------------------------
// Visual mapping
// ---------------------------------------------------------------------------

interface StatusVisual {
  readonly dotColor: string
  readonly bgColor: string
  readonly textColor: string
  readonly label: string
  readonly pulse: boolean
}

const STATUS_MAP: Record<EngineStatus, StatusVisual> = {
  running: {
    dotColor: 'bg-green-500',
    bgColor: 'bg-green-500/10 dark:bg-green-500/15',
    textColor: 'text-green-700 dark:text-green-400',
    label: '运行中',
    pulse: true,
  },
  starting: {
    dotColor: 'bg-yellow-500',
    bgColor: 'bg-yellow-500/10 dark:bg-yellow-500/15',
    textColor: 'text-yellow-700 dark:text-yellow-400',
    label: '启动中',
    pulse: true,
  },
  stopping: {
    dotColor: 'bg-yellow-500',
    bgColor: 'bg-yellow-500/10 dark:bg-yellow-500/15',
    textColor: 'text-yellow-700 dark:text-yellow-400',
    label: '停止中',
    pulse: true,
  },
  stopped: {
    dotColor: 'bg-gray-400 dark:bg-gray-500',
    bgColor: 'bg-gray-100 dark:bg-gray-700/40',
    textColor: 'text-gray-600 dark:text-gray-400',
    label: '已停止',
    pulse: false,
  },
  error: {
    dotColor: 'bg-red-500',
    bgColor: 'bg-red-500/10 dark:bg-red-500/15',
    textColor: 'text-red-700 dark:text-red-400',
    label: '错误',
    pulse: false,
  },
} as const

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface StatusBadgeProps {
  /** The current engine status to visualise. */
  status: EngineStatus
  /** Optional size variant. Defaults to `'md'`. */
  size?: 'sm' | 'md' | 'lg'
  /** If `true`, only render the dot without the label text. */
  dotOnly?: boolean
  /** Extra CSS class names to apply to the root element. */
  className?: string
  /** Override the default label text. */
  label?: string
}

// ---------------------------------------------------------------------------
// Size presets
// ---------------------------------------------------------------------------

interface SizePreset {
  readonly dot: string
  readonly badge: string
  readonly text: string
  /** Outer ring size for the pulse animation (slightly larger than dot). */
  readonly ring: string
}

const SIZES: Record<NonNullable<StatusBadgeProps['size']>, SizePreset> = {
  sm: {
    dot: 'h-1.5 w-1.5',
    badge: 'px-2 py-0.5 gap-1.5',
    text: 'text-[11px]',
    ring: 'h-2.5 w-2.5',
  },
  md: {
    dot: 'h-2 w-2',
    badge: 'px-2.5 py-1 gap-2',
    text: 'text-xs',
    ring: 'h-3 w-3',
  },
  lg: {
    dot: 'h-2.5 w-2.5',
    badge: 'px-3 py-1.5 gap-2',
    text: 'text-sm',
    ring: 'h-3.5 w-3.5',
  },
} as const

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StatusBadge({
  status,
  size = 'md',
  dotOnly = false,
  className,
  label: labelOverride,
}: StatusBadgeProps) {
  const visual = STATUS_MAP[status]
  const sizePreset = SIZES[size]
  const displayLabel = labelOverride ?? visual.label

  // The animated dot with an optional pulse ring
  const dot = (
    <span className="relative inline-flex items-center justify-center">
      {/* Pulse ring — only when visual.pulse is true */}
      {visual.pulse && (
        <span
          className={clsx(
            'absolute inline-flex rounded-full opacity-75 animate-ping',
            visual.dotColor,
            sizePreset.ring,
          )}
          aria-hidden="true"
        />
      )}
      {/* Solid inner dot */}
      <span
        className={clsx(
          'relative inline-flex rounded-full',
          visual.dotColor,
          sizePreset.dot,
        )}
      />
    </span>
  )

  if (dotOnly) {
    return (
      <span
        className={clsx('inline-flex items-center', className)}
        role="status"
        aria-label={displayLabel}
        title={displayLabel}
      >
        {dot}
      </span>
    )
  }

  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full font-medium select-none',
        visual.bgColor,
        visual.textColor,
        sizePreset.badge,
        sizePreset.text,
        className,
      )}
      role="status"
      aria-label={displayLabel}
    >
      {dot}
      <span className="leading-none">{displayLabel}</span>
    </span>
  )
}

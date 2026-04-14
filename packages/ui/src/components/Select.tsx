import { useState, useRef, useEffect } from 'react'
import { ChevronDown } from 'lucide-react'
import { clsx } from 'clsx'

interface Option<T extends string> {
  value: T
  label: string
  icon?: React.ReactNode
}

interface SelectProps<T extends string> {
  value: T
  options: readonly Option<T>[]
  onChange: (value: T) => void
  className?: string
  disabled?: boolean
}

export function Select<T extends string>({ value, options, onChange, className, disabled }: SelectProps<T>) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const selected = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} className={clsx('relative', className)}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className={clsx(
          'flex items-center justify-between gap-2 w-full',
          'px-3 py-1.5 rounded-lg text-[13px] font-medium',
          'bg-surface-2 border border-border',
          'text-gray-900 dark:text-gray-100',
          'hover:border-gray-400/30 transition-all',
          'disabled:opacity-40',
          open && 'ring-2 ring-primary-500/30 border-primary-500/50',
        )}
      >
        <span className="flex items-center gap-1.5 truncate">
          {selected?.icon}
          {selected?.label ?? value}
        </span>
        <ChevronDown className={clsx('h-3.5 w-3.5 text-gray-400 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-full w-max rounded-lg border border-border bg-surface-1 shadow-xl py-1 animate-fade-in">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { onChange(opt.value); setOpen(false) }}
              className={clsx(
                'flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-left transition-colors',
                'hover:bg-surface-2',
                opt.value === value ? 'text-primary-500 font-medium' : 'text-gray-700 dark:text-gray-300',
              )}
            >
              {opt.icon}
              <span>{opt.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
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

interface DropdownPos {
  left: number
  top: number
  width: number
  openUp: boolean
}

export function Select<T extends string>({ value, options, onChange, className, disabled }: SelectProps<T>) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<DropdownPos | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selected = options.find((o) => o.value === value)

  // 打开时测量锚点位置，用 fixed 定位到视口，避开任何 overflow 裁剪
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const rect = btnRef.current.getBoundingClientRect()
    const itemH = 32
    const menuH = Math.min(options.length * itemH + 8, 300)
    const pad = 8
    const vh = window.innerHeight
    const vw = window.innerWidth
    const openUp = rect.bottom + menuH + pad > vh && rect.top - menuH - pad > 0
    const top = openUp ? rect.top - menuH - 4 : rect.bottom + 4
    const width = Math.max(rect.width, 140)
    let left = rect.right - width // 右对齐锚点
    if (left + width + pad > vw) left = vw - width - pad
    if (left < pad) left = pad
    setPos({ left, top, width, openUp })
  }, [open, options.length])

  // 外部点击 / Escape 关闭
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (
        btnRef.current && !btnRef.current.contains(t) &&
        menuRef.current && !menuRef.current.contains(t)
      ) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onScroll = () => setOpen(false)
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  return (
    <div className={clsx('relative', className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className={clsx(
          'flex items-center justify-between gap-2 w-full',
          'px-3 py-1.5 rounded-lg text-[13px] font-medium',
          'bg-surface-2 border border-border',
          'text-gray-900 dark:text-gray-100',
          'hover:border-gray-400/30 transition-all',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          open && 'ring-2 ring-primary-500/30 border-primary-500/50',
        )}
      >
        <span className="flex items-center gap-1.5 truncate">
          {selected?.icon}
          {selected?.label ?? value}
        </span>
        <ChevronDown className={clsx('h-3.5 w-3.5 text-gray-400 transition-transform flex-shrink-0', open && 'rotate-180')} />
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[99999] rounded-lg border border-border bg-surface-1 shadow-2xl py-1 animate-fade-in overflow-y-auto max-h-[300px]"
          style={{
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            width: pos?.width ?? 'auto',
            visibility: pos ? 'visible' : 'hidden',
          }}
        >
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
              <span className="truncate">{opt.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}

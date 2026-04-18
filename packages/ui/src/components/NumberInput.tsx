import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { clsx } from 'clsx'

export interface NumberSuggestion {
  value: number
  label: string
  /** Optional helper text shown after the value, e.g. "Clash 默认". */
  hint?: string
}

interface NumberInputProps {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  className?: string
  placeholder?: string
  /** Optional dropdown of preset values. When provided, a chevron is shown. */
  suggestions?: readonly NumberSuggestion[]
}

interface Pos {
  left: number
  top: number
  width: number
}

/**
 * 自定义数字输入框：
 * - 单一圆角输入框，不用原生 type="number"（避免浏览器旋钮 / 滚轮意外改值）
 * - type="text" + 输入期允许空串 / "-" 暂存；失焦 / 回车 clamp 到 [min, max] 回写
 * - ArrowUp / ArrowDown 键盘按 step 增减
 * - 可选 suggestions：右侧 chevron 打开下拉，类似 Select，用来快速选常见预设值
 */
export function NumberInput({
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  disabled,
  className,
  placeholder,
  suggestions,
}: NumberInputProps) {
  const [draft, setDraft] = useState<string>(String(value))
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<Pos | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setDraft(String(value))
  }, [value])

  const clamp = useCallback(
    (n: number) => Math.max(min, Math.min(max, n)),
    [min, max],
  )

  const commit = useCallback(
    (raw: string) => {
      const trimmed = raw.trim()
      if (trimmed === '' || trimmed === '-') {
        setDraft(String(value))
        return
      }
      const n = Number(trimmed)
      if (!Number.isFinite(n)) {
        setDraft(String(value))
        return
      }
      const clamped = clamp(n)
      setDraft(String(clamped))
      if (clamped !== value) onChange(clamped)
    },
    [value, onChange, clamp],
  )

  // 下拉定位（portal + fixed，避开 overflow 裁剪）
  useLayoutEffect(() => {
    if (!open || !rootRef.current) return
    const rect = rootRef.current.getBoundingClientRect()
    setPos({ left: rect.left, top: rect.bottom + 4, width: Math.max(rect.width, 200) })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (
        rootRef.current && !rootRef.current.contains(t) &&
        menuRef.current && !menuRef.current.contains(t)
      ) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
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

  const hasSuggestions = suggestions && suggestions.length > 0

  return (
    <div
      ref={rootRef}
      className={clsx(
        'relative inline-flex items-stretch rounded-lg',
        'bg-surface-2',
        'focus-within:ring-2 focus-within:ring-primary-500/30',
        'transition-all',
        disabled && 'opacity-40 cursor-not-allowed',
        className,
      )}
    >
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => {
          const v = e.target.value.replace(/[^\d-]/g, '').replace(/(?!^)-/g, '')
          setDraft(v)
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit((e.target as HTMLInputElement).value)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            const next = clamp(value + step)
            if (next !== value) onChange(next)
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            const next = clamp(value - step)
            if (next !== value) onChange(next)
          }
        }}
        className={clsx(
          'flex-1 min-w-0 bg-transparent text-[13px] font-medium tabular-nums',
          'text-gray-900 dark:text-gray-100 placeholder:text-gray-400',
          'focus:outline-none rounded-lg',
          hasSuggestions ? 'pl-3 pr-1 py-1.5' : 'px-3 py-1.5',
        )}
      />
      {hasSuggestions && (
        <button
          type="button"
          onClick={() => !disabled && setOpen((v) => !v)}
          disabled={disabled}
          tabIndex={-1}
          aria-label="选择常见端口"
          className={clsx(
            'flex items-center justify-center pr-2.5 pl-1',
            'text-gray-400 hover:text-gray-100',
            'disabled:opacity-30 transition-colors',
          )}
        >
          <ChevronDown className={clsx('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
        </button>
      )}

      {open && hasSuggestions && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[99999] rounded-lg border border-border bg-surface-1 shadow-2xl py-1 animate-fade-in max-h-[280px] overflow-y-auto"
          style={{
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            width: pos?.width ?? 'auto',
            visibility: pos ? 'visible' : 'hidden',
          }}
        >
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gray-500 border-b border-white/[0.04]">
            常见端口
          </div>
          {suggestions!.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onChange(clamp(opt.value))
                setDraft(String(clamp(opt.value)))
                setOpen(false)
                inputRef.current?.focus()
              }}
              className={clsx(
                'flex items-center justify-between w-full gap-3 px-3 py-1.5 text-[12px] text-left transition-colors',
                'hover:bg-surface-2',
                opt.value === value ? 'text-primary-500 font-medium' : 'text-gray-700 dark:text-gray-300',
              )}
            >
              <span className="flex items-center gap-2">
                <span className="font-mono tabular-nums">{opt.value}</span>
                <span className="text-gray-400">{opt.label}</span>
              </span>
              {opt.hint && <span className="text-[10px] text-gray-500">{opt.hint}</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}

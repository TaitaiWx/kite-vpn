import { clsx } from 'clsx'

interface InputProps {
  value: string | number
  onChange: (value: string) => void
  type?: 'text' | 'number' | 'url' | 'password'
  placeholder?: string
  disabled?: boolean
  className?: string
  min?: number
  max?: number
}

export function Input({ value, onChange, type = 'text', placeholder, disabled, className, min, max }: InputProps) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      min={min}
      max={max}
      className={clsx(
        'px-3 py-1.5 rounded-lg text-[13px] font-medium',
        'bg-surface-2 border border-border',
        'text-gray-900 dark:text-gray-100',
        'placeholder:text-gray-400',
        'focus:ring-2 focus:ring-primary-500/30 focus:border-primary-500/50 focus:outline-none',
        'transition-all duration-150',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        type === 'number' && 'w-24 text-right tabular-nums',
        className,
      )}
    />
  )
}

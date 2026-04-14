import { X, CheckCircle2, AlertCircle, AlertTriangle, Info } from 'lucide-react'
import { clsx } from 'clsx'
import { useToastStore, type ToastType } from '@/stores/toast'

const ICON_MAP: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle2 className="h-4 w-4 text-green-500" />,
  error: <AlertCircle className="h-4 w-4 text-red-500" />,
  warning: <AlertTriangle className="h-4 w-4 text-amber-500" />,
  info: <Info className="h-4 w-4 text-blue-500" />,
}

const BG_MAP: Record<ToastType, string> = {
  success: 'border-green-200 dark:border-green-500/30 bg-green-50 dark:bg-green-500/10',
  error: 'border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10',
  warning: 'border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10',
  info: 'border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/10',
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)
  const remove = useToastStore((s) => s.remove)

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx(
            'flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg border shadow-lg backdrop-blur-sm animate-fade-in',
            BG_MAP[t.type],
          )}
        >
          <span className="flex-shrink-0 mt-0.5">{ICON_MAP[t.type]}</span>
          <p className="text-sm text-gray-800 dark:text-gray-200 flex-1 break-words">{t.message}</p>
          <button
            type="button"
            onClick={() => remove(t.id)}
            className="flex-shrink-0 p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5"
          >
            <X className="h-3.5 w-3.5 text-gray-400" />
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * Subscriptions page — manage proxy subscription URLs.
 *
 * Features:
 * - Table/list of subscriptions with name, URL, node count, status, last update, traffic bar
 * - Actions: update, toggle enable/disable, edit, delete
 * - "Add Subscription" button → modal with name + URL fields
 * - "Update All" button
 * - Merge strategy display
 *
 * NO `any` types — fully typed with @kite-vpn/types.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  Plus,
  RefreshCw,
  Trash2,
  Pencil,
  ToggleLeft,
  ToggleRight,
  X,
  ExternalLink,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Clock,
  HardDrive,
  Link2,
  Zap,
} from 'lucide-react'
import { clsx } from 'clsx'
import type { Subscription, SubscriptionStatus } from '@kite-vpn/types'
import { useSubscriptionStore } from '@/stores/subscription'
import { formatBytes, formatDate, formatRelativeTime } from '@/lib/format'

// ---------------------------------------------------------------------------
// Status visual map
// ---------------------------------------------------------------------------

interface StatusVisual {
  readonly icon: React.ReactNode
  readonly label: string
  readonly color: string
  readonly bgColor: string
}

function getStatusVisual(status: SubscriptionStatus, error?: string): StatusVisual {
  switch (status) {
    case 'success':
      return {
        icon: <CheckCircle2 className="h-3.5 w-3.5" />,
        label: '正常',
        color: 'text-green-600 dark:text-green-400',
        bgColor: 'bg-green-50 dark:bg-green-500/10',
      }
    case 'updating':
      return {
        icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
        label: '更新中',
        color: 'text-blue-600 dark:text-blue-400',
        bgColor: 'bg-blue-50 dark:bg-blue-500/10',
      }
    case 'error':
      return {
        icon: <AlertCircle className="h-3.5 w-3.5" />,
        label: error ? '错误' : '失败',
        color: 'text-red-600 dark:text-red-400',
        bgColor: 'bg-red-50 dark:bg-red-500/10',
      }
    case 'idle':
    default:
      return {
        icon: <Clock className="h-3.5 w-3.5" />,
        label: '待更新',
        color: 'text-gray-500 dark:text-gray-400',
        bgColor: 'bg-gray-50 dark:bg-gray-700/30',
      }
  }
}

// ---------------------------------------------------------------------------
// Traffic usage bar
// ---------------------------------------------------------------------------

interface TrafficBarProps {
  upload: number
  download: number
  total: number
}

function TrafficBar({ upload, download, total }: TrafficBarProps) {
  if (total <= 0) {
    return (
      <span className="text-xs text-gray-400 dark:text-gray-500">无流量信息</span>
    )
  }

  const used = upload + download
  const percentage = Math.min((used / total) * 100, 100)

  const barColor =
    percentage > 90
      ? 'bg-red-500'
      : percentage > 70
        ? 'bg-amber-500'
        : 'bg-primary-500'

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-gray-500 dark:text-gray-400">
          {formatBytes(used)} / {formatBytes(total)}
        </span>
        <span className="text-gray-400 dark:text-gray-500 ml-2">
          {percentage.toFixed(1)}%
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
        <div
          className={clsx('h-full rounded-full transition-all duration-500', barColor)}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Subscription row
// ---------------------------------------------------------------------------

interface SubscriptionRowProps {
  subscription: Subscription
  onUpdate: (id: string) => void
  onToggle: (id: string) => void
  onEdit: (subscription: Subscription) => void
  onDelete: (id: string) => void
}

function SubscriptionRow({
  subscription,
  onUpdate,
  onToggle,
  onEdit,
  onDelete,
}: SubscriptionRowProps) {
  const statusVisual = getStatusVisual(subscription.status, subscription.error)
  const isUpdating = subscription.status === 'updating'

  return (
    <div
      className={clsx(
        'card p-4 transition-all duration-200',
        !subscription.enabled && 'opacity-60',
      )}
    >
      <div className="flex items-start gap-4">
        {/* Left: info */}
        <div className="flex-1 min-w-0 space-y-2.5">
          {/* Name + status */}
          <div className="flex items-center gap-2.5">
            <span
              className={clsx(
                'font-medium text-sm',
                subscription.enabled
                  ? 'text-gray-900 dark:text-gray-100'
                  : 'text-gray-500 dark:text-gray-400',
              )}
            >
              {subscription.name}
            </span>
            <span
              className={clsx(
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium',
                statusVisual.bgColor,
                statusVisual.color,
              )}
            >
              {statusVisual.icon}
              {statusVisual.label}
            </span>
            {!subscription.enabled && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400">
                已禁用
              </span>
            )}
          </div>

          {/* URL */}
          <div className="flex items-center gap-1.5">
            <Link2 className="h-3 w-3 text-gray-400 dark:text-gray-500 flex-shrink-0" />
            <span
              className="text-xs text-gray-400 dark:text-gray-500 truncate max-w-[400px]"
              title={subscription.url}
            >
              {subscription.url}
            </span>
          </div>

          {/* Meta row */}
          <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
            <span className="inline-flex items-center gap-1">
              <HardDrive className="h-3 w-3" />
              {subscription.nodes.length} 节点
            </span>
            {subscription.lastUpdate && (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatRelativeTime(subscription.lastUpdate)}
              </span>
            )}
            <span className="text-gray-300 dark:text-gray-600">
              每 {subscription.updateIntervalHours}h 自动更新
            </span>
          </div>

          {/* Error message */}
          {subscription.error && subscription.status === 'error' && (
            <div className="flex items-start gap-1.5 text-xs text-red-500 dark:text-red-400">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              <span className="break-all">{subscription.error}</span>
            </div>
          )}

          {/* Traffic bar */}
          {subscription.userInfo && (
            <div className="max-w-xs">
              <TrafficBar
                upload={subscription.userInfo.upload}
                download={subscription.userInfo.download}
                total={subscription.userInfo.total}
              />
            </div>
          )}
        </div>

        {/* Right: actions */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={() => onUpdate(subscription.id)}
            disabled={isUpdating || !subscription.enabled}
            className="btn-ghost p-2 rounded-lg"
            title="更新订阅"
          >
            <RefreshCw
              className={clsx(
                'h-4 w-4',
                isUpdating && 'animate-spin text-primary-500',
              )}
            />
          </button>

          <button
            type="button"
            onClick={() => onToggle(subscription.id)}
            className="btn-ghost p-2 rounded-lg"
            title={subscription.enabled ? '禁用' : '启用'}
          >
            {subscription.enabled ? (
              <ToggleRight className="h-4 w-4 text-green-500" />
            ) : (
              <ToggleLeft className="h-4 w-4 text-gray-400" />
            )}
          </button>

          <button
            type="button"
            onClick={() => onEdit(subscription)}
            className="btn-ghost p-2 rounded-lg"
            title="编辑"
          >
            <Pencil className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => onDelete(subscription.id)}
            className="btn-ghost p-2 rounded-lg hover:text-red-500"
            title="删除"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add / Edit modal
// ---------------------------------------------------------------------------

interface SubscriptionFormData {
  name: string
  url: string
  updateIntervalHours: string
}

interface SubscriptionModalProps {
  open: boolean
  editing: Subscription | null
  onClose: () => void
  onSubmit: (data: SubscriptionFormData) => void
}

function SubscriptionModal({ open, editing, onClose, onSubmit }: SubscriptionModalProps) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [interval, setInterval] = useState('12')

  // Reset form when modal opens / editing changes
  useEffect(() => {
    if (open) {
      if (editing) {
        setName(editing.name)
        setUrl(editing.url)
        setInterval(String(editing.updateIntervalHours))
      } else {
        setName('')
        setUrl('')
        setInterval('12')
      }
    }
  }, [open, editing])

  if (!open) return null

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!name.trim() || !url.trim()) return
    onSubmit({ name: name.trim(), url: url.trim(), updateIntervalHours: interval })
  }

  const isValid = name.trim().length > 0 && url.trim().length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
        role="button"
        tabIndex={0}
        aria-label="关闭弹窗"
      />

      {/* Modal */}
      <div className="relative w-full max-w-md mx-4 card p-0 shadow-xl animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700/50">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {editing ? '编辑订阅' : '添加订阅'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost p-1.5 rounded-lg"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="sub-name"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              名称
            </label>
            <input
              id="sub-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: 我的订阅"
              className="input"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="sub-url"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              订阅链接
            </label>
            <input
              id="sub-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/subscribe?token=..."
              className="input"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="sub-interval"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              自动更新间隔（小时）
            </label>
            <input
              id="sub-interval"
              type="number"
              min="1"
              max="168"
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              className="input w-28"
            />
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary text-sm">
              取消
            </button>
            <button type="submit" disabled={!isValid} className="btn-primary text-sm">
              {editing ? '保存' : '添加'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Delete confirmation modal
// ---------------------------------------------------------------------------

interface DeleteModalProps {
  open: boolean
  subscriptionName: string
  onClose: () => void
  onConfirm: () => void
}

function DeleteModal({ open, subscriptionName, onClose, onConfirm }: DeleteModalProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
        role="button"
        tabIndex={0}
        aria-label="关闭弹窗"
      />

      <div className="relative w-full max-w-sm mx-4 card p-5 shadow-xl animate-fade-in">
        <div className="flex items-start gap-3">
          <div className="flex items-center justify-center h-10 w-10 rounded-full bg-red-100 dark:bg-red-500/15 flex-shrink-0">
            <AlertCircle className="h-5 w-5 text-red-500" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              删除订阅
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              确定要删除 <span className="font-medium text-gray-700 dark:text-gray-300">{subscriptionName}</span> 吗？
              此操作无法撤销。
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 mt-5">
          <button type="button" onClick={onClose} className="btn-secondary text-sm">
            取消
          </button>
          <button type="button" onClick={onConfirm} className="btn-danger text-sm">
            删除
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function Subscriptions() {
  const subscriptions = useSubscriptionStore((s) => s.subscriptions)
  const loaded = useSubscriptionStore((s) => s.loaded)
  const updatingAll = useSubscriptionStore((s) => s.updatingAll)
  const load = useSubscriptionStore((s) => s.load)
  const addSubscription = useSubscriptionStore((s) => s.addSubscription)
  const removeSubscription = useSubscriptionStore((s) => s.removeSubscription)
  const toggleSubscription = useSubscriptionStore((s) => s.toggleSubscription)
  const refreshSubscription = useSubscriptionStore((s) => s.refreshSubscription)
  const refreshAll = useSubscriptionStore((s) => s.refreshAll)

  const [modalOpen, setModalOpen] = useState(false)
  const [editingSubscription, setEditingSubscription] = useState<Subscription | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Subscription | null>(null)

  // Initial load
  useEffect(() => {
    load()
  }, [load])

  const handleAdd = useCallback(() => {
    setEditingSubscription(null)
    setModalOpen(true)
  }, [])

  const handleEdit = useCallback((sub: Subscription) => {
    setEditingSubscription(sub)
    setModalOpen(true)
  }, [])

  const updateSubscription = useSubscriptionStore((s) => s.updateSubscription)

  const handleModalSubmit = useCallback(
    (data: SubscriptionFormData) => {
      const hours = parseInt(data.updateIntervalHours, 10)
      if (editingSubscription) {
        updateSubscription(editingSubscription.id, {
          name: data.name,
          url: data.url,
          updateIntervalHours: Number.isFinite(hours) && hours > 0 ? hours : 12,
        })
      } else {
        void addSubscription(data.name, data.url)
      }
      setModalOpen(false)
      setEditingSubscription(null)
    },
    [editingSubscription, addSubscription, updateSubscription],
  )

  const handleDelete = useCallback((id: string) => {
    const sub = subscriptions.find((s) => s.id === id)
    if (sub) setDeleteTarget(sub)
  }, [subscriptions])

  const confirmDelete = useCallback(() => {
    if (deleteTarget) {
      removeSubscription(deleteTarget.id)
      setDeleteTarget(null)
    }
  }, [deleteTarget, removeSubscription])

  const handleUpdate = useCallback(
    (id: string) => {
      void refreshSubscription(id)
    },
    [refreshSubscription],
  )

  const handleUpdateAll = useCallback(() => {
    void refreshAll()
  }, [refreshAll])

  // Stats
  const totalNodes = subscriptions.reduce((acc, s) => acc + s.nodes.length, 0)
  const enabledCount = subscriptions.filter((s) => s.enabled).length

  if (!loaded) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3.5 border-b border-border">
        <div>
          <h1 className="text-base font-bold text-gray-900 dark:text-white tracking-tight">订阅管理</h1>
          <p className="text-[11px] text-gray-400 mt-0.5">
            {subscriptions.length} 个订阅 · {enabledCount} 启用 · {totalNodes} 个节点
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleUpdateAll}
            disabled={updatingAll}
            className="btn-secondary text-xs py-1.5 px-3"
          >
            {updatingAll ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>更新中…</span>
              </>
            ) : (
              <>
                <RefreshCw className="h-3.5 w-3.5" />
                <span>全部更新</span>
              </>
            )}
          </button>

          <button type="button" onClick={handleAdd} className="btn-primary text-xs py-1.5 px-3">
            <Plus className="h-3.5 w-3.5" />
            <span>添加订阅</span>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {subscriptions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400">
            <ExternalLink className="h-8 w-8 mb-2 opacity-50" />
            <span className="text-[13px] font-medium">暂无订阅</span>
            <span className="text-[11px] mt-1 opacity-60">添加订阅链接开始使用</span>
          </div>
        ) : (
          <div className="space-y-2">
            {subscriptions.map((sub) => (
              <SubscriptionRow
                key={sub.id}
                subscription={sub}
                onUpdate={handleUpdate}
                onToggle={toggleSubscription}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>

      {/* Modals */}
      <SubscriptionModal
        open={modalOpen}
        editing={editingSubscription}
        onClose={() => {
          setModalOpen(false)
          setEditingSubscription(null)
        }}
        onSubmit={handleModalSubmit}
      />

      <DeleteModal
        open={deleteTarget !== null}
        subscriptionName={deleteTarget?.name ?? ''}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
    </div>
  )
}

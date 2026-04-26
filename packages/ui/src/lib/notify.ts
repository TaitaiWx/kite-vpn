/**
 * Native notification wrapper.
 *
 * Uses `tauri-plugin-notification` when running inside Tauri (already
 * registered in `lib.rs`). Falls back to in-app toasts in dev / browser
 * mode so feature code can call `notify()` unconditionally.
 *
 * Requests permission lazily on first call. Tauri's plugin handles
 * platform differences (NSUserNotification on macOS, Notification on
 * Win10+, libnotify on Linux).
 */

import { toast } from '@/stores/toast'

interface NotifyArgs {
  title: string
  body: string
  /** Tag — used for de-duplication. Same tag in short window = silent. */
  tag?: string
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window
}

// Per-tag dedup: don't notify the same thing twice in 60s
const recentNotifications = new Map<string, number>()
const DEDUP_WINDOW_MS = 60_000

function isDuplicate(tag: string | undefined): boolean {
  if (!tag) return false
  const last = recentNotifications.get(tag)
  const now = Date.now()
  if (last && now - last < DEDUP_WINDOW_MS) return true
  recentNotifications.set(tag, now)
  return false
}

let permissionGranted: boolean | null = null

async function ensurePermission(): Promise<boolean> {
  if (permissionGranted !== null) return permissionGranted
  if (!isTauri()) return false
  try {
    const mod = await import('@tauri-apps/plugin-notification')
    const granted = await mod.isPermissionGranted()
    if (granted) {
      permissionGranted = true
      return true
    }
    const result = await mod.requestPermission()
    permissionGranted = result === 'granted'
    return permissionGranted
  } catch (e) {
    console.warn('[notify] permission check failed:', e)
    permissionGranted = false
    return false
  }
}

/**
 * Send a native notification. In browser/dev mode, falls back to a toast.
 *
 * Returns true if the notification was actually sent (or queued for the OS),
 * false on dedup/permission denial/error.
 */
export async function notify(args: NotifyArgs): Promise<boolean> {
  if (isDuplicate(args.tag)) return false

  if (!isTauri()) {
    // Browser dev fallback — surface as toast so the developer still sees it
    toast(`${args.title}: ${args.body}`, 'warning')
    return true
  }

  const ok = await ensurePermission()
  if (!ok) {
    toast(`${args.title}: ${args.body}`, 'warning')
    return false
  }

  try {
    const mod = await import('@tauri-apps/plugin-notification')
    await mod.sendNotification({ title: args.title, body: args.body })
    return true
  } catch (e) {
    console.warn('[notify] sendNotification failed:', e)
    toast(`${args.title}: ${args.body}`, 'warning')
    return false
  }
}

/**
 * Convenience: notify that the active node lost connection.
 */
export function notifyDisconnect(nodeName: string, reason: string): Promise<boolean> {
  return notify({
    title: '节点连接异常',
    body: `「${nodeName}」${reason}`,
    tag: `disconnect:${nodeName}`,
  })
}

/**
 * Convenience: notify that we auto-switched to a healthy backup node.
 */
export function notifyAutoSwitch(fromNode: string, toNode: string, group: string): Promise<boolean> {
  return notify({
    title: '已自动切换节点',
    body: `「${fromNode}」失效，切换到「${toNode}」（${group}）`,
    tag: `switch:${group}`,
  })
}

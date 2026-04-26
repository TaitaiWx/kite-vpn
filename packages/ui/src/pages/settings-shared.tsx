/**
 * Shared primitives + constants for the Settings page.
 *
 * Extracted from `Settings.tsx` so future settings sections (e.g., the
 * upcoming Sync settings in Phase 4) can reuse the same row, section,
 * toggle, and option vocabulary without copy-paste.
 *
 * NO `any` types — fully typed with @kite-vpn/types.
 */

import type React from 'react'
import { clsx } from 'clsx'
import { HelpCircle } from 'lucide-react'
import type { AppConfig, ProxyMode, LogLevel } from '@kite-vpn/types'
import { Tooltip } from '@/components/Tooltip'
import { Input } from '@/components/Input'
import type { NumberSuggestion } from '@/components/NumberInput'

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window
}

// ---------------------------------------------------------------------------
// Toggle switch component
// ---------------------------------------------------------------------------

interface ToggleSwitchProps {
  enabled: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  label?: string
}

export function ToggleSwitch({ enabled, onChange, disabled = false, label }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      className={clsx(
        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 ease-in-out cursor-pointer',
        'focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[#1e1e2e]',
        enabled ? 'bg-primary-500' : 'bg-gray-300 dark:bg-gray-600',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      <span
        className={clsx(
          'inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transform transition-transform duration-200 ease-in-out',
          enabled ? 'translate-x-[18px]' : 'translate-x-[3px]',
        )}
      />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Text input wrapper (delegates to the design-system Input)
// ---------------------------------------------------------------------------

interface TextInputProps {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  className?: string
  placeholder?: string
}

export function TextInput({ value, onChange, disabled, className, placeholder }: TextInputProps) {
  return <Input type="text" value={value} onChange={onChange} disabled={disabled} className={className} placeholder={placeholder} />
}

// ---------------------------------------------------------------------------
// Settings row — one configurable item with label + control
// ---------------------------------------------------------------------------

interface SettingsRowProps {
  label: string
  description?: string
  help?: string
  children: React.ReactNode
  vertical?: boolean
}

export function SettingsRow({ label, description, help, children, vertical = false }: SettingsRowProps) {
  return (
    <div
      className={clsx(
        'flex gap-4 py-2.5 px-4 -mx-4 rounded-xl hover:bg-surface-2/50 transition-colors',
        vertical ? 'flex-col' : 'items-center justify-between',
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-medium text-gray-800 dark:text-gray-200">{label}</span>
          {help && (
            <Tooltip text={help}>
              <span className="inline-flex text-gray-400 hover:text-gray-200 cursor-help">
                <HelpCircle size={12} />
              </span>
            </Tooltip>
          )}
        </div>
        {description && (
          <p className="text-[11px] text-gray-400 mt-0.5">{description}</p>
        )}
      </div>
      <div className={clsx(vertical ? 'w-full' : 'flex-shrink-0')}>{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Settings section — a group of related rows
// ---------------------------------------------------------------------------

interface SettingsSectionProps {
  icon: React.ReactNode
  title: string
  description?: string
  children: React.ReactNode
}

export function SettingsSection({ icon, title, description: _description, children }: SettingsSectionProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 px-1 mb-2">
        <span className="text-gray-400">{icon}</span>
        <span className="text-[12px] font-semibold text-gray-400 uppercase tracking-wider">{title}</span>
      </div>
      <div className="space-y-0.5 px-1">{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Type aliases used by the settings options
// ---------------------------------------------------------------------------

export interface SelectOption<T extends string> {
  value: T
  label: string
  icon?: React.ReactNode
}

export type ThemeValue = AppConfig['theme']
export type LanguageValue = AppConfig['language']
export type DnsEnhancedMode = 'fake-ip' | 'redir-host'
export type TunStack = 'system' | 'gvisor' | 'mixed'

// ---------------------------------------------------------------------------
// Option constants
// ---------------------------------------------------------------------------

export const THEME_OPTIONS: readonly SelectOption<ThemeValue>[] = [
  { value: 'light', label: '☀️ 浅色' },
  { value: 'dark', label: '🌙 深色' },
  { value: 'system', label: '🖥️ 跟随系统' },
] as const

export const LANGUAGE_OPTIONS: readonly SelectOption<LanguageValue>[] = [
  { value: 'zh-CN', label: '简体中文' },
] as const

export const MODE_OPTIONS: readonly SelectOption<ProxyMode>[] = [
  { value: 'rule', label: '规则模式' },
  { value: 'global', label: '全局代理' },
  { value: 'direct', label: '直连模式' },
] as const

export const LOG_LEVEL_OPTIONS: readonly SelectOption<LogLevel>[] = [
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Warning' },
  { value: 'error', label: 'Error' },
  { value: 'silent', label: 'Silent' },
] as const

export const DNS_MODE_OPTIONS: readonly SelectOption<DnsEnhancedMode>[] = [
  { value: 'fake-ip', label: 'Fake IP' },
  { value: 'redir-host', label: 'Redir Host' },
] as const

export const TUN_STACK_OPTIONS: readonly SelectOption<TunStack>[] = [
  { value: 'system', label: 'System' },
  { value: 'gvisor', label: 'gVisor' },
  { value: 'mixed', label: 'Mixed' },
] as const

export const COMMON_MIXED_PORTS: readonly NumberSuggestion[] = [
  { value: 7890, label: 'Mixed', hint: 'Clash 默认' },
  { value: 1080, label: 'SOCKS5', hint: '传统 SOCKS' },
  { value: 8080, label: 'HTTP', hint: '传统 HTTP 代理' },
  { value: 8888, label: 'Mixed', hint: '备用端口' },
  { value: 10809, label: 'Mixed', hint: 'V2Ray 默认' },
] as const

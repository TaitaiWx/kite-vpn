/**
 * Settings page — application and engine configuration.
 *
 * Sections:
 * - General: Theme, Language, Auto-start, Start minimized
 * - Network: Mixed port, Allow LAN, Mode default
 * - DNS: Enable, Enhanced mode, Nameservers
 * - TUN: Enable, Stack type
 * - About: Version, check for updates
 *
 * NO `any` types — fully typed with @kite-vpn/types.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  Sun,
  Moon,
  Monitor,
  Globe,
  Wifi,
  Shield,
  Server,
  Info,
  Save,
  RotateCcw,
  ExternalLink,
  Cpu,
  Languages,
  Rocket,
  EyeOff,
  RefreshCw,
  Loader2,
} from 'lucide-react'
import { clsx } from 'clsx'
import type { AppConfig, ProxyMode, LogLevel } from '@kite-vpn/types'
import { getMockAppConfig, loadAppConfig, saveAppConfig } from '@/lib/ipc'
import { toast } from '@/stores/toast'

// ---------------------------------------------------------------------------
// Toggle switch component
// ---------------------------------------------------------------------------

interface ToggleSwitchProps {
  enabled: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  label?: string
}

function ToggleSwitch({ enabled, onChange, disabled = false, label }: ToggleSwitchProps) {
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

// 使用外部组件
import { Select } from '@/components/Select'
import { Input } from '@/components/Input'

function NumberInput({ value, onChange, min, max, disabled, className }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; disabled?: boolean; className?: string
}) {
  return (
    <Input
      type="number"
      value={value}
      min={min}
      max={max}
      disabled={disabled}
      className={className}
      onChange={(v) => {
        const n = parseInt(v, 10)
        if (Number.isFinite(n)) onChange(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n)))
      }}
    />
  )
}

function TextInput({ value, onChange, disabled, className, placeholder }: {
  value: string; onChange: (v: string) => void; disabled?: boolean; className?: string; placeholder?: string
}) {
  return <Input type="text" value={value} onChange={onChange} disabled={disabled} className={className} placeholder={placeholder} />
}

// ---------------------------------------------------------------------------
// Settings row component
// ---------------------------------------------------------------------------

interface SettingsRowProps {
  label: string
  description?: string
  children: React.ReactNode
  vertical?: boolean
}

function SettingsRow({ label, description, children, vertical = false }: SettingsRowProps) {
  return (
    <div
      className={clsx(
        'flex gap-4 py-2.5 px-4 -mx-4 rounded-xl hover:bg-surface-2/50 transition-colors',
        vertical ? 'flex-col' : 'items-center justify-between',
      )}
    >
      <div className="flex-1 min-w-0">
        <span className="text-[13px] font-medium text-gray-800 dark:text-gray-200">{label}</span>
        {description && (
          <p className="text-[11px] text-gray-400 mt-0.5">{description}</p>
        )}
      </div>
      <div className={clsx(vertical ? 'w-full' : 'flex-shrink-0')}>{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section component
// ---------------------------------------------------------------------------

interface SettingsSectionProps {
  icon: React.ReactNode
  title: string
  description?: string
  children: React.ReactNode
}

function SettingsSection({ icon, title, description, children }: SettingsSectionProps) {
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
// Theme option values
// ---------------------------------------------------------------------------

interface SelectOption<T extends string> { value: T; label: string; icon?: React.ReactNode }

type ThemeValue = AppConfig['theme']
type LanguageValue = AppConfig['language']
type DnsEnhancedMode = 'fake-ip' | 'redir-host'
type TunStack = 'system' | 'gvisor' | 'mixed'

const THEME_OPTIONS: readonly SelectOption<ThemeValue>[] = [
  { value: 'light', label: '☀️ 浅色' },
  { value: 'dark', label: '🌙 深色' },
  { value: 'system', label: '🖥️ 跟随系统' },
] as const

const LANGUAGE_OPTIONS: readonly SelectOption<LanguageValue>[] = [
  { value: 'zh-CN', label: '简体中文' },
] as const

const MODE_OPTIONS: readonly SelectOption<ProxyMode>[] = [
  { value: 'rule', label: '规则模式' },
  { value: 'global', label: '全局代理' },
  { value: 'direct', label: '直连模式' },
] as const

const LOG_LEVEL_OPTIONS: readonly SelectOption<LogLevel>[] = [
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Warning' },
  { value: 'error', label: 'Error' },
  { value: 'silent', label: 'Silent' },
] as const

const DNS_MODE_OPTIONS: readonly SelectOption<DnsEnhancedMode>[] = [
  { value: 'fake-ip', label: 'Fake IP' },
  { value: 'redir-host', label: 'Redir Host' },
] as const

const TUN_STACK_OPTIONS: readonly SelectOption<TunStack>[] = [
  { value: 'system', label: 'System' },
  { value: 'gvisor', label: 'gVisor' },
  { value: 'mixed', label: 'Mixed' },
] as const

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function Settings() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void (async () => {
      const result = await loadAppConfig()
      const cfg = (result.success && result.data) ? result.data : getMockAppConfig()
      setConfig(cfg)
      // 应用主题
      if (cfg.theme === 'dark') document.documentElement.classList.add('dark')
      else if (cfg.theme === 'light') document.documentElement.classList.remove('dark')
      else {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
        document.documentElement.classList.toggle('dark', prefersDark)
      }
    })()
  }, [])

  // Partial updater helper
  const updateConfig = useCallback(
    <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
      setConfig((prev) => (prev ? { ...prev, [key]: value } : prev))
      setSaved(false)

      // 部分设置立即生效
      if (key === 'theme') {
        const theme = value as string
        if (theme === 'dark') {
          document.documentElement.classList.add('dark')
        } else if (theme === 'light') {
          document.documentElement.classList.remove('dark')
        } else {
          // system
          const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
          document.documentElement.classList.toggle('dark', prefersDark)
        }
      }
    },
    [],
  )

  const updateEngineConfig = useCallback(
    <K extends keyof AppConfig['engineConfig']>(key: K, value: AppConfig['engineConfig'][K]) => {
      setConfig((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          engineConfig: { ...prev.engineConfig, [key]: value },
        }
      })
      setSaved(false)
    },
    [],
  )

  const updateDnsConfig = useCallback(
    <K extends keyof NonNullable<AppConfig['engineConfig']['dns']>>(
      key: K,
      value: NonNullable<AppConfig['engineConfig']['dns']>[K],
    ) => {
      setConfig((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          engineConfig: {
            ...prev.engineConfig,
            dns: { ...prev.engineConfig.dns, [key]: value },
          },
        }
      })
      setSaved(false)
    },
    [],
  )

  const updateTunConfig = useCallback(
    <K extends keyof NonNullable<AppConfig['engineConfig']['tun']>>(
      key: K,
      value: NonNullable<AppConfig['engineConfig']['tun']>[K],
    ) => {
      setConfig((prev) => {
        if (!prev) return prev
        const currentTun = prev.engineConfig.tun ?? {
          enabled: false,
          stack: 'gvisor' as const,
          autoRoute: true,
          autoDetectInterface: true,
        }
        return {
          ...prev,
          engineConfig: {
            ...prev.engineConfig,
            tun: { ...currentTun, [key]: value },
          },
        }
      })
      setSaved(false)
    },
    [],
  )

  const handleSave = useCallback(async () => {
    if (!config) return
    setSaving(true)
    try {
      const result = await saveAppConfig(config)
      if (result.success) {
        setSaved(true)
        toast('配置已保存', 'success')
        setTimeout(() => setSaved(false), 2000)
      } else {
        toast(result.error ?? '保存失败', 'error')
      }
    } catch {
      toast('保存配置时发生错误', 'error')
    } finally {
      setSaving(false)
    }
  }, [config])

  // Reset handler
  const handleReset = useCallback(() => {
    setConfig(getMockAppConfig())
    setSaved(false)
  }, [])

  if (!config) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    )
  }

  const { engineConfig } = config
  const tunConfig = engineConfig.tun ?? {
    enabled: false,
    stack: 'gvisor' as const,
    autoRoute: true,
    autoDetectInterface: true,
  }

  return (
    <div className="h-full flex flex-col animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700/50 flex-shrink-0">
        <div>
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">设置</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            应用程序与引擎配置
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleReset}
            className="btn-secondary text-xs py-1.5 px-3"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>重置</span>
          </button>

          <button
            type="button"
            onClick={() => { void handleSave() }}
            disabled={saving || saved}
            className={clsx(
              'text-xs py-1.5 px-3',
              saved ? 'btn-secondary text-green-600 dark:text-green-400' : 'btn-primary',
            )}
          >
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>保存中…</span>
              </>
            ) : saved ? (
              <>
                <Save className="h-3.5 w-3.5" />
                <span>已保存</span>
              </>
            ) : (
              <>
                <Save className="h-3.5 w-3.5" />
                <span>保存</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
        {/* ── General ─────────────────────────────────────────────── */}
        <SettingsSection
          icon={<Monitor size={16} />}
          title="通用"
          description="外观与启动行为设置"
        >
          <SettingsRow label="主题" description="选择应用程序的配色主题">
            <Select<ThemeValue>
              value={config.theme}
              options={THEME_OPTIONS}
              onChange={(v) => updateConfig('theme', v)}
              className="w-36"
            />
          </SettingsRow>

          <SettingsRow label="语言" description="设置界面显示语言">
            <Select<LanguageValue>
              value={config.language}
              options={LANGUAGE_OPTIONS}
              onChange={(v) => updateConfig('language', v)}
              className="w-36"
            />
          </SettingsRow>

          <SettingsRow label="开机自启" description="系统启动时自动运行 Kite">
            <ToggleSwitch
              enabled={config.autoStart}
              onChange={(v) => {
                updateConfig('autoStart', v)
                void (async () => {
                  try {
                    const { invoke } = await import('@/lib/ipc')
                    await invoke('set_autostart', { enabled: v })
                  } catch { /* 浏览器模式忽略 */ }
                })()
              }}
              label="开机自启"
            />
          </SettingsRow>

          <SettingsRow label="启动时最小化" description="启动后自动隐藏到系统托盘">
            <ToggleSwitch
              enabled={config.startMinimized}
              onChange={(v) => updateConfig('startMinimized', v)}
              label="启动时最小化"
            />
          </SettingsRow>

          <SettingsRow label="自动检查更新" description="启动时检查是否有新版本可用">
            <ToggleSwitch
              enabled={config.checkUpdateOnStart}
              onChange={(v) => updateConfig('checkUpdateOnStart', v)}
              label="自动检查更新"
            />
          </SettingsRow>

          <SettingsRow label="系统代理" description="自动设置操作系统代理">
            <ToggleSwitch
              enabled={config.systemProxy}
              onChange={(v) => updateConfig('systemProxy', v)}
              label="系统代理"
            />
          </SettingsRow>
        </SettingsSection>

        {/* ── Network ─────────────────────────────────────────────── */}
        <SettingsSection
          icon={<Wifi size={16} />}
          title="网络"
          description="代理端口与网络访问控制"
        >
          <SettingsRow label="混合代理端口" description="HTTP 与 SOCKS5 共用端口">
            <NumberInput
              value={engineConfig.mixedPort}
              onChange={(v) => updateEngineConfig('mixedPort', v)}
              min={1}
              max={65535}
              className="w-28"
            />
          </SettingsRow>

          <SettingsRow label="允许局域网访问" description="允许其他设备通过本机代理上网">
            <ToggleSwitch
              enabled={engineConfig.allowLan}
              onChange={(v) => updateEngineConfig('allowLan', v)}
              label="允许局域网访问"
            />
          </SettingsRow>

          <SettingsRow label="默认模式" description="代理路由的默认运行模式">
            <Select<ProxyMode>
              value={engineConfig.mode}
              options={MODE_OPTIONS}
              onChange={(v) => updateEngineConfig('mode', v)}
              className="w-36"
            />
          </SettingsRow>

          <SettingsRow label="日志级别" description="引擎运行日志的详细程度">
            <Select<LogLevel>
              value={engineConfig.logLevel}
              options={LOG_LEVEL_OPTIONS}
              onChange={(v) => updateEngineConfig('logLevel', v)}
              className="w-36"
            />
          </SettingsRow>

          {engineConfig.externalController !== undefined && (
            <SettingsRow label="外部控制器" description="RESTful API 监听地址">
              <TextInput
                value={engineConfig.externalController ?? ''}
                onChange={(v) => updateEngineConfig('externalController', v)}
                placeholder="127.0.0.1:9090"
                className="w-44"
              />
            </SettingsRow>
          )}
        </SettingsSection>

        {/* ── DNS ─────────────────────────────────────────────────── */}
        <SettingsSection
          icon={<Globe size={16} />}
          title="DNS"
          description="域名解析与 DNS 服务器配置"
        >
          <SettingsRow label="启用 DNS" description="使用内置 DNS 服务器进行域名解析">
            <ToggleSwitch
              enabled={engineConfig.dns.enabled}
              onChange={(v) => updateDnsConfig('enabled', v)}
              label="启用 DNS"
            />
          </SettingsRow>

          <SettingsRow label="增强模式" description="DNS 请求处理方式">
            <Select<DnsEnhancedMode>
              value={engineConfig.dns.enhancedMode ?? 'fake-ip'}
              options={DNS_MODE_OPTIONS}
              onChange={(v) => updateDnsConfig('enhancedMode', v)}
              disabled={!engineConfig.dns.enabled}
              className="w-36"
            />
          </SettingsRow>

          <SettingsRow label="Fake IP 范围" description="Fake IP 地址池 CIDR">
            <TextInput
              value={engineConfig.dns.fakeIpRange ?? '198.18.0.1/16'}
              onChange={(v) => updateDnsConfig('fakeIpRange', v)}
              disabled={!engineConfig.dns.enabled || engineConfig.dns.enhancedMode !== 'fake-ip'}
              placeholder="198.18.0.1/16"
              className="w-44"
            />
          </SettingsRow>

          <SettingsRow
            label="DNS 服务器"
            description="主要 DNS 服务器地址（每行一个）"
            vertical
          >
            <textarea
              value={engineConfig.dns.nameservers.join('\n')}
              onChange={(e) => {
                const servers = e.target.value.split('\n').filter((line) => line.trim().length > 0)
                updateDnsConfig('nameservers', servers)
              }}
              disabled={!engineConfig.dns.enabled}
              placeholder="https://dns.alidns.com/dns-query"
              rows={3}
              className={clsx(
                'input resize-y font-mono text-xs leading-relaxed',
                !engineConfig.dns.enabled && 'opacity-50',
              )}
            />
          </SettingsRow>

          <SettingsRow
            label="备用 DNS 服务器"
            description="当主 DNS 失败时使用的备用服务器（每行一个）"
            vertical
          >
            <textarea
              value={(engineConfig.dns.fallback ?? []).join('\n')}
              onChange={(e) => {
                const servers = e.target.value.split('\n').filter((line) => line.trim().length > 0)
                updateDnsConfig('fallback', servers)
              }}
              disabled={!engineConfig.dns.enabled}
              placeholder="https://dns.cloudflare.com/dns-query"
              rows={2}
              className={clsx(
                'input resize-y font-mono text-xs leading-relaxed',
                !engineConfig.dns.enabled && 'opacity-50',
              )}
            />
          </SettingsRow>

          <SettingsRow label="允许 IPv6" description="允许 AAAA 记录解析">
            <ToggleSwitch
              enabled={engineConfig.dns.ipv6 ?? false}
              onChange={(v) => updateDnsConfig('ipv6', v)}
              disabled={!engineConfig.dns.enabled}
              label="允许 IPv6"
            />
          </SettingsRow>
        </SettingsSection>

        {/* ── TUN ─────────────────────────────────────────────────── */}
        <SettingsSection
          icon={<Shield size={16} />}
          title="TUN"
          description="透明代理 TUN 设备配置"
        >
          <SettingsRow label="启用 TUN" description="创建虚拟网络设备进行透明代理">
            <ToggleSwitch
              enabled={tunConfig.enabled}
              onChange={(v) => updateTunConfig('enabled', v)}
              label="启用 TUN"
            />
          </SettingsRow>

          <SettingsRow label="网络栈" description="TUN 设备使用的网络栈实现">
            <Select<TunStack>
              value={tunConfig.stack ?? 'gvisor'}
              options={TUN_STACK_OPTIONS}
              onChange={(v) => updateTunConfig('stack', v)}
              disabled={!tunConfig.enabled}
              className="w-36"
            />
          </SettingsRow>

          <SettingsRow label="自动路由" description="自动配置系统路由表">
            <ToggleSwitch
              enabled={tunConfig.autoRoute ?? true}
              onChange={(v) => updateTunConfig('autoRoute', v)}
              disabled={!tunConfig.enabled}
              label="自动路由"
            />
          </SettingsRow>

          <SettingsRow label="自动检测接口" description="自动检测默认网络出口">
            <ToggleSwitch
              enabled={tunConfig.autoDetectInterface ?? true}
              onChange={(v) => updateTunConfig('autoDetectInterface', v)}
              disabled={!tunConfig.enabled}
              label="自动检测接口"
            />
          </SettingsRow>
        </SettingsSection>

        {/* ── About ───────────────────────────────────────────────── */}
        <SettingsSection
          icon={<Info size={16} />}
          title="关于"
          description="应用信息与更新"
        >
          <SettingsRow label="应用版本" description="当前安装的 Kite 版本">
            <span className="text-sm font-mono text-gray-700 dark:text-gray-300">
              v0.1.0
            </span>
          </SettingsRow>

          <SettingsRow label="引擎版本" description="mihomo 内核版本">
            <span className="text-sm font-mono text-gray-700 dark:text-gray-300">
              v1.18.0
            </span>
          </SettingsRow>

          <SettingsRow label="检查更新" description="检查是否有可用的新版本">
            <button
              type="button"
              className="btn-secondary text-xs py-1.5 px-3"
              onClick={() => {
                void (async () => {
                  try {
                    const { check } = await import('@tauri-apps/plugin-updater')
                    const update = await check()
                    if (update) {
                      toast(`发现新版本 ${update.version}，正在下载...`, 'info')
                      await update.downloadAndInstall()
                      const { relaunch } = await import('@tauri-apps/plugin-process')
                      await relaunch()
                    } else {
                      toast('已是最新版本', 'success')
                    }
                  } catch {
                    toast('检查更新失败', 'error')
                  }
                })()
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>检查更新</span>
            </button>
          </SettingsRow>

          <SettingsRow label="项目主页" description="查看源代码与参与贡献">
            <a
              href="https://github.com/nicekid1/Kite"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost text-xs py-1.5 px-3 text-primary-600 dark:text-primary-400"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span>GitHub</span>
            </a>
          </SettingsRow>

          <div className="py-4">
            <p className="text-xs text-gray-400 dark:text-gray-500 text-center">
              Kite — 跨平台代理客户端
            </p>
            <p className="text-[11px] text-gray-300 dark:text-gray-600 text-center mt-1">
              Built with Tauri + React + TypeScript
            </p>
          </div>
        </SettingsSection>

        {/* Bottom spacing */}
        <div className="h-4" />
      </div>
    </div>
  )
}

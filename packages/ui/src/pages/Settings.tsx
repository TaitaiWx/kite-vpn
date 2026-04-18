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
import { useNavigate } from 'react-router-dom'
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
import { loadAppConfig, saveAppConfig } from '@/lib/ipc'
import { toast } from '@/stores/toast'
import { Tooltip } from '@/components/Tooltip'
import { HelpCircle } from 'lucide-react'

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window
}

declare const __APP_VERSION__: string
const APP_VERSION = __APP_VERSION__

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
import { NumberInput, type NumberSuggestion } from '@/components/NumberInput'

const COMMON_MIXED_PORTS: readonly NumberSuggestion[] = [
  { value: 7890, label: 'Mixed', hint: 'Clash 默认' },
  { value: 1080, label: 'SOCKS5', hint: '传统 SOCKS' },
  { value: 8080, label: 'HTTP', hint: '传统 HTTP 代理' },
  { value: 8888, label: 'Mixed', hint: '备用端口' },
  { value: 10809, label: 'Mixed', hint: 'V2Ray 默认' },
] as const

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
  help?: string
  children: React.ReactNode
  vertical?: boolean
}

function SettingsRow({ label, description, help, children, vertical = false }: SettingsRowProps) {
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
  const navigate = useNavigate()

  useEffect(() => {
    void (async () => {
      const result = await loadAppConfig()
      const cfg: AppConfig = (result.success && result.data) ? result.data : {
        theme: 'dark', language: 'zh-CN', autoStart: false, systemProxy: true,
        startMinimized: false, checkUpdateOnStart: true,
        engineConfig: {
          mixedPort: 7890, allowLan: false, mode: 'rule', logLevel: 'info',
          externalController: '127.0.0.1:9090',
          dns: { enabled: true, enhancedMode: 'fake-ip', fakeIpRange: '198.18.0.1/16',
            nameservers: ['https://dns.google/dns-query', '8.8.8.8'],
            fallback: ['https://1.1.1.1/dns-query'], ipv6: false },
        },
      }
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

  const updateMixin = useCallback(
    <K extends keyof NonNullable<AppConfig['mixin']>>(
      key: K,
      value: NonNullable<AppConfig['mixin']>[K],
    ) => {
      setConfig((prev) => {
        if (!prev) return prev
        const current = prev.mixin ?? { enabled: false, content: '' }
        return { ...prev, mixin: { ...current, [key]: value } }
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
  const handleReset = useCallback(async () => {
    const result = await loadAppConfig()
    if (result.success && result.data) {
      setConfig(result.data)
    }
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

      {/* 左右布局：左侧快速导航 + 右侧内容 */}
      <div className="flex-1 overflow-hidden flex">
        {/* 左侧导航 */}
        <nav className="w-32 flex-shrink-0 border-r border-border py-4 px-2 space-y-0.5 hidden sm:block">
          {[
            { id: 'general', icon: <Monitor size={14} />, label: '通用' },
            { id: 'network', icon: <Wifi size={14} />, label: '网络' },
            { id: 'dns', icon: <Globe size={14} />, label: 'DNS' },
            { id: 'tun', icon: <Shield size={14} />, label: 'TUN' },
            { id: 'mixin', icon: <Server size={14} />, label: 'Mixin' },
            { id: 'about', icon: <Info size={14} />, label: '关于' },
          ].map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              onClick={(e) => {
                e.preventDefault()
                document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] text-gray-500 hover:text-gray-200 hover:bg-surface-2 transition-colors"
            >
              <span className="text-gray-400">{item.icon}</span>
              <span>{item.label}</span>
            </a>
          ))}
        </nav>

        {/* 右侧内容 */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
        {/* ── General ─────────────────────────────────────────────── */}
        <div id="general"><SettingsSection
          icon={<Monitor size={16} />}
          title="通用"
          description="外观与启动行为设置"
        >
          <SettingsRow
            label="主题"
            description="选择应用程序的配色主题"
            help="浅色 / 深色 / 跟随系统。切换后立即生效，不需要重启应用。"
          >
            <Select<ThemeValue>
              value={config.theme}
              options={THEME_OPTIONS}
              onChange={(v) => updateConfig('theme', v)}
              className="w-36"
            />
          </SettingsRow>

          <SettingsRow
            label="语言"
            description="设置界面显示语言"
            help="当前仅支持简体中文。更多语言会在后续版本加入。"
          >
            <Select<LanguageValue>
              value={config.language}
              options={LANGUAGE_OPTIONS}
              onChange={(v) => updateConfig('language', v)}
              className="w-36"
            />
          </SettingsRow>

          <SettingsRow
            label="开机自启"
            description="系统启动时自动运行 Kite"
            help="登录系统后由系统自动拉起 Kite 并常驻托盘，无需手动启动。"
          >
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

          <SettingsRow
            label="启动时最小化"
            description="启动后自动隐藏到系统托盘"
            help="App 启动后不弹出主窗口，直接隐藏到托盘后台运行。需与「开机自启」搭配使用效果更佳。"
          >
            <ToggleSwitch
              enabled={config.startMinimized}
              onChange={(v) => updateConfig('startMinimized', v)}
              label="启动时最小化"
            />
          </SettingsRow>

          <SettingsRow
            label="自动检查更新"
            description="启动时检查是否有新版本可用"
            help="打开后，应用启动时会静默向更新服务器查询最新版本；发现新版本将弹出通知。"
          >
            <ToggleSwitch
              enabled={config.checkUpdateOnStart}
              onChange={(v) => updateConfig('checkUpdateOnStart', v)}
              label="自动检查更新"
            />
          </SettingsRow>

          <SettingsRow
            label="系统代理"
            description="自动设置操作系统代理"
            help="【接入方式 A】通过系统 API 把 HTTP/SOCKS 代理指向 127.0.0.1:7890。✓ 覆盖：读取系统代理的应用（浏览器 / curl 等）。✗ 不覆盖：UDP、某些游戏 / IM。✓ 无需管理员权限，即插即用。与 TUN 通常二选一。"
          >
            <ToggleSwitch
              enabled={config.systemProxy}
              onChange={(v) => updateConfig('systemProxy', v)}
              label="系统代理"
            />
          </SettingsRow>
        </SettingsSection></div>

        {/* ── Network ─────────────────────────────────────────────── */}
        <div id="network"><SettingsSection
          icon={<Wifi size={16} />}
          title="网络"
          description="代理端口与网络访问控制"
        >
          <SettingsRow
            label="混合代理端口"
            description="HTTP 与 SOCKS5 共用端口"
            help="本地监听端口，同时处理 HTTP(S) 与 SOCKS5 流量。建议使用 1024 以上未被占用的端口，默认 7890。点右侧下拉可快速选常见端口。"
          >
            <NumberInput
              value={engineConfig.mixedPort}
              onChange={(v) => updateEngineConfig('mixedPort', v)}
              min={1}
              max={65535}
              suggestions={COMMON_MIXED_PORTS}
              className="w-44"
            />
          </SettingsRow>

          <SettingsRow
            label="允许局域网访问"
            description="允许其他设备通过本机代理上网"
            help="开启后，同一网络下的其他设备（手机、平板等）可以使用本机 IP + 端口作为代理出口。"
          >
            <ToggleSwitch
              enabled={engineConfig.allowLan}
              onChange={(v) => updateEngineConfig('allowLan', v)}
              label="允许局域网访问"
            />
          </SettingsRow>

          <SettingsRow
            label="默认模式"
            description="代理路由的默认运行模式"
            help="规则：按规则表分流（推荐）。全局：所有流量走代理。直连：所有流量直连，代理不生效。"
          >
            <Select<ProxyMode>
              value={engineConfig.mode}
              options={MODE_OPTIONS}
              onChange={(v) => updateEngineConfig('mode', v)}
              className="w-36"
            />
          </SettingsRow>

          <SettingsRow
            label="日志级别"
            description="引擎运行日志的详细程度"
            help="Debug 最详细但性能开销大；Info 推荐；Error 仅记录错误；Silent 关闭日志。"
          >
            <Select<LogLevel>
              value={engineConfig.logLevel}
              options={LOG_LEVEL_OPTIONS}
              onChange={(v) => updateEngineConfig('logLevel', v)}
              className="w-36"
            />
          </SettingsRow>

          {engineConfig.externalController !== undefined && (
            <SettingsRow
              label="外部控制器"
              description="RESTful API 监听地址"
              help="mihomo 的 RESTful API 监听地址，外部工具（如 Yacd/Clash Dashboard）可通过此地址管理引擎。"
            >
              <TextInput
                value={engineConfig.externalController ?? ''}
                onChange={(v) => updateEngineConfig('externalController', v)}
                placeholder="127.0.0.1:9090"
                className="w-44"
              />
            </SettingsRow>
          )}
        </SettingsSection></div>

        {/* ── DNS ─────────────────────────────────────────────────── */}
        <div id="dns"><SettingsSection
          icon={<Globe size={16} />}
          title="DNS"
          description="域名解析与 DNS 服务器配置"
        >
          <SettingsRow
            label="启用 DNS"
            description="使用内置 DNS 服务器进行域名解析"
            help="开启后，代理规则与分流将由引擎内置的 DNS 解析，避免系统 DNS 泄漏和污染。"
          >
            <ToggleSwitch
              enabled={engineConfig.dns.enabled}
              onChange={(v) => updateDnsConfig('enabled', v)}
              label="启用 DNS"
            />
          </SettingsRow>

          <SettingsRow
            label="增强模式"
            description="DNS 请求处理方式"
            help="Fake IP：给每个域名分配虚拟 IP，速度快、分流准确（推荐）；Redir Host：真实解析域名，兼容性更好。"
          >
            <Select<DnsEnhancedMode>
              value={engineConfig.dns.enhancedMode ?? 'fake-ip'}
              options={DNS_MODE_OPTIONS}
              onChange={(v) => updateDnsConfig('enhancedMode', v)}
              disabled={!engineConfig.dns.enabled}
              className="w-36"
            />
          </SettingsRow>

          <SettingsRow
            label="Fake IP 范围"
            description="Fake IP 地址池 CIDR"
            help="Fake IP 模式下分配给域名的虚拟 IP 段。默认 198.18.0.1/16 是保留段，通常不需要修改。"
          >
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
            help="支持 UDP / TCP / DoT(tls://) / DoH(https://)。建议使用加密 DNS 防止污染。"
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
            help="主 DNS 查询失败或返回污染结果时使用。可填国外加密 DNS 如 Cloudflare、Google。"
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

          <SettingsRow
            label="允许 IPv6"
            description="允许 AAAA 记录解析"
            help="如网络环境不支持 IPv6 反而会导致超时，保持关闭更稳定。"
          >
            <ToggleSwitch
              enabled={engineConfig.dns.ipv6 ?? false}
              onChange={(v) => updateDnsConfig('ipv6', v)}
              disabled={!engineConfig.dns.enabled}
              label="允许 IPv6"
            />
          </SettingsRow>
        </SettingsSection></div>

        {/* ── TUN ─────────────────────────────────────────────────── */}
        <div id="tun"><SettingsSection
          icon={<Shield size={16} />}
          title="TUN"
          description="透明代理 TUN 设备配置"
        >
          <SettingsRow
            label="启用 TUN"
            description="创建虚拟网络设备进行透明代理"
            help="【接入方式 B】创建虚拟网卡 + 改路由表，内核层拦截整机 TCP/UDP。✓ 覆盖：所有流量，包括游戏 / IM / UDP。✓ 最彻底。✗ 需要管理员权限；与部分 VPN 客户端冲突。与系统代理通常二选一；也可同时开以防有应用绕过系统代理。"
          >
            <ToggleSwitch
              enabled={tunConfig.enabled}
              onChange={(v) => updateTunConfig('enabled', v)}
              label="启用 TUN"
            />
          </SettingsRow>

          <SettingsRow
            label="网络栈"
            description="TUN 设备使用的网络栈实现"
            help="gVisor：纯用户态，兼容性好（推荐）；System：系统栈，性能最好；Mixed：混合模式。"
          >
            <Select<TunStack>
              value={tunConfig.stack ?? 'gvisor'}
              options={TUN_STACK_OPTIONS}
              onChange={(v) => updateTunConfig('stack', v)}
              disabled={!tunConfig.enabled}
              className="w-36"
            />
          </SettingsRow>

          <SettingsRow
            label="自动路由"
            description="自动配置系统路由表"
            help="开启后自动把系统默认路由指向 TUN 设备。关闭则需要手动配置路由。"
          >
            <ToggleSwitch
              enabled={tunConfig.autoRoute ?? true}
              onChange={(v) => updateTunConfig('autoRoute', v)}
              disabled={!tunConfig.enabled}
              label="自动路由"
            />
          </SettingsRow>

          <SettingsRow
            label="自动检测接口"
            description="自动检测默认网络出口"
            help="自动识别当前物理网卡作为出口接口，适配有线/无线切换场景。"
          >
            <ToggleSwitch
              enabled={tunConfig.autoDetectInterface ?? true}
              onChange={(v) => updateTunConfig('autoDetectInterface', v)}
              disabled={!tunConfig.enabled}
              label="自动检测接口"
            />
          </SettingsRow>
        </SettingsSection></div>

        {/* ── Mixin ──────────────────────────────────────────────── */}
        <div id="mixin"><SettingsSection
          icon={<Server size={16} />}
          title="Mixin"
          description="用户自定义 YAML 片段，合并到最终引擎配置"
        >
          <SettingsRow
            label="启用 Mixin"
            description="下次启动引擎时，将 YAML 深度合并到生成的配置"
            help="【配置覆盖机制，不是接入方式】Mixin 跟系统代理 / TUN 不在同一维度 —— 系统代理 / TUN 决定「流量怎么进 Kite」；Mixin 决定「进来后按什么配置走」。关掉这个开关，即使 Mixin 里写了内容也不会生效。"
          >
            <ToggleSwitch
              enabled={config.mixin?.enabled ?? false}
              onChange={(v) => updateMixin('enabled', v)}
              label="启用 Mixin"
            />
          </SettingsRow>

          <SettingsRow
            label="Mixin 内容"
            description={
              (config.mixin?.content?.trim().length ?? 0) > 0
                ? `已配置 ${config.mixin?.content.split('\n').length ?? 0} 行 YAML`
                : '尚未配置 — 点右侧按钮去规则页编辑'
            }
            help="Mixin 的 YAML 编辑已统一放在「规则」页，避免多处编辑产生冲突。"
          >
            <button
              type="button"
              onClick={() => navigate('/rules')}
              className="btn-secondary text-xs py-1.5 px-3 inline-flex items-center gap-1.5"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span>去规则页编辑</span>
            </button>
          </SettingsRow>
        </SettingsSection></div>

        {/* ── About ───────────────────────────────────────────────── */}
        <div id="about"><SettingsSection
          icon={<Info size={16} />}
          title="关于"
          description="应用信息与更新"
        >
          <SettingsRow
            label="应用版本"
            description="当前安装的 Kite 版本"
            help="Kite 前端 UI 与桌面壳的版本号，来自 package.json。"
          >
            <span className="text-sm font-mono text-gray-700 dark:text-gray-300">
              v{APP_VERSION}
            </span>
          </SettingsRow>

          <SettingsRow
            label="引擎版本"
            description="mihomo 内核版本"
            help="底层代理引擎 mihomo (Clash.Meta) 的版本号。"
          >
            <span className="text-sm font-mono text-gray-700 dark:text-gray-300">
              v1.18.0
            </span>
          </SettingsRow>

          <SettingsRow
            label="检查更新"
            description="检查是否有可用的新版本"
            help="从 GitHub Releases 查询最新版本。开发环境下更新机制不可用。"
          >
            <button
              type="button"
              className="btn-secondary text-xs py-1.5 px-3"
              onClick={() => {
                void (async () => {
                  if (!isTauriRuntime()) {
                    toast('开发环境下更新机制不可用；打包后可正常使用。', 'info')
                    return
                  }
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
                  } catch (e) {
                    const msg = String(e)
                    if (msg.includes('not yet implemented') || msg.includes('not configured')) {
                      toast('开发环境下更新机制不可用', 'info')
                    } else {
                      toast('检查更新失败：' + msg, 'error')
                    }
                  }
                })()
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>检查更新</span>
            </button>
          </SettingsRow>

        </SettingsSection></div>

        {/* Bottom spacing */}
        <div className="h-4" />
        </div>
      </div>
    </div>
  )
}

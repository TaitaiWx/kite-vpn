/**
 * App — Main application shell with sidebar navigation, top bar with engine
 * status / mode toggle / traffic speed, and routed page content area.
 *
 * NO `any` types used anywhere.
 */

import { useState, useCallback, useEffect } from 'react'
import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  Globe,
  Link,
  ArrowRightLeft,
  ScrollText,
  Settings as SettingsIcon,
  Zap,
  ZapOff,
  ChevronLeft,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  Shield,
  ShieldOff,
} from 'lucide-react'
import { clsx } from 'clsx'

import { useEngineStore } from '@/stores/engine'
import { StatusBadge } from '@/components/StatusBadge'
import { ToastContainer } from '@/components/Toast'
import { SetupWizard } from '@/components/SetupWizard'
import { toast } from '@/stores/toast'
import { formatSpeed } from '@/lib/format'
import { startAutoRefresh } from '@/stores/subscription'
import { Tooltip } from '@/components/Tooltip'

import { Dashboard } from '@/pages/Dashboard'
import { Proxies } from '@/pages/Proxies'
import { Subscriptions } from '@/pages/Subscriptions'
import { Connections } from '@/pages/Connections'
import { Logs } from '@/pages/Logs'
import { Settings } from '@/pages/Settings'

import type { ProxyMode } from '@kite-vpn/types'

// ---------------------------------------------------------------------------
// Navigation items
// ---------------------------------------------------------------------------

interface NavItem {
  readonly path: string
  readonly label: string
  readonly icon: React.ReactNode
}

const NAV_ITEMS: readonly NavItem[] = [
  { path: '/dashboard', label: '仪表盘', icon: <LayoutDashboard size={18} /> },
  { path: '/proxies', label: '代理', icon: <Globe size={18} /> },
  { path: '/subscriptions', label: '订阅', icon: <Link size={18} /> },
  { path: '/connections', label: '连接', icon: <ArrowRightLeft size={18} /> },
  { path: '/logs', label: '日志', icon: <ScrollText size={18} /> },
  { path: '/settings', label: '设置', icon: <SettingsIcon size={18} /> },
] as const

// ---------------------------------------------------------------------------
// Mode button visual map
// ---------------------------------------------------------------------------

interface ModeVisual {
  readonly label: string
  readonly shortLabel: string
  readonly color: string
  readonly activeColor: string
}

const MODE_VISUALS: Record<ProxyMode, ModeVisual> = {
  rule: {
    label: '规则模式',
    shortLabel: '规则',
    color: 'text-gray-500 dark:text-gray-400 hover:text-primary-500 dark:hover:text-primary-400',
    activeColor: 'text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-500/10',
  },
  global: {
    label: '全局代理',
    shortLabel: '全局',
    color: 'text-gray-500 dark:text-gray-400 hover:text-amber-500 dark:hover:text-amber-400',
    activeColor: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10',
  },
  direct: {
    label: '直连模式',
    shortLabel: '直连',
    color: 'text-gray-500 dark:text-gray-400 hover:text-emerald-500 dark:hover:text-emerald-400',
    activeColor: 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10',
  },
} as const

const MODE_ORDER: readonly ProxyMode[] = ['rule', 'global', 'direct'] as const

// ---------------------------------------------------------------------------
// App component
// ---------------------------------------------------------------------------

export default function App() {
  const [collapsed, setCollapsed] = useState(false)
  const [showSetup, setShowSetup] = useState(false)
  const [setupChecked, setSetupChecked] = useState(false)
  const location = useLocation()

  const engineState = useEngineStore((s) => s.state)
  const traffic = useEngineStore((s) => s.traffic)
  const mode = useEngineStore((s) => s.mode)
  const systemProxy = useEngineStore((s) => s.systemProxy)
  const changeMode = useEngineStore((s) => s.changeMode)
  const toggleProxy = useEngineStore((s) => s.toggleSystemProxy)
  const fetchState = useEngineStore((s) => s.fetchState)
  const fetchProxyStatus = useEngineStore((s) => s.fetchSystemProxyStatus)
  const startEngine = useEngineStore((s) => s.startEngine)
  const stopEngine = useEngineStore((s) => s.stopEngine)

  const isRunning = engineState.status === 'running'
  const isTransitioning = engineState.status === 'starting' || engineState.status === 'stopping'

  useEffect(() => {
    void fetchState()
    void fetchProxyStatus()
    startAutoRefresh()
  }, [fetchState, fetchProxyStatus])

  // 首次启动检测：未完成过设置 + 引擎未运行 → 显示引导
  useEffect(() => {
    const timer = setTimeout(() => {
      const setupDone = localStorage.getItem('kite_setup_done')
      const state = useEngineStore.getState().state
      if (!setupDone && state.status !== 'running') {
        setShowSetup(true)
      }
      setSetupChecked(true)
    }, 500)
    return () => clearTimeout(timer)
  }, [])

  const handleModeChange = useCallback(
    (newMode: ProxyMode) => {
      void changeMode(newMode)
    },
    [changeMode],
  )

  const toggleSystemProxy = useCallback(() => {
    void (async () => {
      try {
        await toggleProxy()
      } catch {
        toast('系统代理切换失败', 'error')
      }
    })()
  }, [toggleProxy])

  const handleEngineToggle = useCallback(() => {
    void (async () => {
      try {
        if (isRunning) {
          await stopEngine()
          toast('引擎已停止', 'info')
        } else {
          await startEngine()
          const state = useEngineStore.getState().state
          if (state.status === 'error') {
            toast(state.error ?? '引擎启动失败', 'error')
          } else {
            toast('引擎已启动', 'success')
          }
        }
      } catch {
        toast('引擎操作失败', 'error')
      }
    })()
  }, [isRunning, startEngine, stopEngine])

  const toggleSidebar = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  // 全局键盘快捷键: Cmd/Ctrl+E 启停引擎, Cmd/Ctrl+1/2/3 切换模式
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key === 'e') { e.preventDefault(); handleEngineToggle() }
      if (meta && e.key === '1') { e.preventDefault(); handleModeChange('rule') }
      if (meta && e.key === '2') { e.preventDefault(); handleModeChange('global') }
      if (meta && e.key === '3') { e.preventDefault(); handleModeChange('direct') }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleEngineToggle, handleModeChange])

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-surface-0">
      <ToastContainer />
      {showSetup && <SetupWizard onComplete={() => setShowSetup(false)} />}

      {/* ── 标题栏：全宽拖拽区（data-tauri-drag-region 是 Tauri 官方拖拽属性） ── */}
      <div data-tauri-drag-region className="titlebar-drag flex items-center h-[40px] bg-surface-1 border-b border-border flex-shrink-0 px-4">
        {/* 左侧：macOS 红绿灯占位 + Logo */}
        <div className="flex items-center gap-2 pl-[60px]">
          <div className="flex items-center justify-center h-5 w-5 rounded bg-gradient-to-br from-cyan-400 to-teal-500">
            <Zap className="h-3 w-3 text-white" />
          </div>
          <span className="text-[12px] font-semibold text-gray-500 dark:text-gray-400">Kite</span>
        </div>

        {/* 中间空白（可拖拽） */}
        <div data-tauri-drag-region className="flex-1 h-full" />

        {/* 右侧控件（不可拖拽） */}
        <div className="titlebar-no-drag flex items-center gap-2">
          <StatusBadge status={engineState.status} size="sm" />

          <button type="button" onClick={handleEngineToggle} disabled={isTransitioning}
            aria-label={isRunning ? '停止代理引擎' : '启动代理引擎'}
            className={clsx(
              'flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-all',
              isRunning ? 'bg-red-500/10 text-red-500' : 'bg-emerald-500/10 text-emerald-500',
              isTransitioning && 'opacity-40',
            )}
          >
            {isRunning ? <ZapOff className="h-3 w-3" /> : <Zap className="h-3 w-3" />}
            <span>{isTransitioning ? '…' : isRunning ? '停止' : '启动'}</span>
          </button>

          <div className="w-px h-4 bg-border mx-0.5" />

          <div className="flex items-center bg-surface-2 rounded-lg p-[3px]">
            {MODE_ORDER.map((m) => {
              const visual = MODE_VISUALS[m]
              const isActive = mode === m
              return (
                <button key={m} type="button" onClick={() => handleModeChange(m)}
                  className={clsx(
                    'px-2.5 py-1 rounded-md text-[11px] font-medium transition-all duration-150',
                    isActive
                      ? 'bg-primary-600 text-white shadow-sm'
                      : 'text-gray-400 hover:text-gray-300',
                  )}
                  title={visual.label}
                  aria-label={visual.label}
                >{visual.shortLabel}</button>
              )
            })}
          </div>

          {isRunning && (
            <>
              <div className="w-px h-4 bg-border mx-0.5" />
              <div className="flex items-center gap-2 text-[11px] font-mono">
                <span className="text-emerald-500 flex items-center gap-0.5">
                  <ArrowUp className="h-2.5 w-2.5" />{formatSpeed(traffic.uploadSpeed)}
                </span>
                <span className="text-cyan-500 flex items-center gap-0.5">
                  <ArrowDown className="h-2.5 w-2.5" />{formatSpeed(traffic.downloadSpeed)}
                </span>
              </div>
            </>
          )}

          <div className="w-px h-4 bg-border mx-0.5" />

          <button type="button" onClick={toggleSystemProxy}
            aria-label={systemProxy ? '关闭系统代理' : '开启系统代理'}
            className={clsx(
              'flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-all',
              systemProxy ? 'bg-emerald-500/10 text-emerald-500' : 'text-gray-400',
            )}
          >
            {systemProxy ? <Shield className="h-3 w-3" /> : <ShieldOff className="h-3 w-3" />}
            <span>{systemProxy ? '代理' : '直连'}</span>
          </button>
        </div>
      </div>

      {/* ── 主体 ── */}
      <div className="flex flex-1 min-h-0">
        {/* ── 侧栏 ── */}
        <div className="relative flex-shrink-0">
          <aside className={clsx(
            'flex flex-col h-full border-r border-border bg-surface-1 transition-all duration-200',
            collapsed ? 'w-[48px]' : 'w-[168px]',
          )}>
          <nav className="flex-1 px-1.5 pt-2 space-y-0.5 overflow-y-auto">
            {NAV_ITEMS.map((item) => {
              const isActive = location.pathname === item.path || location.pathname.startsWith(item.path + '/')
              const link = (
                <NavLink key={item.path} to={item.path}
                  className={clsx('nav-item', isActive && 'nav-item-active', collapsed && 'justify-center px-0')}
                >
                  <span className="flex-shrink-0">{item.icon}</span>
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </NavLink>
              )
              return collapsed ? <Tooltip key={item.path} text={item.label}>{link}</Tooltip> : link
            })}
          </nav>
        </aside>

          {/* 折叠按钮（侧栏右边缘垂直居中） */}
          <button type="button" onClick={toggleSidebar}
            title={collapsed ? '展开侧栏' : '收起侧栏'}
            className={clsx(
              'absolute top-1/2 -translate-y-1/2 z-10',
              'flex items-center justify-center',
              'w-4 h-8 rounded-r-md',
              'bg-surface-2 hover:bg-surface-3 border border-l-0 border-border',
              'text-gray-400 hover:text-gray-200 transition-all',
              collapsed ? 'left-[48px]' : 'left-[168px]',
            )}
          >
            {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
          </button>
        </div>

        {/* ── 内容区 ── */}
        <div className="flex-1 flex flex-col min-w-0">

          {/* ── 页面 ── */}
          <main className="flex-1 min-h-0 overflow-hidden">
            <div className="h-full overflow-y-auto">
              <Routes>
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/proxies" element={<Proxies />} />
                <Route path="/subscriptions" element={<Subscriptions />} />
                <Route path="/connections" element={<Connections />} />
                <Route path="/logs" element={<Logs />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Routes>
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}
